(function () {
  const state = { products: new Map(), selected: null };

  init();

  async function init() {
    try {
      const response = await fetch("/api/catalog");
      const data = await response.json();
      for (const product of data.products || []) {
        state.products.set(String(product.id), product);
      }
      injectButtons();
      buildModal();
    } catch (error) {
      console.warn("Cannot load checkout catalog", error);
    }
  }

  function injectButtons() {
    document.querySelectorAll(".product-small.col").forEach((card) => {
      if (card.querySelector(".sepay-buy-button")) return;
      const className = card.getAttribute("class") || "";
      const match = className.match(/\bpost-(\d+)\b/);
      if (!match) return;
      const product = state.products.get(match[1]);
      if (!product) return;

      const target = card.querySelector(".price-wrapper") || card.querySelector(".box-text") || card;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sepay-buy-button";
      button.dataset.productId = product.id;
      button.textContent = "Thanh toán QR";
      button.addEventListener("click", () => openModal(product));
      target.appendChild(button);
    });
  }

  function buildModal() {
    if (document.querySelector(".sepay-modal-backdrop")) return;

    const backdrop = document.createElement("div");
    backdrop.className = "sepay-modal-backdrop";
    backdrop.innerHTML = `
      <form class="sepay-modal" autocomplete="on">
        <header>
          <button class="sepay-modal-close" type="button" aria-label="Dong">x</button>
          <h3 data-title></h3>
          <p class="sepay-price" data-price></p>
        </header>
        <main>
          <label>Ho ten
            <input name="name" maxlength="80" required>
          </label>
          <label>Email nhan kich hoat
            <input name="email" type="email" maxlength="120" required>
          </label>
          <label>So dien thoai
            <input name="phone" maxlength="30">
          </label>
          <p class="sepay-modal-error" data-error></p>
        </main>
        <footer>
          <button type="button" data-cancel>Huy</button>
          <button type="submit">Tao QR thanh toán</button>
        </footer>
      </form>
    `;
    document.body.appendChild(backdrop);

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeModal();
    });
    backdrop.querySelector(".sepay-modal-close").addEventListener("click", closeModal);
    backdrop.querySelector("[data-cancel]").addEventListener("click", closeModal);
    backdrop.querySelector("form").addEventListener("submit", submitOrder);
  }

  function openModal(product) {
    state.selected = product;
    const backdrop = document.querySelector(".sepay-modal-backdrop");
    backdrop.querySelector("[data-title]").textContent = product.title;
    backdrop.querySelector("[data-price]").textContent = product.amountText;
    setError("");
    backdrop.classList.add("is-open");
    const firstInput = backdrop.querySelector("input");
    if (firstInput) firstInput.focus();
  }

  function closeModal() {
    const backdrop = document.querySelector(".sepay-modal-backdrop");
    if (backdrop) backdrop.classList.remove("is-open");
  }

  async function submitOrder(event) {
    event.preventDefault();
    if (!state.selected) return;

    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    setError("");

    try {
      const formData = new FormData(form);
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: state.selected.id,
          name: formData.get("name"),
          email: formData.get("email"),
          phone: formData.get("phone")
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Khong tao duoc don hang");
      window.location.href = `/checkout.html?code=${encodeURIComponent(data.order.code)}`;
    } catch (error) {
      setError(error.message || "Co loi xay ra");
      submit.disabled = false;
    }
  }

  function setError(message) {
    const error = document.querySelector(".sepay-modal-error");
    if (!error) return;
    error.textContent = message;
    error.classList.toggle("is-visible", Boolean(message));
  }
})();
