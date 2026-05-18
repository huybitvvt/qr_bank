# SePay VietQR Checkout

He thong nay boc ben ngoai ban clone tinh va them luong thanh toan tu dong:

1. Khach bam `Thanh toán QR` tren san pham.
2. Server tao don hang va ma chuyen khoan rieng, vi du `GS...`.
3. Trang checkout hien QR VietQR cua SePay voi so tien va noi dung da dien san.
4. SePay gui webhook ve `/api/sepay/webhook` khi tien vao tai khoan.
5. Server doi soat ma don, so tien, chong lap giao dich, roi mo link kich hoat.

## Chay local

```powershell
copy .env.example .env
notepad .env
node server.js
```

Mo:

```text
http://localhost:3000/template/
```

## Tao database Supabase

1. Tao project tren Supabase.
2. Vao `SQL Editor`.
3. Chay toan bo file `supabase-schema.sql`.
4. Vao `Project Settings > API`, lay:
   - `Project URL`
   - `service_role key`
5. Dien vao `.env`:

```text
DATABASE_MODE=supabase
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

Luu y: `sb_publishable_...` la publishable key, chi dung cho frontend/RLS public. Backend nay can `service_role key` de ghi don hang va giao dich qua REST API. Khong dua `service_role key` vao HTML hoac JavaScript frontend.

Khi co hai gia tri nay, server se luu don hang va giao dich vao bang:

- `orders`
- `transactions`

Neu `DATABASE_MODE=auto` va Supabase chua cau hinh, server se dung `data/db.json` de test local.

## Deploy len Vercel

Project da co san:

- `api/index.js`: entrypoint serverless cho Vercel.
- `vercel.json`: route tat ca request vao backend va bundle folder clone.
- `.vercelignore`: chan `.env`, log va cache HTTrack.

Tren Vercel, tao project tu GitHub repo va them Environment Variables:

```text
DATABASE_MODE=supabase
SUPABASE_URL=https://hpehjabohiyewfyxcszk.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-secret-key>
PUBLIC_BASE_URL=https://domain-vercel-cua-ban.vercel.app
SEPAY_BANK_CODE=Vietcombank
SEPAY_ACCOUNT_NUMBER=<so_tai_khoan_nhan_tien>
SEPAY_ACCOUNT_NAME=<ten_chu_tai_khoan>
PAYMENT_CODE_PREFIX=GS
ORDER_EXPIRE_MINUTES=15
ALLOW_OVERPAY=true
DEMO_PAYMENT_ENABLED=true
SEPAY_AUTH_MODE=hmac
SEPAY_WEBHOOK_SECRET=<secret-cau-hinh-tren-sepay>
ADMIN_TOKEN=<token-admin-rieng>
```

Sau deploy:

- Link test cho khach: `https://domain-vercel-cua-ban.vercel.app/template/`
- Link admin noi bo: `https://domain-vercel-cua-ban.vercel.app/admin.html?token=<ADMIN_TOKEN>`
- Webhook SePay: `https://domain-vercel-cua-ban.vercel.app/api/sepay/webhook`

Trong luc demo cho khach, co the de `DEMO_PAYMENT_ENABLED=true` de hien nut gia lap thanh toan tren trang QR. Khi chay that, doi ve `false` va de SePay webhook kich hoat don hang.

## Cau hinh can dien trong `.env`

```text
PUBLIC_BASE_URL=https://ten-domain-cua-ban.vn
DATABASE_MODE=supabase
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SEPAY_BANK_CODE=Vietcombank
SEPAY_ACCOUNT_NUMBER=so_tai_khoan_nhan_tien
SEPAY_ACCOUNT_NAME=ten_chu_tai_khoan
PAYMENT_CODE_PREFIX=GS
SEPAY_AUTH_MODE=hmac
SEPAY_WEBHOOK_SECRET=secret_da_cau_hinh_tren_SePay
ADMIN_TOKEN=token_quan_tri_rieng
```

Tren SePay:

- Cau hinh webhook URL: `https://ten-domain-cua-ban.vn/api/sepay/webhook`
- Su kien: `Có tiền vào`
- Bao mat: nen chon `HMAC-SHA256`
- Cau truc ma thanh toan: dat tien to trung voi `PAYMENT_CODE_PREFIX`, vi du `GS`

## Test khong can chuyen tien that

Sau khi tao don hang tren giao dien, lay ma don va goi:

```powershell
$body = @{
  code = "MA_DON_HANG"
  adminToken = "ADMIN_TOKEN_TRONG_ENV"
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri http://localhost:3000/api/test/mark-paid `
  -ContentType 'application/json' `
  -Body $body
```

Trang checkout se tu chuyen sang trang thai da thanh toan va hien link kich hoat.

## Luu y production

- Bat buoc dung HTTPS public de SePay goi webhook.
- Khong dung `SEPAY_AUTH_MODE=none` khi chay that.
- Khong commit file `.env` vi co secret.
- Neu dung HMAC, server can doc raw body dung nhu SePay gui.
- Endpoint webhook tra dung JSON `{"success": true}` khi da nhan thanh cong de SePay khong retry.
- Cung mot giao dich co the bi gui lai nhieu lan, server da luu `transactionId` de chong xu ly trung.

## Cac file chinh

- `server.js`: backend tao don, sinh QR, nhan webhook, kich hoat.
- `public/checkout.html`: trang quet QR va poll trang thai.
- `public/activate.html`: trang kich hoat tai khoan sau thanh toan.
- `public/assets/sepay-store.js`: tu gan nut thanh toan vao san pham trong ban clone.
- `supabase-schema.sql`: schema Supabase cho don hang va giao dich.
- `data/db.json`: cache/dev database local khi chua cau hinh Supabase.
