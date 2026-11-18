import express from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const hash = value => createHash("sha256").update(value).digest("hex");

export function storefrontProxy({ shopify, store, runtimes, env }) {
  const router = express.Router();
  function consume(shop, id, limit, windowMs) {
    const current = store.get(shop, "budget", id) || { count: 0, until: Date.now() + windowMs };
    if (current.count >= limit) return false;
    store.set(shop, "budget", id, { ...current, count: current.count + 1 }, current.until);
    return true;
  }
  router.use(async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    const query = new URL(request.originalUrl, "https://app.invalid").searchParams;
    let valid = false;
    try { valid = await shopify.api.utils.validateHmac(query, { signator: "appProxy" }); } catch { /* fail closed */ }
    if (!valid) return response.status(401).json({ error: "invalid_proxy_signature" });
    const shop = query.get("shop");
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop || "")) return response.status(401).json({ error: "invalid_shop" });
    if (!store.get(shop, "installation")?.active) return response.status(403).json({ error: "app_not_installed" });
    response.locals.shop = shop;
    response.locals.customerId = query.get("logged_in_customer_id") || null;
    next();
  });
  router.post("/session", (request, response) => {
    const shop = response.locals.shop;
    if (!consume(shop, "sessions", 1000, 86400000)) return response.status(429).json({ error: "session_limit", reply: "The shopkeeper has reached today's limit. Please shop at the listed prices." });
    const token = randomBytes(32).toString("base64url");
    const session = { id: randomUUID(), customerId: response.locals.customerId, expires: Date.now() + 86400000 };
    store.set(shop, "shopper", hash(token), session, session.expires);
    response.json({ token, expiresAt: new Date(session.expires).toISOString() });
  });
  router.use(express.json({ limit: "24kb" }));
  router.use(async (request, response) => {
    const allowed = ["/api/chat", "/api/offers", "/api/accept", "/api/offers/status", "/api/session/reset", "/api/session/delete"];
    if (request.method !== "POST" || !allowed.includes(request.path)) return response.status(404).json({ error: "not_found" });
    const shop = response.locals.shop;
    const payload = request.body;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.shopperToken !== "string" || payload.shopperToken.length > 100) return response.status(401).json({ error: "shopper_session_required" });
    const sessionId = hash(payload.shopperToken);
    const session = store.get(shop, "shopper", sessionId);
    if (!session || session.customerId !== response.locals.customerId) return response.status(401).json({ error: "shopper_session_expired" });
    // Public checkout stays closed until the exact-basket Function is connected and verified.
    if (request.path === "/api/accept") return response.status(503).json({ error: "checkout_not_ready", reply: "Negotiated checkout is not available yet. Please shop at the listed prices." });
    if (request.path === "/api/session/delete") {
      store.remove(shop, "shopper", sessionId);
      // Reset this store's volatile conversations, including the requested session, without retaining transcripts.
      await runtimes.remove(shop);
      store.removeKind(shop, "runtime");
      return response.json({ ok: true });
    }
    const isTurn = request.path === "/api/chat" || request.path === "/api/offers";
    if (isTurn) {
      if (typeof payload.message !== "string" || !payload.message.trim() || payload.message.length > 2000) return response.status(400).json({ error: "invalid_message", reply: "Please use a message of 1–2,000 characters." });
      const dailyLimit = Math.min(10000, Math.max(1, Number(env.PILOT_DAILY_TURNS) || 500));
      if (!consume(shop, `turn:${session.id}`, 30, 3600000) || !consume(shop, "daily-turns", dailyLimit, 86400000)) {
        response.setHeader("Retry-After", "3600");
        return response.status(429).json({ error: "usage_limit", reply: "The shopkeeper has reached its conversation limit. You can still shop at the listed prices." });
      }
    }
    const runtime = await runtimes.get(shop);
    const { shopperToken: _token, ...body } = payload;
    request.bazaarPayload = { ...body, shopperId: session.id };
    request.headers.authorization = undefined;
    if (request.path === "/api/offers/status") {
      request.method = "GET";
      request.url = `/api/offers/${encodeURIComponent(String(payload.offerId || ""))}?${new URLSearchParams({ shopperId: session.id, negotiationId: String(payload.negotiationId || "") })}`;
    } else request.url = request.path;
    runtime.server.emit("request", request, response);
  });
  return router;
}
