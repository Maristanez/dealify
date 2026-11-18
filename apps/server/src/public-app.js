import express from "express";
import { shopifyApp } from "@shopify/shopify-app-express";
import { LogSeverity } from "@shopify/shopify-api";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicStore } from "./infra/public-store.js";
import { tenantRuntimes } from "./infra/tenant-runtime.js";
import { storefrontProxy } from "./storefront-proxy.js";
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
    hooks: { afterAuth: ({ session }) => {
      store.set(session.shop, "installation", "current", { active: true, installedAt: new Date().toISOString() });
    } },
  });
  const app = express();
  const runtimes = tenantRuntimes({ store, shopify, env, fetchImpl });
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  app.post("/webhooks", express.raw({ type: "application/json", limit: "2mb" }), async (request, response) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : "";
    const validation = await shopify.api.webhooks.validate({ rawBody, rawRequest: request, rawResponse: response });
    if (!validation.valid) return response.status(401).json({ error: "invalid_webhook" });
    const shop = validation.domain;
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) return response.status(400).json({ error: "invalid_shop" });
    let payload;
    try { payload = JSON.parse(rawBody); } catch { return response.status(400).json({ error: "invalid_json" }); }
    if (validation.topic === "SHOP_REDACT") {
      await runtimes.remove(shop);
      store.removeShop(shop);
    } else if (validation.topic === "APP_UNINSTALLED") {
      await runtimes.remove(shop);
      store.removeKind(shop, "session");
      store.removeKind(shop, "shopper");
      store.removeKind(shop, "runtime");
      store.set(shop, "installation", "current", { active: false, uninstalledAt: new Date().toISOString() });
    } else if (validation.topic === "CUSTOMERS_REDACT") {
      await runtimes.remove(shop);
      // The pilot keeps no cross-session AI memory. Clear transient conversation state conservatively.
      store.removeKind(shop, "shopper");
      store.removeKind(shop, "runtime");
      const orders = new Set((payload.orders_to_redact || []).map(String));
      for (const order of store.list(shop, "order")) {
        if (orders.has(String(order.id)) || String(order.customerId) === String(payload.customer?.id)) store.remove(shop, "order", String(order.id));
      }
    } else if (validation.topic === "CUSTOMERS_DATA_REQUEST") {
      const orders = new Set((payload.orders_requested || []).map(String));
      const data = store.list(shop, "order").filter(order => orders.has(String(order.id)));
      store.set(shop, "privacy-request", String(payload.data_request?.id || validation.webhookId), {
        id: String(payload.data_request?.id || validation.webhookId), receivedAt: new Date().toISOString(),
        data, note: "Provide this export to the requesting customer using the merchant's verified contact process. The app stores no customer names, email addresses or payment details.",
      }, Date.now() + 30 * 86400000);
    } else return response.status(400).json({ error: "unsupported_topic" });
    response.status(200).json({ ok: true });
  });
  app.use("/proxy", storefrontProxy({ shopify, store, runtimes, env }));
  app.use("/api", (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    if (!request.headers.authorization?.startsWith("Bearer ")) return response.status(401).json({ error: "shopify_authentication_required" });
    next();
  }, shopify.validateAuthenticatedSession());
  app.get("/api/app", (request, response) => {
    const shop = response.locals.shopify.session.shop;
    response.json({ shop, settings: store.get(shop, "settings") || { shopName: "", policyText: "" }, free: true,
      embedUrl: `https://${shop}/admin/themes/current/editor?context=apps&template=product&activateAppId=${encodeURIComponent(env.SHOPIFY_API_KEY)}/dealify`,
      supportEmail: env.SUPPORT_EMAIL || null,
    });
  });
  app.get("/api/app/privacy-requests", (_request, response) => response.json({ requests: store.list(response.locals.shopify.session.shop, "privacy-request") }));
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
  return { app, shopify, close: async () => { await runtimes.close(); store.close(); } };
}
