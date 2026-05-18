const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const querystring = require("querystring");

const rootDir = __dirname;
loadEnv(path.join(rootDir, ".env"));

const mirrorRoot = path.join(rootDir, "gsheets-template-list");
const siteRoot = path.join(mirrorRoot, "gsheets.vn");
const publicRoot = path.join(rootDir, "public");
const dataDir = process.env.VERCEL
  ? path.join(process.env.TMPDIR || "/tmp", "gsheets-sepay-checkout")
  : path.join(rootDir, "data");
const dbPath = path.join(dataDir, "db.json");

const config = {
  port: numberEnv("PORT", 3000),
  publicBaseUrl: env("PUBLIC_BASE_URL", "http://localhost:3000").replace(/\/+$/, ""),
  databaseMode: env("DATABASE_MODE", "auto").toLowerCase(),
  supabaseUrl: normalizeSupabaseUrl(env("SUPABASE_URL", "")),
  supabaseServiceRoleKey: env("SUPABASE_SERVICE_ROLE_KEY", ""),
  bankCode: env("SEPAY_BANK_CODE", "Vietcombank"),
  accountNumber: env("SEPAY_ACCOUNT_NUMBER", ""),
  accountName: env("SEPAY_ACCOUNT_NAME", ""),
  codePrefix: env("PAYMENT_CODE_PREFIX", "GS").toUpperCase().replace(/[^A-Z0-9]/g, "") || "GS",
  orderExpireMinutes: numberEnv("ORDER_EXPIRE_MINUTES", 15),
  allowOverpay: boolEnv("ALLOW_OVERPAY", true),
  demoPaymentEnabled: boolEnv("DEMO_PAYMENT_ENABLED", false),
  authMode: resolveAuthMode(),
  apiKey: env("SEPAY_API_KEY", ""),
  webhookSecret: env("SEPAY_WEBHOOK_SECRET", ""),
  adminToken: env("ADMIN_TOKEN", "")
};

const catalog = loadCatalog();
const storage = createStorage();
let db = { orders: [], transactions: [] };
let dbReady = storage.load().then((loaded) => {
  db = loaded;
  return db;
});

async function handleRequest(req, res) {
  try {
    const requestUrl = new URL(req.url, config.publicBaseUrl);
    const pathname = decodeURIComponent(requestUrl.pathname);

    if (pathname === "/") return redirect(res, "/template/");

    if (pathname === "/api/catalog" && req.method === "GET") {
      return sendJson(res, 200, { products: catalog });
    }

    if (pathname === "/api/config" && req.method === "GET") {
      return sendJson(res, 200, { demoPaymentEnabled: config.demoPaymentEnabled });
    }

    if (!pathname.startsWith("/api/")) {
      return serveFile(pathname, res);
    }

    await refreshDbForRequest();

    if (pathname === "/api/orders" && req.method === "POST") {
      return handleCreateOrder(req, res);
    }

    const orderMatch = pathname.match(/^\/api\/orders\/([A-Z0-9_-]+)$/i);
    if (orderMatch && req.method === "GET") {
      return handleGetOrder(orderMatch[1], res);
    }

    if (pathname === "/api/sepay/webhook" && req.method === "POST") {
      return handleSePayWebhook(req, res);
    }

    if (pathname === "/api/activate" && req.method === "POST") {
      return handleActivate(req, res);
    }

    if (pathname === "/api/admin/orders" && req.method === "GET") {
      return handleAdminOrders(req, res, requestUrl);
    }

    if (pathname === "/api/test/mark-paid" && req.method === "POST") {
      return handleTestMarkPaid(req, res);
    }

    return sendText(res, 404, "Not found");
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: "internal_error", message: "Server error" });
  }
}

const server = http.createServer(handleRequest);

if (require.main === module) {
  initialize().catch((error) => {
    console.error("Cannot start server", error);
    process.exit(1);
  });
}

async function initialize() {
  await dbReady;
  server.listen(config.port, () => {
    console.log(`SePay checkout server running at ${config.publicBaseUrl}`);
    console.log(`Template page: ${config.publicBaseUrl}/template/`);
    console.log(`Webhook URL: ${config.publicBaseUrl}/api/sepay/webhook`);
    console.log(`Database: ${storage.name}`);
    if (config.authMode === "none") {
      console.warn("Webhook auth mode is none. Use HMAC or API Key before production.");
    }
  });
}

async function refreshDbForRequest() {
  await dbReady;
  if (storage.name === "supabase") {
    db = await storage.load();
  }
}

function handleCreateOrder(req, res) {
  readRequestBody(req, async (error, rawBody) => {
    if (error) return sendJson(res, 400, { error: "bad_body" });
    const body = parseBody(req, rawBody);
    const product = catalog.find((item) => item.id === String(body.productId || ""));
    if (!product || !product.price) {
      return sendJson(res, 422, { error: "invalid_product", message: "San pham khong hop le" });
    }

    const customerEmail = String(body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
      return sendJson(res, 422, { error: "invalid_email", message: "Email khong hop le" });
    }

    const now = new Date();
    const code = generatePaymentCode();
    const expiresAt = new Date(now.getTime() + config.orderExpireMinutes * 60 * 1000).toISOString();
    const activationToken = crypto.randomBytes(32).toString("hex");

    const order = {
      code,
      productId: product.id,
      productTitle: product.title,
      productUrl: product.url,
      amount: product.price,
      customerName: String(body.name || "").trim(),
      customerEmail,
      customerPhone: String(body.phone || "").trim(),
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt,
      paidAt: null,
      activatedAt: null,
      activationToken,
      activationCode: null,
      transactionId: null,
      note: null
    };

    db.orders.push(order);
    await saveDb();

    sendJson(res, 201, { order: toPublicOrder(order, true) });
  });
}

async function handleGetOrder(code, res) {
  const order = findOrder(code);
  if (!order) return sendJson(res, 404, { error: "not_found" });
  expireOrderIfNeeded(order);
  await saveDb();
  sendJson(res, 200, { order: toPublicOrder(order, true) });
}

function handleSePayWebhook(req, res) {
  readRequestBody(req, async (error, rawBody) => {
    if (error) return sendJson(res, 400, { success: false, message: "Bad body" });

    const auth = verifySePayRequest(req, rawBody);
    if (!auth.ok) {
      await logWebhook(null, "rejected_auth", rawBody, auth.message);
      return sendJson(res, 401, { success: false, message: auth.message });
    }

    const payload = parseBody(req, rawBody);
    const transactionId = String(payload.id || payload.referenceCode || "").trim();
    if (!transactionId) {
      await logWebhook(null, "ignored_missing_transaction_id", rawBody, "Missing id/referenceCode");
      return sendJson(res, 200, { success: true });
    }

    if (db.transactions.some((tx) => tx.transactionId === transactionId)) {
      return sendJson(res, 200, { success: true });
    }

    const transaction = {
      transactionId,
      receivedAt: new Date().toISOString(),
      status: "received",
      payload,
      rawBody: rawBody.toString("utf8")
    };
    db.transactions.push(transaction);

    const transferType = String(payload.transferType || "").toLowerCase();
    if (transferType && transferType !== "in") {
      transaction.status = "ignored_not_incoming";
      await saveDb();
      return sendJson(res, 200, { success: true });
    }

    const code = extractPaymentCode(payload);
    const order = code ? findOrder(code) : null;
    if (!order) {
      transaction.status = "ignored_no_order";
      transaction.note = code ? `Order not found: ${code}` : "Payment code not found";
      await saveDb();
      return sendJson(res, 200, { success: true });
    }

    const amount = Number(payload.transferAmount || 0);
    const amountOk = config.allowOverpay ? amount >= order.amount : amount === order.amount;
    if (!amountOk) {
      transaction.status = "ignored_amount_mismatch";
      transaction.orderCode = order.code;
      transaction.note = `Expected ${order.amount}, got ${amount}`;
      order.note = "Giao dich khong dung so tien";
      await saveDb();
      return sendJson(res, 200, { success: true });
    }

    if (order.status !== "paid" && order.status !== "activated") {
      order.status = "paid";
      order.paidAt = new Date().toISOString();
      order.transactionId = transactionId;
      order.activationCode = generateActivationCode(order);
      order.note = null;
    }

    transaction.status = "matched";
    transaction.orderCode = order.code;
    await saveDb();
    return sendJson(res, 200, { success: true });
  });
}

function handleActivate(req, res) {
  readRequestBody(req, async (error, rawBody) => {
    if (error) return sendJson(res, 400, { error: "bad_body" });
    const body = parseBody(req, rawBody);
    const token = String(body.token || "").trim();
    const order = db.orders.find((item) => item.activationToken === token);

    if (!order || order.status === "pending" || order.status === "expired") {
      return sendJson(res, 404, { error: "not_found", message: "Link kich hoat khong hop le" });
    }

    if (!order.activatedAt) {
      order.activatedAt = new Date().toISOString();
      order.status = "activated";
      await saveDb();
    }

    sendJson(res, 200, {
      activation: {
        status: order.status,
        code: order.activationCode,
        productTitle: order.productTitle,
        customerEmail: order.customerEmail,
        activatedAt: order.activatedAt
      }
    });
  });
}

function handleAdminOrders(req, res, requestUrl) {
  if (!isAdminAuthorized(req, requestUrl)) {
    return sendJson(res, 401, { error: "unauthorized" });
  }
  const orders = db.orders
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((order) => toPublicOrder(order, false));
  sendJson(res, 200, { orders, transactions: db.transactions.length });
}

function handleTestMarkPaid(req, res) {
  readRequestBody(req, async (error, rawBody) => {
    if (error) return sendJson(res, 400, { error: "bad_body" });
    const body = parseBody(req, rawBody);
    const isAdmin = String(body.adminToken || "") === config.adminToken && Boolean(config.adminToken);
    const isDemo = config.demoPaymentEnabled && body.demo === true;
    if (!isAdmin && !isDemo) {
      return sendJson(res, 401, { error: "unauthorized" });
    }
    const order = findOrder(body.code);
    if (!order) return sendJson(res, 404, { error: "not_found" });

    const fakePayload = {
      id: `TEST-${Date.now()}`,
      gateway: "TEST",
      transactionDate: new Date().toISOString(),
      accountNumber: config.accountNumber,
      code: order.code,
      content: `${order.code} test payment`,
      transferType: "in",
      transferAmount: order.amount,
      referenceCode: `TEST-${crypto.randomBytes(4).toString("hex")}`
    };

    db.transactions.push({
      transactionId: fakePayload.id,
      receivedAt: new Date().toISOString(),
      status: "matched_test",
      payload: fakePayload,
      orderCode: order.code,
      rawBody: JSON.stringify(fakePayload)
    });
    order.status = "paid";
    order.paidAt = new Date().toISOString();
    order.transactionId = fakePayload.id;
    order.activationCode = generateActivationCode(order);
    await saveDb();
    sendJson(res, 200, { order: toPublicOrder(order, true) });
  });
}

function toPublicOrder(order, includeActivationWhenPaid) {
  const publicOrder = {
    code: order.code,
    productId: order.productId,
    productTitle: order.productTitle,
    productUrl: order.productUrl,
    amount: order.amount,
    amountText: formatVnd(order.amount),
    customerEmail: order.customerEmail,
    status: order.status,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
    activatedAt: order.activatedAt,
    bankCode: config.bankCode,
    accountNumber: config.accountNumber,
    accountName: config.accountName,
    transferContent: order.code,
    qrUrl: buildQrUrl(order),
    checkoutUrl: `${config.publicBaseUrl}/checkout.html?code=${encodeURIComponent(order.code)}`
  };

  if (includeActivationWhenPaid && (order.status === "paid" || order.status === "activated")) {
    publicOrder.activationUrl = `${config.publicBaseUrl}/activate.html?token=${order.activationToken}`;
    publicOrder.activationCode = order.activationCode;
  }
  return publicOrder;
}

function buildQrUrl(order) {
  const params = new URLSearchParams({
    acc: config.accountNumber,
    bank: config.bankCode,
    amount: String(order.amount),
    des: order.code
  });
  return `https://qr.sepay.vn/img?${params.toString()}`;
}

function verifySePayRequest(req, rawBody) {
  if (config.authMode === "none") return { ok: true };

  if (config.authMode === "apikey") {
    const auth = String(req.headers.authorization || "");
    const expected = `Apikey ${config.apiKey}`;
    return timingSafeEqual(auth, expected)
      ? { ok: true }
      : { ok: false, message: "Unauthorized" };
  }

  if (config.authMode === "hmac") {
    const signature = String(req.headers["x-sepay-signature"] || "");
    const timestamp = String(req.headers["x-sepay-timestamp"] || "");
    const ts = Number(timestamp);
    if (!ts || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
      return { ok: false, message: "Request expired" };
    }
    const expected = "sha256=" + crypto
      .createHmac("sha256", config.webhookSecret)
      .update(`${timestamp}.${rawBody.toString("utf8")}`)
      .digest("hex");
    return timingSafeEqual(signature, expected)
      ? { ok: true }
      : { ok: false, message: "Invalid signature" };
  }

  return { ok: false, message: "Invalid auth mode" };
}

function extractPaymentCode(payload) {
  const direct = String(payload.code || "").trim().toUpperCase();
  if (direct) return direct;
  const content = String(payload.content || payload.description || "").toUpperCase();
  const escapedPrefix = config.codePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`\\b(${escapedPrefix}[A-Z0-9]{6,24})\\b`));
  return match ? match[1] : null;
}

function findOrder(code) {
  const normalized = String(code || "").trim().toUpperCase();
  return db.orders.find((order) => order.code === normalized);
}

function expireOrderIfNeeded(order) {
  if (order.status !== "pending") return;
  if (new Date(order.expiresAt).getTime() < Date.now()) {
    order.status = "expired";
  }
}

function generatePaymentCode() {
  let code;
  do {
    code = `${config.codePrefix}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  } while (findOrder(code));
  return code;
}

function generateActivationCode(order) {
  if (order.activationCode) return order.activationCode;
  return `ACT-${crypto.createHash("sha256").update(order.code + order.activationToken).digest("hex").slice(0, 12).toUpperCase()}`;
}

async function logWebhook(transactionId, status, rawBody, note) {
  db.transactions.push({
    transactionId: transactionId || `LOG-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    receivedAt: new Date().toISOString(),
    status,
    note,
    rawBody: rawBody ? rawBody.toString("utf8") : ""
  });
  await saveDb();
}

function loadCatalog() {
  const pages = [path.join(siteRoot, "template", "index.html")];
  if (!fs.existsSync(pages[0])) {
    console.warn(`Catalog source not found: ${pages[0]}`);
    return [];
  }
  for (let page = 2; page <= 30; page += 1) {
    const file = path.join(siteRoot, "template", "page", String(page), "index.html");
    if (fs.existsSync(file)) pages.push(file);
  }

  const products = new Map();
  for (const page of pages) {
    const html = fs.readFileSync(page, "utf8");
    const starts = [...html.matchAll(/<div class="product-small col\b[^"]*\bpost-(\d+)\b[\s\S]*?(?=<div class="product-small col\b|<div class="container|\<\/main\>)/g)];
    for (const match of starts) {
      const block = match[0];
      const id = match[1];
      const titleMatch = block.match(/product-title[\s\S]*?<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const priceMatch = block.match(/<bdi>([\s\S]*?)<\/bdi>/i);
      const imageMatch = block.match(/<img[^>]+src="([^"]+)"/i);
      if (!titleMatch || !priceMatch) continue;

      const title = decodeHtml(stripTags(titleMatch[2])).trim();
      const price = parsePrice(stripTags(priceMatch[1]));
      if (!title || !price) continue;

      products.set(id, {
        id,
        title,
        price,
        amountText: formatVnd(price),
        url: titleMatch[1],
        image: imageMatch ? imageMatch[1] : ""
      });
    }
  }

  return Array.from(products.values()).sort((a, b) => Number(a.id) - Number(b.id));
}

function serveFile(pathname, res) {
  const publicFile = mapPublicPath(pathname);
  if (publicFile) return sendFile(publicFile, res, false);

  const mirrorFile = mapMirrorPath(pathname);
  if (!mirrorFile) return sendText(res, 404, "Not found");

  return sendFile(mirrorFile, res, pathname.endsWith(".html") || pathname.endsWith("/") || path.extname(mirrorFile) === ".html");
}

function mapPublicPath(pathname) {
  const clean = pathname === "/checkout" ? "/checkout.html" : pathname === "/activate" ? "/activate.html" : pathname;
  if (!clean.startsWith("/assets/") && !["/checkout.html", "/activate.html", "/admin.html"].includes(clean)) return null;
  const target = path.resolve(publicRoot, clean.replace(/^\/+/, ""));
  return isInside(publicRoot, target) ? target : null;
}

function mapMirrorPath(pathname) {
  let relative;
  if (pathname === "/template" || pathname === "/template/") {
    relative = path.join("gsheets.vn", "template", "index.html");
  } else if (pathname.startsWith("/template/") || pathname.startsWith("/wp-content/") || pathname.startsWith("/wp-includes/")) {
    relative = path.join("gsheets.vn", pathname.replace(/^\/+/, ""));
  } else if (pathname.startsWith("/cdnjs.cloudflare.com/") || pathname.startsWith("/fonts.googleapis.com/") || pathname.startsWith("/fonts.gstatic.com/")) {
    relative = pathname.replace(/^\/+/, "");
  } else {
    return null;
  }

  let target = path.resolve(mirrorRoot, relative);
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = path.join(target, "index.html");
  }
  if (!path.extname(target) && fs.existsSync(`${target}.html`)) {
    target = `${target}.html`;
  }
  return isInside(mirrorRoot, target) ? target : null;
}

function sendFile(filePath, res, injectCheckout) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendText(res, 404, "Not found");
  }

  const ext = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", mimeType(ext));
  if (injectCheckout && ext === ".html") {
    let html = fs.readFileSync(filePath, "utf8");
    if (!html.includes("/assets/sepay-store.js")) {
      const injection = [
        '<link rel="stylesheet" href="/assets/sepay-checkout.css">',
        '<script defer src="/assets/sepay-store.js"></script>'
      ].join("\n");
      html = html.replace(/<\/body>/i, `${injection}\n</body>`);
    }
    res.writeHead(200);
    res.end(html);
    return;
  }

  res.writeHead(200);
  fs.createReadStream(filePath).pipe(res);
}

function readRequestBody(req, callback) {
  const chunks = [];
  let total = 0;
  req.on("data", (chunk) => {
    total += chunk.length;
    if (total > 1024 * 1024) {
      req.destroy();
      callback(new Error("body_too_large"));
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => callback(null, Buffer.concat(chunks)));
  req.on("error", callback);
}

function parseBody(req, rawBody) {
  const type = String(req.headers["content-type"] || "").toLowerCase();
  const text = rawBody.toString("utf8");
  if (!text) return {};
  if (type.includes("application/x-www-form-urlencoded")) return querystring.parse(text);
  if (type.includes("multipart/form-data")) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function createStorage() {
  if (config.supabaseServiceRoleKey.startsWith("sb_publishable_")) {
    const message = "SUPABASE_SERVICE_ROLE_KEY is a publishable key. Use the Supabase service_role secret key on the server.";
    if (config.databaseMode === "supabase") throw new Error(message);
    console.warn(`${message} Falling back to local JSON.`);
    return createLocalStorage();
  }

  const canUseSupabase = Boolean(config.supabaseUrl && config.supabaseServiceRoleKey);
  if (canUseSupabase && config.databaseMode !== "local") {
    return createSupabaseStorage();
  }
  if (config.databaseMode === "supabase") {
    throw new Error("DATABASE_MODE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  return createLocalStorage();
}

function createLocalStorage() {
  return {
    name: "local-json",
    async load() {
      return loadLocalDb();
    },
    async save(nextDb) {
      saveLocalDb(nextDb);
    }
  };
}

function createSupabaseStorage() {
  const restBase = `${config.supabaseUrl}/rest/v1`;
  const headers = {
    apikey: config.supabaseServiceRoleKey,
    Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
    "Content-Type": "application/json"
  };

  async function request(table, options = {}) {
    const response = await fetch(`${restBase}/${table}${options.query || ""}`, {
      method: options.method || "GET",
      headers: {
        ...headers,
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(`Supabase ${table} ${response.status}: ${text}`);
    }
    return data;
  }

  return {
    name: "supabase",
    async load() {
      try {
        const [orders, transactions] = await Promise.all([
          request("orders", { query: "?select=*&order=created_at.asc" }),
          request("transactions", { query: "?select=*&order=received_at.asc" })
        ]);
        const nextDb = {
          orders: orders.map(orderFromRow),
          transactions: transactions.map(transactionFromRow)
        };
        saveLocalDb(nextDb);
        return nextDb;
      } catch (error) {
        if (config.databaseMode === "supabase") throw error;
        console.warn(`Supabase load failed, using local cache: ${error.message}`);
        return loadLocalDb();
      }
    },
    async save(nextDb) {
      saveLocalDb(nextDb);
      try {
        if (nextDb.orders.length) {
          await request("orders", {
            method: "POST",
            query: "?on_conflict=code",
            headers: { Prefer: "resolution=merge-duplicates" },
            body: nextDb.orders.map(orderToRow)
          });
        }
        if (nextDb.transactions.length) {
          await request("transactions", {
            method: "POST",
            query: "?on_conflict=transaction_id",
            headers: { Prefer: "resolution=merge-duplicates" },
            body: nextDb.transactions.map(transactionToRow)
          });
        }
      } catch (error) {
        if (config.databaseMode === "supabase") throw error;
        console.warn(`Supabase save failed, kept local cache: ${error.message}`);
      }
    }
  };
}

function orderToRow(order) {
  return {
    code: order.code,
    product_id: order.productId,
    product_title: order.productTitle,
    product_url: order.productUrl,
    amount: order.amount,
    customer_name: order.customerName,
    customer_email: order.customerEmail,
    customer_phone: order.customerPhone,
    status: order.status,
    created_at: order.createdAt,
    expires_at: order.expiresAt,
    paid_at: order.paidAt,
    activated_at: order.activatedAt,
    activation_token: order.activationToken,
    activation_code: order.activationCode,
    transaction_id: order.transactionId,
    note: order.note
  };
}

function orderFromRow(row) {
  return {
    code: row.code,
    productId: row.product_id,
    productTitle: row.product_title,
    productUrl: row.product_url,
    amount: row.amount,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    activatedAt: row.activated_at,
    activationToken: row.activation_token,
    activationCode: row.activation_code,
    transactionId: row.transaction_id,
    note: row.note
  };
}

function transactionToRow(transaction) {
  return {
    transaction_id: transaction.transactionId,
    received_at: transaction.receivedAt,
    status: transaction.status,
    order_code: transaction.orderCode || null,
    note: transaction.note || null,
    payload: transaction.payload || null,
    raw_body: transaction.rawBody || null
  };
}

function transactionFromRow(row) {
  return {
    transactionId: row.transaction_id,
    receivedAt: row.received_at,
    status: row.status,
    orderCode: row.order_code,
    note: row.note,
    payload: row.payload,
    rawBody: row.raw_body
  };
}

function loadLocalDb() {
  if (!fs.existsSync(dbPath)) return { orders: [], transactions: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    return {
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : []
    };
  } catch {
    return { orders: [], transactions: [] };
  }
}

async function saveDb() {
  await storage.save(db);
}

function saveLocalDb(nextDb) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${dbPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(nextDb, null, 2));
  fs.renameSync(tmp, dbPath);
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

function normalizeSupabaseUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/rest\/v1\/?$/i, "")
    .replace(/\/+$/, "");
}

function resolveAuthMode() {
  const explicit = env("SEPAY_AUTH_MODE", "").toLowerCase();
  if (["none", "apikey", "hmac"].includes(explicit)) return explicit;
  if (env("SEPAY_WEBHOOK_SECRET", "")) return "hmac";
  if (env("SEPAY_API_KEY", "")) return "apikey";
  return "none";
}

function env(key, fallback) {
  return process.env[key] || fallback;
}

function numberEnv(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boolEnv(key, fallback) {
  const value = String(process.env[key] || "").toLowerCase();
  if (["true", "1", "yes", "y"].includes(value)) return true;
  if (["false", "0", "no", "n"].includes(value)) return false;
  return fallback;
}

function isAdminAuthorized(req, requestUrl) {
  const token = requestUrl.searchParams.get("token") || req.headers["x-admin-token"];
  return Boolean(config.adminToken && token === config.adminToken);
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]*>/g, " ");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8363;/g, "d")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parsePrice(value) {
  const normalized = String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#8363;|₫/gi, " ")
    .replace(/<[^>]*>/g, " ");
  const match = normalized.match(/\d[\d.,\s]*/);
  const digits = match ? match[0].replace(/[^\d]/g, "") : "";
  return digits ? Number(digits) : 0;
}

function formatVnd(amount) {
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(amount);
}

function mimeType(ext) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".ico": "image/x-icon"
  }[ext] || "application/octet-stream";
}

module.exports = {
  handleRequest
};
