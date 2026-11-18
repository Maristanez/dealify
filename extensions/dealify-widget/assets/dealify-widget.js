(() => {
  if (customElements.get("dealify-shopkeeper")) return;
  const node = (tag, text, attributes = {}) => {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  };
  class DealifyShopkeeper extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      const root = this.attachShadow({ mode: "open" });
      try { this.strings = JSON.parse(this.dataset.strings || "{}"); } catch { this.strings = {}; }
      this.launcher = node("button", this.t("open", "Make an offer"), { "data-open": "", type: "button", "aria-expanded": "false", "aria-controls": "dealify-panel" });
      this.panel = node("section", "", { id: "dealify-panel", hidden: "", "aria-label": this.t("title", "Dealify shopkeeper") });
      const heading = node("header");
      heading.append(node("strong", this.t("title", "Dealify shopkeeper")));
      const close = node("button", this.t("close", "Close"), { type: "button" });
      close.onclick = () => this.close();
      heading.append(close);
      this.messages = node("div", "", { "data-messages": "", role: "log", "aria-live": "polite", "aria-relevant": "additions text" });
      this.offerArea = node("div", "", { "data-offer": "", "aria-live": "polite" });
      this.form = node("form");
      this.variant = node("select", "", { "aria-label": this.t("variant", "Product option"), required: "" });
      this.quantity = node("input", "", { type: "number", min: "1", max: "10", step: "1", value: "1", required: "", "aria-label": this.t("quantity", "Quantity") });
      const selectionChanged = () => { this.negotiationId = undefined; this.card = null; this.offerArea.replaceChildren(); clearTimeout(this.poll); };
      this.variant.onchange = selectionChanged;
      this.quantity.onchange = selectionChanged;
      this.input = node("textarea", "", { "aria-label": this.t("message", "Your offer or question"), required: "", maxlength: "2000", rows: "2" });
      this.send = node("button", this.t("send", "Send"), { type: "submit", disabled: "" });
      this.form.append(this.variant, this.quantity, this.input, this.send);
      this.form.onsubmit = event => { event.preventDefault(); void this.submit(); };
      this.deleteButton = node("button", this.t("delete", "Delete this conversation"), { type: "button", "data-delete": "", disabled: "" });
      this.deleteButton.onclick = () => void this.deleteSession();
      this.panel.append(heading, this.messages, this.offerArea, this.form, this.deleteButton);
      if (this.dataset.stylesheet) root.append(node("link", "", { rel: "stylesheet", href: this.dataset.stylesheet }));
      root.append(this.launcher, this.panel);
      this.launcher.onclick = () => void this.open();
      root.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); this.close(); } });
    }
    disconnectedCallback() { clearTimeout(this.poll); }
    t(key, fallback) { return this.strings[key] || fallback; }
    say(text) { if (text) this.messages.append(node("p", text)); }
    async request(path, body = {}) {
      const proxy = this.dataset.proxy;
      if (!/^\/(?!\/)[a-zA-Z0-9_/-]+$/.test(proxy || "")) throw new Error(this.t("unavailable", "Offers are unavailable right now. Please try again shortly."));
      const response = await fetch(`${proxy}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ ...body, ...(this.token ? { shopperToken: this.token } : {}) }),
        signal: AbortSignal.timeout(20000),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401) { this.token = null; this.card = null; this.offerArea.replaceChildren(); }
        throw new Error(result.reply || this.t("unavailable", "Offers are unavailable right now. Please try again shortly."));
      }
      return result;
    }
    async open() {
      this.panel.hidden = false;
      this.launcher.setAttribute("aria-expanded", "true");
      this.input.focus();
      this.scheduleStatus();
      if (this.token || this.loading) return;
      if (this.dataset.currency && this.dataset.currency !== "CAD") { this.say(this.t("currency", "Offers are available only in CAD. You can shop at the listed prices.")); return; }
      this.loading = true;
      try {
        this.token = (await this.request("/session")).token;
        const catalog = await this.request("/api/catalog", { handle: this.dataset.handle });
        this.product = catalog.items?.find(item => item.handle === this.dataset.handle);
        this.variant.replaceChildren();
        for (const variant of this.product?.variants || []) {
          if (variant.available === false) continue;
          this.variant.append(node("option", variant.title, { value: variant.id }));
        }
        this.send.disabled = !this.variant.options.length || this.product?.openToOffers === false || (catalog.currency && catalog.currency !== "CAD");
        this.deleteButton.disabled = false;
        if (this.send.disabled) this.say(this.t("ineligible", "This product is not open to offers right now."));
      } catch (error) { this.token = null; this.say(error.message); }
      finally { this.loading = false; }
    }
    close() { clearTimeout(this.poll); this.panel.hidden = true; this.launcher.setAttribute("aria-expanded", "false"); this.launcher.focus(); }
    async submit() {
      if (this.send.disabled || !this.input.value.trim() || !this.quantity.checkValidity()) return;
      const message = this.input.value.trim();
      this.send.disabled = true;
      this.deleteButton.disabled = true;
      this.variant.disabled = true;
      this.quantity.disabled = true;
      this.say(message);
      try {
        const result = await this.request("/api/chat", { message, quantity: Number(this.quantity.value), negotiationId: this.negotiationId, product: { handle: this.dataset.handle, selectedVariantId: this.variant.value } });
        this.say(result.reply);
        this.negotiationId = result.negotiationId || result.card?.negotiationId || this.negotiationId;
        if (result.card) this.showOffer(result.card);
        this.input.value = "";
      } catch (error) { this.say(error.message); }
      finally { this.send.disabled = !this.token; this.deleteButton.disabled = !this.token; this.variant.disabled = false; this.quantity.disabled = false; }
    }
    showOffer(card) {
      this.card = card;
      this.scheduleStatus();
      this.offerArea.replaceChildren();
      this.offerArea.append(node("strong", new Intl.NumberFormat(document.documentElement.lang || "en", { style: "currency", currency: "CAD", currencyDisplay: "code" }).format(card.option.total / 100)));
      const items = node("ul");
      for (const item of card.option.items) items.append(node("li", `${item.title}${item.size ? ` · ${item.size}` : ""} × ${item.qty}`));
      for (const disclosure of card.disclosure || [this.t("binding", "Only this card is binding; chat text is not.")]) this.offerArea.append(node("p", disclosure));
      this.offerArea.append(items, node("p", this.t("terms", "Tax and shipping are extra. Checkout includes only the items and quantities shown here. Changing the basket removes the discount.")));
      const discounted = card.option.total < card.option.listTotal;
      this.offerArea.append(node("p", discounted
        ? `${this.t("expires", "Discount expires")}: ${new Date(card.expiresAt).toLocaleTimeString()}`
        : this.t("list_price", "At listed price. Shopify Checkout shows current prices; no price hold applies.")));
      if (!["live", "accepted"].includes(card.status)) { this.offerArea.append(node("p", this.t(card.status, card.status === "pending_owner" ? "Waiting for the shop's approval…" : "This offer is no longer available. Please request a fresh offer."))); return; }
      const accept = node("button", card.status === "accepted" ? this.t("recover", "Recover checkout link") : this.t("accept", "Accept offer"), { type: "button", "data-accept": "" });
      accept.disabled = Date.parse(card.expiresAt) <= Date.now();
      accept.onclick = async () => {
        accept.disabled = true;
        this.deleteButton.disabled = true;
        try {
          const result = await this.request("/api/accept", { offerId: card.offerId, negotiationId: card.negotiationId });
          const url = new URL(result.settlement.checkoutUrl);
          if (url.protocol !== "https:" || url.hostname !== this.dataset.shop || url.port || url.username || url.password || !url.pathname.startsWith("/cart/")) throw new Error(this.t("unavailable", "Offers are unavailable right now. Please try again shortly."));
          const link = node("a", this.t("checkout", "Continue to Shopify Checkout"), { href: url.href, "data-checkout": "" });
          accept.replaceWith(link);
          this.card = { ...card, status: "accepted" };
          clearTimeout(this.poll);
          link.focus();
        } catch (error) { this.say(error.message); accept.disabled = Date.parse(card.expiresAt) <= Date.now(); }
        finally { this.deleteButton.disabled = !this.token; }
      };
      this.offerArea.append(accept);
    }
    scheduleStatus() {
      clearTimeout(this.poll);
      if (!this.card || this.panel.hidden || !this.isConnected || !["live", "pending_owner"].includes(this.card.status)) return;
      const card = this.card;
      this.poll = setTimeout(async () => {
        if (Date.parse(card.expiresAt) <= Date.now()) { this.showOffer({ ...card, status: "expired" }); return; }
        try {
          const result = await this.request("/api/offers/status", { offerId: card.offerId, negotiationId: card.negotiationId });
          if (this.card !== card || this.panel.hidden || !this.isConnected) return;
          if (result.card && (result.card.status !== card.status || result.card.option.total !== card.option.total)) this.showOffer(result.card);
          else this.scheduleStatus();
        } catch { if (this.card === card) this.scheduleStatus(); }
      }, card.status === "pending_owner" ? 2000 : 10000);
    }
    async deleteSession() {
      if (!this.token || this.deleteButton.disabled) return;
      this.send.disabled = true;
      this.deleteButton.disabled = true;
      clearTimeout(this.poll);
      try {
        await this.request("/api/session/delete");
        this.token = null; this.card = null; this.negotiationId = undefined;
        this.offerArea.replaceChildren(); this.messages.replaceChildren(); this.input.value = "";
        this.say(this.t("deleted", "Conversation deleted. Close and reopen to start again."));
      } catch (error) { this.say(error.message); this.send.disabled = false; this.deleteButton.disabled = false; this.scheduleStatus(); }
    }
  }
  customElements.define("dealify-shopkeeper", DealifyShopkeeper);
})();
