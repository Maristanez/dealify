import express from "express";
import { shopifyApp } from "@shopify/shopify-app-express";
import { LogSeverity } from "@shopify/shopify-api";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicStore } from "./infra/public-store.js";
import { tenantRuntimes } from "./infra/tenant-runtime.js";
import { storefrontProxy } from "./storefront-proxy.js";
import { shopifySessions } from "./infra/shopify-sessions.js";
import { orderLedger } from "./order-ledger.js";
// Express exposes its CommonJS entry point; share its SDK runtime when injecting transport.
const { setAbstractFetchFunc } = createRequire(import.meta.url)("@shopify/shopify-api/runtime");

export const PUBLIC_API_VERSION = "2026-10";
export const PUBLIC_SCOPES = ["read_products", "read_inventory", "write_discounts", "read_orders", "write_app_proxy"];

export function createPublicApp({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  setAbstractFetchFunc(fetchImpl);
  const store = createPublicStore({ path: env.DATABASE_PATH, encryptionKey: env.DATA_ENCRYPTION_KEY });
  const origin = new URL(env.SHOPIFY_APP_URL);
  if (origin.protocol !== "https:") throw new Error("SHOPIFY_APP_URL must use HTTPS");
  const shopify = shopifyApp({
    api: {
      apiKey: env.SHOPIFY_API_KEY,
      apiSecretKey: env.SHOPIFY_API_SECRET,
      apiVersion: PUBLIC_API_VERSION,
      scopes: PUBLIC_SCOPES,
      hostName: origin.host,
      hostScheme: "https",
      isEmbeddedApp: true,
      logger: { level: LogSeverity.Error },
    },
    auth: { path: "/auth", callbackPath: "/auth/callback" },
    webhooks: { path: "/webhooks" },
    future: { tokenExchange: true, expiringOfflineAccessTokens: true },
    sessionStorage: store.sessionStorage,
  });
  const app = express();
  const sessions = shopifySessions({ shopify, store });
  const orders = orderLedger({ store, sessions, fetchImpl });
  const runtimes = tenantRuntimes({ store, sessions, env, fetchImpl });
  let retentionRun;
  function maintainRetention() {
    if (retentionRun) return retentionRun;
    retentionRun = runtimes.prune().then(() => store.prune()).catch(() => {
      console.error("[retention] Cleanup will retry.");
    }).finally(() => { retentionRun = undefined; });
    return retentionRun;
  }
  const retention = setInterval(() => void maintainRetention(), 60000);
  retention.unref();
  void maintainRetention();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  const webhookTasks = new Map();
  async function processWebhook(shop, work) {
    const previous = webhookTasks.get(shop) || Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    webhookTasks.set(shop, current);
    try { return await current; }
    finally { if (webhookTasks.get(shop) === current) webhookTasks.delete(shop); }
  }
  app.post("/webhooks", express.raw({ type: "application/json", limit: "2mb" }), async (request, response) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "";
    const validation = await shopify.api.webhooks.validate({ rawBody, rawRequest: request, rawResponse: response });
    if (!validation.valid) return response.status(401).json({ error: "invalid_webhook" });
    const shop = validation.domain;
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) return response.status(400).json({ error: "invalid_shop" });
    return processWebhook(shop, async () => {
    const handle = async () => {
    const eventId = String(validation.webhookId || "");
    if (!eventId || eventId.length > 200) return response.status(400).json({ error: "invalid_webhook_id" });
    if (store.get(shop, "webhook", eventId)) return response.json({ ok: true });
    let payload;
    try { payload = JSON.parse(rawBody); } catch { return response.status(400).json({ error: "invalid_json" }); }
    if (["SHOP_REDACT", "APP_UNINSTALLED"].includes(validation.topic)) {
      const triggeredAt = Date.parse(request.get("X-Shopify-Triggered-At") || "");
      const installation = store.get(shop, "installation");
      if (!Number.isFinite(triggeredAt)) return response.status(400).json({ error: "webhook_timestamp_required" });
      if (installation?.active && triggeredAt < Date.parse(installation.installedAt)) {
        store.set(shop, "webhook", eventId, { processed: true }, Date.now() + 7 * 86400000);
        return response.json({ ok: true });
      }
    }
    if (validation.topic === "SHOP_REDACT") {
      await runtimes.remove(shop);
      store.removeShop(shop);
    } else if (validation.topic === "APP_UNINSTALLED") {
      await runtimes.remove(shop);
      store.removeShop(shop);
      store.set(shop, "installation", "current", { active: false, uninstalledAt: new Date().toISOString() });
    } else if (validation.topic === "APP_SCOPES_UPDATE") {
      if (!Array.isArray(payload.current) || payload.current.some(scope => typeof scope !== "string")) return response.status(400).json({ error: "invalid_scopes" });
      if (store.get(shop, "installation")?.active) {
        for (const session of await store.sessionStorage.findSessionsByShop(shop)) { session.scope = payload.current.join(","); await store.sessionStorage.storeSession(session); }
        if (PUBLIC_SCOPES.some(scope => !payload.current.includes(scope))) {
          await runtimes.remove(shop);
          const policy = store.get(shop, "policy") || { floorPct: 25, askOwner: false };
          store.set(shop, "policy", "current", { ...policy, paused: true, updatedAt: new Date().toISOString() });
        }
      }
    } else if (["ORDERS_PAID", "ORDERS_CANCELLED", "REFUNDS_CREATE"].includes(validation.topic)) {
      const orderId = validation.topic === "REFUNDS_CREATE" ? payload.order_id : payload.admin_graphql_api_id || payload.id;
      orders.queue(shop, orderId);
    } else if (validation.topic === "CUSTOMERS_REDACT") {
      const customerId = payload.customer?.id == null ? null : String(payload.customer.id);
      await runtimes.deleteCustomer(shop, customerId);
      for (const id of (payload.orders_to_redact || []).map(String)) {
        store.remove(shop, "order", id);
        store.remove(shop, "order-job", id);
        store.set(shop, "redacted-order", id, { redacted: true }, Date.now() + 60 * 86400000);
      }
      for (const entry of store.entries(shop, "privacy-request")) {
        if (customerId && entry.value.customerId === customerId) store.remove(shop, "privacy-request", entry.id);
      }
    } else if (validation.topic === "CUSTOMERS_DATA_REQUEST") {
      const requestedOrders = new Set((payload.orders_requested || []).map(String));
      const customerId = payload.customer?.id == null ? null : String(payload.customer.id);
      const data = store.list(shop, "order").filter(order => requestedOrders.has(String(order.id)));
      const shopperData = await runtimes.customerData(shop, customerId);
      store.set(shop, "privacy-request", String(payload.data_request?.id || validation.webhookId), {
        id: String(payload.data_request?.id || validation.webhookId), receivedAt: new Date().toISOString(),
        customerId, data, shopperData, note: "Provide this export using the merchant's verified customer contact process. Anonymous sessions cannot be matched to a customer account and expire after 24 hours. The app does not request names, email addresses or payment details; shoppers may include personal information in their messages.",
      }, Date.now() + 30 * 86400000);
    } else return response.status(400).json({ error: "unsupported_topic" });
    // Keep only a short-lived receipt, never the customer-bearing webhook body.
    store.set(shop, "webhook", eventId, { processed: true }, Date.now() + 7 * 86400000);
    response.status(200).json({ ok: true });
    };
    return ["SHOP_REDACT", "APP_UNINSTALLED", "APP_SCOPES_UPDATE"].includes(validation.topic) ? sessions.exclusive(shop, handle) : handle();
    });
  });
  app.use("/proxy", storefrontProxy({ shopify, store, runtimes, env }));
  app.use("/api", (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    if (!request.headers.authorization?.startsWith("Bearer ")) return response.status(401).json({ error: "shopify_authentication_required" });
    next();
  }, sessions.authenticate);
  app.get("/api/app", (request, response) => {
    const shop = response.locals.shopify.session.shop;
    response.json({ shop, settings: store.get(shop, "settings") || { shopName: "", policyText: "" }, free: true,
      embedUrl: `https://${shop}/admin/themes/current/editor?context=apps&template=product&activateAppId=${encodeURIComponent(env.SHOPIFY_API_KEY)}/dealify`,
      supportEmail: env.SUPPORT_EMAIL || null,
    });
  });
  app.get("/api/app/privacy-requests", (_request, response) => response.json({ requests: store.list(response.locals.shopify.session.shop, "privacy-request") }));
  app.get("/api/app/reporting", async (_request, response) => {
    const shop = response.locals.shopify.session.shop;
    await orders.refresh(shop);
    response.json(orders.report(shop));
  });
  app.post("/api/app/reporting/refresh", async (_request, response) => {
    const shop = response.locals.shopify.session.shop;
    await orders.refresh(shop, { scan: true });
    response.json(orders.report(shop));
  });
  app.post("/api/app/settings", express.json({ limit: "20kb" }), (request, response) => {
    const { shopName, policyText } = request.body || {};
    if (typeof shopName !== "string" || shopName.length > 100 || typeof policyText !== "string" || policyText.length > 12000) {
      return response.status(400).json({ error: "invalid_settings" });
    }
    const shop = response.locals.shopify.session.shop;
    store.set(shop, "settings", "current", { shopName: shopName.trim(), policyText: policyText.trim() });
    response.json({ ok: true });
  });
  app.use(async (request, response, next) => {
    if (!/^\/api\/(?:console\/(?:state|stream)|policy|pause|approvals\/[^/]+)$/.test(request.path)) return next();
    const shop = response.locals.shopify.session.shop;
    const runtime = await runtimes.get(shop);
    request.headers.authorization = runtime.internalToken;
    runtime.server.emit("request", request, response);
  });
  const webRoot = env.WEB_DIST_PATH || fileURLToPath(new URL("../../web/dist/", import.meta.url));
  app.use("/assets", express.static(`${webRoot}/assets`, { immutable: true, maxAge: "1y", index: false }));
  app.get(["/", "/console", "/console/"], shopify.ensureInstalledOnShop(), (_request, response) => {
    const html = readFileSync(`${webRoot}/index.html`, "utf8");
    const clientId = String(env.SHOPIFY_API_KEY).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
    response.setHeader("Cache-Control", "no-store");
    response.type("html").send(html.replace(/<head>/i, `<head><meta name="shopify-api-key" content="${clientId}"><script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>`));
  });
  app.use((_request, response) => response.status(404).json({ error: "not_found" }));
  app.use((error, _request, response, _next) => {
    // Never expose upstream errors, request bodies, credentials or stacks to the browser.
    if (response.headersSent) return response.end();
    const status = error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 503;
    response.status(status).json({ error: status === 503 ? "temporarily_unavailable" : "invalid_request" });
  });
  return { app, shopify, close: async () => { clearInterval(retention); await retentionRun; await orders.close(); await runtimes.close(); store.close(); } };
}
