import { afterEach, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createPublicApp } from "./public-app.js";

const servers: Server[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
const env = {
  SHOPIFY_API_KEY: "test-key", SHOPIFY_API_SECRET: "test-secret",
  SHOPIFY_APP_URL: "https://app.example.com", DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  DATABASE_PATH: ":memory:",
};
function webhook(topic: string, shop: string, body: unknown, valid = true) {
  const text = JSON.stringify(body);
  return { method: "POST", headers: {
    "Content-Type": "application/json", "X-Shopify-Topic": topic, "X-Shopify-Shop-Domain": shop,
    "X-Shopify-API-Version": "2026-10", "X-Shopify-Webhook-Id": `${topic}-${shop}`,
    "X-Shopify-Triggered-At": new Date().toISOString(),
    "X-Shopify-Hmac-Sha256": valid ? createHmac("sha256", env.SHOPIFY_API_SECRET).update(text).digest("base64") : "invalid",
  }, body: text };
}
function proxy(shop: string, route: string, customerId = "") {
  const query = new URLSearchParams({ shop, timestamp: String(Math.floor(Date.now() / 1000)), path_prefix: "/apps/dealify", logged_in_customer_id: customerId });
  const message = [...query.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("");
  query.set("signature", createHmac("sha256", env.SHOPIFY_API_SECRET).update(message).digest("hex"));
  return `/proxy/${route}?${query}`;
}
function token(shop: string) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: `https://${shop}/admin`, dest: `https://${shop}`, aud: "test-key", sub: "42", exp: now + 60, nbf: now - 1, iat: now, jti: "test" })}`;
  return `${data}.${createHmac("sha256", env.SHOPIFY_API_SECRET).update(data).digest("base64url")}`;
}
async function start(overrides: Record<string, string> = {}, boundary?: typeof fetch) {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/graphql.json")) return Response.json({ data: { shop: { currencyCode: "CAD", name: "Test store" }, products: { nodes: [] } } });
    if (!url.endsWith("/admin/oauth/access_token")) throw new Error(`Unexpected Shopify call: ${url}`);
    return Response.json({ access_token: "offline-token", expires_in: 3600, refresh_token: "refresh-token", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
  };
  const instance = createPublicApp({ env: { ...env, ...overrides }, fetchImpl: boundary || fetchImpl });
  cleanups.push(() => instance.close());
  const server = instance.app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...instance, base };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("does not let an old uninstall retry disable a fresh installation", async () => {
  const { base } = await start();
  const shop = "first.myshopify.com";
  const headers = { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" };
  await fetch(`${base}/api/app`, { headers });
  const uninstall = webhook("app/uninstalled", shop, {});
  expect((await fetch(`${base}/webhooks`, uninstall)).status).toBe(200);
  await fetch(`${base}/api/app`, { headers });
  await fetch(`${base}/webhooks`, uninstall);
  expect((await fetch(base + proxy(shop, "session"), { method: "POST" })).status).toBe(200);
});

it("ignores a delayed uninstall or shop redaction from before the current installation", async () => {
  const { base } = await start();
  const shop = "first.myshopify.com";
  const headers = { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" };
  await fetch(`${base}/api/app/settings`, { method: "POST", headers, body: JSON.stringify({ shopName: "Reinstalled", policyText: "Fresh policy" }) });
  for (const topic of ["app/uninstalled", "shop/redact"]) {
    const delayed = webhook(topic, shop, {});
    delayed.headers["X-Shopify-Triggered-At"] = new Date(Date.now() - 86400000).toISOString();
    expect((await fetch(`${base}/webhooks`, delayed)).status).toBe(200);
  }
  expect((await fetch(base + proxy(shop, "session"), { method: "POST" })).status).toBe(200);
  expect((await fetch(`${base}/api/app`, { headers }).then(r => r.json())).settings.shopName).toBe("Reinstalled");
});

it("shares one offline credential refresh across simultaneous shoppers", async () => {
  let refreshes = 0;
  const { base } = await start({}, async (input, init) => {
    if (String(input).includes("graphql")) return Response.json({ data: { shop: { currencyCode: "CAD" }, products: { nodes: [] } } });
    const body = JSON.parse(String(init?.body));
    if (body.grant_type === "refresh_token") {
      refreshes++;
      await new Promise(resolve => setTimeout(resolve, 25));
      return Response.json({ access_token: "fresh-token", expires_in: 3600, refresh_token: "rotated-token", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
    }
    return Response.json({ access_token: "old-token", expires_in: 1, refresh_token: "initial-refresh", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
  });
  const shop = "first.myshopify.com";
  await fetch(`${base}/api/pause`, { method: "POST", headers: { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" }, body: JSON.stringify({ paused: false }) });
  const sessions = await Promise.all([1, 2].map(() => fetch(base + proxy(shop, "session"), { method: "POST" }).then(r => r.json())));
  await Promise.all(sessions.map(session => fetch(base + proxy(shop, "api/chat"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shopperToken: session.token, message: "Hello" }) })));
  expect(refreshes).toBe(1);
});

it("retains shop settings across an application restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dealify-test-"));
  const overrides = { DATABASE_PATH: join(directory, "app.sqlite") };
  const first = await start(overrides);
  const headers = { Authorization: `Bearer ${token("first.myshopify.com")}`, "Content-Type": "application/json" };
  await fetch(`${first.base}/api/app/settings`, { method: "POST", headers, body: JSON.stringify({ shopName: "Persistent Store", policyText: "Returns in 14 days." }) });
  await first.close();
  const second = await start(overrides);
  const data = await fetch(`${second.base}/api/app`, { headers }).then(r => r.json());
  expect(data.settings).toEqual({ shopName: "Persistent Store", policyText: "Returns in 14 days." });
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
});

it("loads App Bridge before the embedded Console and restricts framing to Shopify", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dealify-web-test-"));
  writeFileSync(join(directory, "index.html"), '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>');
  const { base } = await start({ WEB_DIST_PATH: directory });
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const response = await fetch(`${base}/?shop=first.myshopify.com&embedded=1`);
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors https://first.myshopify.com https://admin.shopify.com");
  expect(html).toContain('<meta name="shopify-api-key" content="test-key">');
  expect(html.indexOf("shopifycloud/app-bridge.js")).toBeLessThan(html.indexOf('type="module"'));
  expect(html).not.toContain("test-secret");
});

it("uses the verified Shopify shop and isolates merchant settings", async () => {
  const { base } = await start();
  const first = { Authorization: `Bearer ${token("first.myshopify.com")}`, "Content-Type": "application/json" };
  const second = { Authorization: `Bearer ${token("second.myshopify.com")}` };
  const save = await fetch(`${base}/api/app/settings?shop=second.myshopify.com`, { method: "POST", headers: first, body: JSON.stringify({ shopName: "First Store", policyText: "Returns within 30 days." }) });
  expect(save.status).toBe(200);
  const one = await fetch(`${base}/api/app?shop=second.myshopify.com`, { headers: first }).then(r => r.json());
  const two = await fetch(`${base}/api/app`, { headers: second }).then(r => r.json());
  expect(one.shop).toBe("first.myshopify.com");
  expect(one.settings.shopName).toBe("First Store");
  expect(two.settings.shopName).not.toBe("First Store");
  expect(two.settings.policyText).toBe("");
});

it("rejects forged privacy requests and erases only the signed shop", async () => {
  const { base } = await start();
  for (const shop of ["first.myshopify.com", "second.myshopify.com"]) {
    await fetch(`${base}/api/app/settings`, { method: "POST", headers: { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" }, body: JSON.stringify({ shopName: shop, policyText: "Store policy" }) });
  }
  const invalid = await fetch(`${base}/webhooks`, webhook("shop/redact", "first.myshopify.com", {}, false));
  expect(invalid.status).toBe(401);
  const valid = await fetch(`${base}/webhooks`, webhook("shop/redact", "first.myshopify.com", { shop_domain: "second.myshopify.com" }));
  expect(valid.status).toBe(200);
  const first = await fetch(`${base}/api/app`, { headers: { Authorization: `Bearer ${token("first.myshopify.com")}` } }).then(r => r.json());
  const second = await fetch(`${base}/api/app`, { headers: { Authorization: `Bearer ${token("second.myshopify.com")}` } }).then(r => r.json());
  expect(first.settings.policyText).toBe("");
  expect(second.settings.policyText).toBe("Store policy");
});

it("runs separate pricing policies and starts new installations paused", async () => {
  const { base } = await start();
  const headers = (shop: string) => ({ Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" });
  const initial = await fetch(`${base}/api/console/state`, { headers: headers("first.myshopify.com") }).then(r => r.json());
  expect(initial.policy.paused).toBe(true);
  expect(initial.products).toEqual([]);
  const change = await fetch(`${base}/api/policy`, { method: "POST", headers: headers("first.myshopify.com"), body: JSON.stringify({ floorPct: 40, askOwner: false }) });
  expect(change.status).toBe(200);
  const first = await fetch(`${base}/api/console/state`, { headers: headers("first.myshopify.com") }).then(r => r.json());
  const second = await fetch(`${base}/api/console/state`, { headers: headers("second.myshopify.com") }).then(r => r.json());
  expect(first.policy.floorPct).toBe(40);
  expect(second.policy.floorPct).toBe(25);
});

it("requires a signed storefront request and binds shopper sessions to one store", async () => {
  const { base } = await start();
  for (const shop of ["first.myshopify.com", "second.myshopify.com"]) await fetch(`${base}/api/app`, { headers: { Authorization: `Bearer ${token(shop)}` } });
  const unsigned = await fetch(`${base}/proxy/session?shop=first.myshopify.com`, { method: "POST" });
  expect(unsigned.status).toBe(401);
  const session = await fetch(base + proxy("first.myshopify.com", "session"), { method: "POST" }).then(r => r.json());
  expect(session.token).toBeTypeOf("string");
  const crossed = await fetch(base + proxy("second.myshopify.com", "api/chat"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shopperToken: session.token, message: "Hello" }) });
  expect(crossed.status).toBe(401);
  const valid = await fetch(base + proxy("first.myshopify.com", "api/chat"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shopperToken: session.token, message: "Hello", shopperId: "someone-else" }) }).then(r => r.json());
  expect(valid.paused).toBe(true);
});

it("loads products beyond the first Shopify catalog page", async () => {
  const { base } = await start({}, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.grant_type) return Response.json({ access_token: "offline-token", expires_in: 3600, refresh_token: "refresh-token", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
    const second = body.variables?.after === "next-products";
    return Response.json({ data: { shop: { currencyCode: "CAD" }, products: { nodes: [{ id: `gid://shopify/Product/${second ? 2 : 1}`, title: second ? "Second page product" : "First page product", handle: second ? "second" : "first", variants: { nodes: [{ id: `gid://shopify/ProductVariant/${second ? 2 : 1}`, title: "Default Title", price: "100.00", inventoryQuantity: 10, inventoryItem: { unitCost: { amount: "40.00", currencyCode: "CAD" } } }] } }], pageInfo: { hasNextPage: !second, endCursor: second ? null : "next-products" } } } });
  });
  const state = await fetch(`${base}/api/console/state`, { headers: { Authorization: `Bearer ${token("first.myshopify.com")}` } }).then(r => r.json());
  expect(state.products.map((item: { title: string }) => item.title)).toEqual(["First page product", "Second page product"]);
});

it("loads every variant of a product before offering it", async () => {
  const variant = (id: number) => ({ id: `gid://shopify/ProductVariant/${id}`, title: `Size ${id}`, price: "100.00", inventoryQuantity: 10, inventoryItem: { unitCost: { amount: "40.00", currencyCode: "CAD" } } });
  const { base } = await start({}, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.grant_type) return Response.json({ access_token: "offline-token", expires_in: 3600, refresh_token: "refresh-token", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
    if (body.variables?.after === "next-variants") return Response.json({ data: { product: { variants: { nodes: [variant(2)], pageInfo: { hasNextPage: false } } } } });
    return Response.json({ data: { shop: { currencyCode: "CAD" }, products: { nodes: [{ id: "gid://shopify/Product/1", title: "Every size", handle: "sizes", variants: { nodes: [variant(1)], pageInfo: { hasNextPage: true, endCursor: "next-variants" } } }] } } });
  });
  const state = await fetch(`${base}/api/console/state`, { headers: { Authorization: `Bearer ${token("first.myshopify.com")}` } }).then(r => r.json());
  expect(state.products[0].variants.map((item: { size: string }) => item.size)).toEqual(["Size 1", "Size 2"]);
});

it("deleting one shopper preserves another shopper's live offer", async () => {
  const { base } = await start({}, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.grant_type) return Response.json({ access_token: "offline-token", expires_in: 3600, refresh_token: "refresh-token", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
    return Response.json({ data: { shop: { currencyCode: "CAD" }, products: { nodes: [{ id: "gid://shopify/Product/1", title: "Every size", handle: "sizes", variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", title: "Default Title", price: "100.00", inventoryQuantity: 10, inventoryItem: { unitCost: { amount: "40.00", currencyCode: "CAD" } } }] } }] } } });
  });
  const shop = "first.myshopify.com";
  await fetch(`${base}/api/pause`, { method: "POST", headers: { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" }, body: JSON.stringify({ paused: false }) });
  const a = await fetch(base + proxy(shop, "session"), { method: "POST" }).then(r => r.json());
  const b = await fetch(base + proxy(shop, "session"), { method: "POST" }).then(r => r.json());
  const call = (route: string, body: unknown) => fetch(base + proxy(shop, route), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const offer = await call("api/offers", { shopperToken: b.token, message: "Could you do $90? I am buying today.", product: { handle: "sizes", selectedVariantId: "1" }, productContextSource: "current" }).then(r => r.json());
  expect(offer.card?.status).toBe("live");
  expect((await call("api/session/delete", { shopperToken: a.token })).status).toBe(200);
  const status = await call("api/offers/status", { shopperToken: b.token, offerId: offer.card.offerId, negotiationId: offer.negotiationId });
  expect(status.status).toBe(200);
  expect((await status.json()).card).toEqual(offer.card);
  expect((await call("api/offers/status", { shopperToken: a.token, offerId: offer.card.offerId, negotiationId: offer.negotiationId })).status).toBe(401);
});

it("settles an agreed offer with a single-use exact-basket Shopify Function", async () => {
  const calls: Array<{ query: string; variables: Record<string, any> }> = [];
  const { base } = await start({}, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.grant_type) return Response.json({ access_token: "offline-token", expires_in: 3600, refresh_token: "refresh-token", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
    calls.push(body);
    if (body.query.includes("codeDiscountNodeByCode")) return Response.json({ data: { codeDiscountNodeByCode: null } });
    if (body.query.includes("discountCodeAppCreate")) return Response.json({ data: { discountCodeAppCreate: { codeAppDiscount: { discountId: "gid://shopify/DiscountCodeNode/1" }, userErrors: [] } } });
    if (body.query.includes("metafieldsSet")) return Response.json({ data: { metafieldsSet: { userErrors: [] } } });
    return Response.json({ data: { shop: { currencyCode: "CAD" }, products: { nodes: [{ id: "gid://shopify/Product/1", title: "Every size", handle: "sizes", metafield: { value: "2020-01-01" }, variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", title: "Default Title", price: "100.00", inventoryQuantity: 10, inventoryItem: { unitCost: { amount: "40.00", currencyCode: "CAD" } } }] } }] } } });
  });
  const shop = "first.myshopify.com";
  await fetch(`${base}/api/pause`, { method: "POST", headers: { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" }, body: JSON.stringify({ paused: false }) });
  const session = await fetch(base + proxy(shop, "session"), { method: "POST" }).then(r => r.json());
  const call = (route: string, body: unknown) => fetch(base + proxy(shop, route), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const request = { shopperToken: session.token, message: "Could you do $90? It is last season and I am buying today.", product: { handle: "sizes", selectedVariantId: "1" }, productContextSource: "current" };
  let offer = await call("api/offers", request).then(r => r.json());
  for (let round = 1; round < 4; round++) offer = await call("api/offers", { ...request, negotiationId: offer.negotiationId }).then(r => r.json());
  expect(offer.card.option.total).toBeLessThan(10000);
  const input = { shopperToken: session.token, offerId: offer.card.offerId, negotiationId: offer.negotiationId };
  const response = await call("api/accept", input);
  expect(response.status).toBe(200);
  const accepted = await response.json();
  expect(accepted.settlement.agreedTotal).toBe(offer.card.option.total);
  const mutation = calls.find(call => call.query.includes("discountCodeAppCreate"))!;
  expect(mutation.variables.codeAppDiscount).toMatchObject({ functionHandle: "dealify-discount", discountClasses: ["ORDER"], usageLimit: 1, appliesOnSubscription: false, combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false }, endsAt: offer.card.expiresAt });
  const metafield = calls.find(call => call.query.includes("metafieldsSet"))!.variables.metafields[0];
  expect(JSON.parse(metafield.value)).toEqual({ currency: "CAD", total: offer.card.option.total, lines: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1, unitPrice: 10000 }] });
  expect((await call("api/accept", input).then(r => r.json())).settlement).toEqual(accepted.settlement);
  expect(calls.filter(call => call.query.includes("discountCodeAppCreate"))).toHaveLength(1);
});

it.each([false, true])("keeps offers across a restart, including owner approval=%s", async (approval) => {
  const directory = mkdtempSync(join(tmpdir(), "dealify-offer-restart-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const overrides = { DATABASE_PATH: join(directory, "app.sqlite") };
  const boundary: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.grant_type) return Response.json({ access_token: "offline-token", expires_in: 3600, refresh_token: "refresh-token", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
    return Response.json({ data: { shop: { currencyCode: "CAD" }, products: { nodes: [{ id: "gid://shopify/Product/1", title: "Every size", handle: "sizes", variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", title: "Default Title", price: "100.00", inventoryQuantity: 10, inventoryItem: { unitCost: { amount: "40.00", currencyCode: "CAD" } } }] } }] } } });
  };
  const first = await start(overrides, boundary);
  const shop = "first.myshopify.com";
  await fetch(`${first.base}/api/pause`, { method: "POST", headers: { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" }, body: JSON.stringify({ paused: false }) });
  if (approval) await fetch(`${first.base}/api/policy`, { method: "POST", headers: { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" }, body: JSON.stringify({ floorPct: 25, askOwner: true }) });
  const session = await fetch(first.base + proxy(shop, "session"), { method: "POST" }).then(r => r.json());
  const request = { shopperToken: session.token, message: approval ? "Could you do $45?" : "Could you do $90?", product: { handle: "sizes", selectedVariantId: "1" }, productContextSource: "current" };
  let offer = await fetch(first.base + proxy(shop, "api/offers"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }).then(r => r.json());
  if (approval) {
    for (let round = 1; round < 5; round++) offer = await fetch(first.base + proxy(shop, "api/offers"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...request, negotiationId: offer.negotiationId }) }).then(r => r.json());
    expect(offer.card.status).toBe("pending_owner");
  }
  await first.close();
  const second = await start(overrides, boundary);
  const response = await fetch(second.base + proxy(shop, "api/offers/status"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shopperToken: session.token, offerId: offer.card.offerId, negotiationId: offer.negotiationId }) });
  expect(response.status).toBe(200);
  expect((await response.json()).card).toEqual(offer.card);
  if (approval) {
    const state = await fetch(`${second.base}/api/console/state`, { headers: { Authorization: `Bearer ${token(shop)}` } }).then(r => r.json());
    expect(state.pendingApprovals).toHaveLength(1);
    const decision = await fetch(`${second.base}/api/approvals/${state.pendingApprovals[0].id}`, { method: "POST", headers: { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }) });
    expect(decision.status).toBe(200);
    return;
  }
  const next = await fetch(second.base + proxy(shop, "api/offers"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...request, negotiationId: offer.negotiationId }) }).then(r => r.json());
  expect(next.card.round).toBe(offer.card.round + 1);
});

it("does not expose merchant data without a verified Shopify identity", async () => {
  const { app } = createPublicApp({ env: {
    SHOPIFY_API_KEY: "test-key", SHOPIFY_API_SECRET: "test-secret",
    SHOPIFY_APP_URL: "https://app.example.com", DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    DATABASE_PATH: ":memory:",
  } });
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/console/state?shop=victim.myshopify.com`);
  expect(response.status).toBe(401);
});

it("deletes a saved conversation before reporting deletion after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dealify-delete-restart-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const boundary: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.grant_type) return Response.json({ access_token: "offline-token", expires_in: 3600, refresh_token: "refresh-token", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
    return Response.json({ data: { shop: { currencyCode: "CAD" }, products: { nodes: [{ id: "gid://shopify/Product/1", title: "Every size", handle: "sizes", variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", title: "Default Title", price: "100.00", inventoryQuantity: 10, inventoryItem: { unitCost: { amount: "40.00", currencyCode: "CAD" } } }] } }] } } });
  };
  const overrides = { DATABASE_PATH: join(directory, "app.sqlite") };
  const first = await start(overrides, boundary);
  const shop = "first.myshopify.com";
  const headers = { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" };
  await fetch(`${first.base}/api/pause`, { method: "POST", headers, body: JSON.stringify({ paused: false }) });
  await fetch(`${first.base}/api/policy`, { method: "POST", headers, body: JSON.stringify({ floorPct: 25, askOwner: true }) });
  const session = await fetch(first.base + proxy(shop, "session"), { method: "POST" }).then(r => r.json());
  const input = { shopperToken: session.token, message: "Could you do $45?", product: { handle: "sizes", selectedVariantId: "1" }, productContextSource: "current" };
  let reply: any = {};
  for (let round = 0; round < 5; round++) reply = await fetch(first.base + proxy(shop, "api/offers"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, negotiationId: reply.negotiationId }) }).then(r => r.json());
  expect(reply.card.status).toBe("pending_owner");
  await first.close();
  const second = await start(overrides, boundary);
  const deleted = await fetch(second.base + proxy(shop, "api/session/delete"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shopperToken: session.token }) });
  expect(deleted.status).toBe(200);
  const state = await fetch(`${second.base}/api/console/state`, { headers }).then(r => r.json());
  expect(state.pendingApprovals).toEqual([]);
});

it.each(["create", "configure"])("revokes an uncertain %s result when PAUSE changes during minting", async stage => {
  const shop = "first.myshopify.com";
  let base = "", created = false, deactivations = 0;
  const boundary: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.grant_type) return Response.json({ access_token: "offline-token", expires_in: 3600, refresh_token: "refresh-token", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
    if (body.query.includes("codeDiscountNodeByCode")) return Response.json({ data: { codeDiscountNodeByCode: created ? { id: "discount-1", codeDiscount: { __typename: "DiscountCodeApp", appDiscountType: { appKey: "test-key" } }, metafield: null } : null } });
    const creating = body.query.includes("discountCodeAppCreate");
    const configuring = body.query.includes("metafieldsSet");
    if (creating) created = true;
    if ((creating && stage === "create") || (configuring && stage === "configure")) {
      await fetch(`${base}/api/pause`, { method: "POST", headers: { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" }, body: JSON.stringify({ paused: true }) });
      throw new Error("Response lost after Shopify processed the mutation");
    }
    if (creating) return Response.json({ data: { discountCodeAppCreate: { codeAppDiscount: { discountId: "discount-1" }, userErrors: [] } } });
    if (body.query.includes("discountCodeDeactivate")) { deactivations++; return Response.json({ data: { discountCodeDeactivate: { userErrors: [] } } }); }
    return Response.json({ data: { shop: { currencyCode: "CAD" }, products: { nodes: [{ id: "gid://shopify/Product/1", title: "Every size", handle: "sizes", metafield: { value: "2020-01-01" }, variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", title: "Default Title", price: "100.00", inventoryQuantity: 10, inventoryItem: { unitCost: { amount: "40.00", currencyCode: "CAD" } } }] } }] } } });
  };
  ({ base } = await start({}, boundary));
  await fetch(`${base}/api/pause`, { method: "POST", headers: { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" }, body: JSON.stringify({ paused: false }) });
  const session = await fetch(base + proxy(shop, "session"), { method: "POST" }).then(r => r.json());
  const call = (route: string, data: unknown) => fetch(base + proxy(shop, route), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const input = { shopperToken: session.token, message: "Could you do $90? It is last season and I am buying today.", product: { handle: "sizes", selectedVariantId: "1" } };
  let reply: any = {};
  for (let round = 0; round < 4; round++) reply = await call("api/offers", { ...input, negotiationId: reply.negotiationId }).then(r => r.json());
  expect(reply.card.option.total).toBeLessThan(10000);
  const response = await call("api/accept", { shopperToken: session.token, offerId: reply.card.offerId, negotiationId: reply.negotiationId });
  expect(response.status).toBe(400);
  expect(deactivations).toBe(1);
});

it("reports paid orders and refunds from Shopify without counting checkout links", async () => {
  const shop = "first.myshopify.com";
  let liveOrder: Record<string, unknown> | null = null;
  let discountCode = "";
  const boundary: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.grant_type) return Response.json({ access_token: "offline-token", expires_in: 3600, refresh_token: "refresh-token", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
    if (body.query.includes("DealifyOrders")) return Response.json({ data: { orders: { nodes: liveOrder ? [liveOrder] : [], pageInfo: { hasNextPage: false } } } });
    if (body.query.includes("DealifyOrder(")) return Response.json({ data: { order: liveOrder } });
    if (body.query.includes("codeDiscountNodeByCode")) return Response.json({ data: { codeDiscountNodeByCode: null } });
    if (body.query.includes("discountCodeAppCreate")) { discountCode = body.variables.codeAppDiscount.code; return Response.json({ data: { discountCodeAppCreate: { codeAppDiscount: { discountId: "discount-1" }, userErrors: [] } } }); }
    if (body.query.includes("metafieldsSet")) return Response.json({ data: { metafieldsSet: { userErrors: [] } } });
    return Response.json({ data: { shop: { currencyCode: "CAD" }, products: { nodes: [{ id: "gid://shopify/Product/1", title: "Every size", handle: "sizes", metafield: { value: "2020-01-01" }, variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", title: "Default Title", price: "100.00", inventoryQuantity: 10, inventoryItem: { unitCost: { amount: "40.00", currencyCode: "CAD" } } }] } }] } } });
  };
  const { base } = await start({}, boundary);
  const headers = { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" };
  await fetch(`${base}/api/pause`, { method: "POST", headers, body: JSON.stringify({ paused: false }) });
  const session = await fetch(base + proxy(shop, "session"), { method: "POST" }).then(r => r.json());
  const call = (route: string, data: unknown) => fetch(base + proxy(shop, route), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const input = { shopperToken: session.token, message: "Could you do $90? It is last season and I am buying today.", product: { handle: "sizes", selectedVariantId: "1" } };
  let reply: any = {};
  for (let round = 0; round < 4; round++) reply = await call("api/offers", { ...input, negotiationId: reply.negotiationId }).then(r => r.json());
  expect((await call("api/accept", { shopperToken: session.token, offerId: reply.card.offerId, negotiationId: reply.negotiationId })).status).toBe(200);
  const report = () => fetch(`${base}/api/app/reporting`, { headers }).then(r => r.json());
  expect(await report()).toMatchObject({ paidOrders: 0, received: 0, refunded: 0, net: 0 });
  const money = (amount: string) => ({ shopMoney: { amount, currencyCode: "CAD" } });
  liveOrder = { id: "gid://shopify/Order/123", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cancelledAt: null, test: false, displayFinancialStatus: "PAID", discountCodes: [discountCode], customer: { id: "gid://shopify/Customer/456" }, totalReceivedSet: money("100.00"), totalRefundedSet: money("0.00") };
  const paid = webhook("orders/paid", shop, { id: 123, discount_codes: [{ code: discountCode }] });
  expect((await fetch(`${base}/webhooks`, paid)).status).toBe(200);
  expect(await report()).toMatchObject({ paidOrders: 1, received: 10000, refunded: 0, net: 10000 });
  expect((await fetch(`${base}/webhooks`, paid)).status).toBe(200);
  liveOrder = { ...liveOrder, updatedAt: new Date(Date.now() + 1000).toISOString(), displayFinancialStatus: "PARTIALLY_REFUNDED", totalRefundedSet: money("25.00") };
  expect((await fetch(`${base}/webhooks`, webhook("refunds/create", shop, { id: 321, order_id: 123 }))).status).toBe(200);
  expect(await report()).toMatchObject({ paidOrders: 1, received: 10000, refunded: 2500, net: 7500 });
  liveOrder = { ...liveOrder, updatedAt: new Date(Date.now() + 2000).toISOString(), cancelledAt: new Date().toISOString(), displayFinancialStatus: "REFUNDED", totalRefundedSet: money("100.00") };
  const reconciled = await fetch(`${base}/api/app/reporting/refresh`, { method: "POST", headers }).then(r => r.json());
  expect(reconciled).toMatchObject({ paidOrders: 1, refunded: 10000, net: 0, cancelledOrders: 1, pending: 0 });
  expect((await fetch(`${base}/webhooks`, webhook("customers/redact", shop, { customer: { id: 456 }, orders_to_redact: [123] }))).status).toBe(200);
  const afterDeletion = await fetch(`${base}/api/app/reporting/refresh`, { method: "POST", headers }).then(r => r.json());
  expect(afterDeletion).toMatchObject({ paidOrders: 0, refunded: 0, net: 0 });
});

it("exports and redacts only the signed customer's shopper data", async () => {
  const { base } = await start({}, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.grant_type) return Response.json({ access_token: "offline-token", expires_in: 3600, refresh_token: "refresh-token", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
    return Response.json({ data: { shop: { currencyCode: "CAD" }, products: { nodes: [{ id: "gid://shopify/Product/1", title: "Every size", handle: "sizes", variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", title: "Default Title", price: "100.00", inventoryQuantity: 10, inventoryItem: { unitCost: { amount: "40.00", currencyCode: "CAD" } } }] } }] } } });
  });
  const shop = "first.myshopify.com", headers = { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" };
  await fetch(`${base}/api/pause`, { method: "POST", headers, body: JSON.stringify({ paused: false }) });
  const a = await fetch(base + proxy(shop, "session", "456"), { method: "POST" }).then(r => r.json());
  const b = await fetch(base + proxy(shop, "session", "789"), { method: "POST" }).then(r => r.json());
  const call = (customer: string, route: string, data: unknown) => fetch(base + proxy(shop, route, customer), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const aOffer = await call("456", "api/offers", { shopperToken: a.token, message: "Could you do $90? This is for my first marathon.", product: { handle: "sizes", selectedVariantId: "1" } }).then(r => r.json());
  const bOffer = await call("789", "api/offers", { shopperToken: b.token, message: "Could you do $95? I am buying today.", product: { handle: "sizes", selectedVariantId: "1" } }).then(r => r.json());
  await call("456", "api/session/reset", { shopperToken: a.token });
  expect((await fetch(`${base}/webhooks`, webhook("customers/data_request", shop, { customer: { id: 456 }, orders_requested: [], data_request: { id: 99 } }))).status).toBe(200);
  const exported = await fetch(`${base}/api/app/privacy-requests`, { headers }).then(r => r.json());
  expect(JSON.stringify(exported)).toContain("first marathon");
  expect(JSON.stringify(exported)).not.toContain(bOffer.negotiationId);
  expect(JSON.stringify(exported)).not.toMatch(/unitCost|floorPct|ownerRank/);
  expect((await fetch(`${base}/webhooks`, webhook("customers/redact", shop, { customer: { id: 456 }, orders_to_redact: [] }))).status).toBe(200);
  expect((await call("456", "api/offers/status", { shopperToken: a.token, offerId: aOffer.card.offerId, negotiationId: aOffer.negotiationId })).status).toBe(401);
  expect((await call("789", "api/offers/status", { shopperToken: b.token, offerId: bOffer.card.offerId, negotiationId: bOffer.negotiationId })).status).toBe(200);
  expect((await fetch(`${base}/api/app/privacy-requests`, { headers }).then(r => r.json())).requests).toEqual([]);
});

it("expires shopper conversation data after 24 hours even while the shop remains active", async () => {
  const { base } = await start({}, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.grant_type) return Response.json({ access_token: "offline-token", expires_in: 3600, refresh_token: "refresh-token", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
    return Response.json({ data: { shop: { currencyCode: "CAD" }, products: { nodes: [{ id: "gid://shopify/Product/1", title: "Every size", handle: "sizes", variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", title: "Default Title", price: "100.00", inventoryQuantity: 10, inventoryItem: { unitCost: { amount: "40.00", currencyCode: "CAD" } } }] } }] } } });
  });
  const shop = "first.myshopify.com";
  await fetch(`${base}/api/pause`, { method: "POST", headers: { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" }, body: JSON.stringify({ paused: false }) });
  const session = await fetch(base + proxy(shop, "session"), { method: "POST" }).then(r => r.json());
  const offer = await fetch(base + proxy(shop, "api/offers"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shopperToken: session.token, message: "Could you do $90?", product: { handle: "sizes", selectedVariantId: "1" } }) }).then(r => r.json());
  const feed = async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/console/stream`, { headers: { Authorization: `Bearer ${token(shop)}` }, signal: controller.signal });
    const chunk = await response.body!.getReader().read();
    controller.abort();
    return new TextDecoder().decode(chunk.value);
  };
  expect(await feed()).toContain(offer.negotiationId);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 25 * 3600000);
    expect(await feed()).not.toContain(offer.negotiationId);
  } finally { vi.useRealTimers(); }
});

it("does not let an in-flight shopper request restore data after uninstall", async () => {
  let unblock!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { unblock = resolve; });
  const { base } = await start({}, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.grant_type) return Response.json({ access_token: "offline-token", expires_in: 3600, refresh_token: "refresh-token", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
    entered(); await barrier;
    return Response.json({ data: { shop: { currencyCode: "CAD" }, products: { nodes: [{ id: "gid://shopify/Product/1", title: "Every size", handle: "sizes", variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", title: "Default Title", price: "100.00", inventoryQuantity: 10, inventoryItem: { unitCost: { amount: "40.00", currencyCode: "CAD" } } }] } }] } } });
  });
  const shop = "first.myshopify.com", headers = { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" };
  await fetch(`${base}/api/pause`, { method: "POST", headers, body: JSON.stringify({ paused: false }) });
  const session = await fetch(base + proxy(shop, "session"), { method: "POST" }).then(r => r.json());
  const pending = fetch(base + proxy(shop, "api/offers"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shopperToken: session.token, message: "Could you do $90?", product: { handle: "sizes", selectedVariantId: "1" } }) });
  await waiting;
  expect((await fetch(`${base}/webhooks`, webhook("app/uninstalled", shop, {}))).status).toBe(200);
  unblock();
  expect((await pending).status).toBe(503);
  const state = await fetch(`${base}/api/console/state`, { headers }).then(r => r.json());
  expect(state.policy.paused).toBe(true);
  expect(state.pendingApprovals).toEqual([]);
});

it("pauses offers if Shopify removes a required scope", async () => {
  const { base } = await start();
  const shop = "first.myshopify.com", headers = { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" };
  await fetch(`${base}/api/pause`, { method: "POST", headers, body: JSON.stringify({ paused: false }) });
  expect((await fetch(`${base}/webhooks`, webhook("app/scopes_update", shop, { current: ["read_products"] }))).status).toBe(200);
  const state = await fetch(`${base}/api/console/state`, { headers }).then(r => r.json());
  expect(state.policy.paused).toBe(true);
});

it.each(["customers/data_request", "customers/redact"])("does not deadlock %s against an in-flight checkout", async topic => {
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const { base } = await start({}, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.grant_type) return Response.json({ access_token: "offline-token", expires_in: 3600, refresh_token: "refresh-token", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
    if (body.query.includes("codeDiscountNodeByCode")) { entered(); await barrier; return Response.json({ data: { codeDiscountNodeByCode: null } }); }
    if (body.query.includes("discountCodeAppCreate")) return Response.json({ data: { discountCodeAppCreate: { codeAppDiscount: { discountId: "discount-1" }, userErrors: [] } } });
    if (body.query.includes("metafieldsSet")) return Response.json({ data: { metafieldsSet: { userErrors: [] } } });
    return Response.json({ data: { shop: { currencyCode: "CAD" }, products: { nodes: [{ id: "gid://shopify/Product/1", title: "Every size", handle: "sizes", metafield: { value: "2020-01-01" }, variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", title: "Default Title", price: "100.00", inventoryQuantity: 10, inventoryItem: { unitCost: { amount: "40.00", currencyCode: "CAD" } } }] } }] } } });
  });
  const shop = "first.myshopify.com";
  await fetch(`${base}/api/pause`, { method: "POST", headers: { Authorization: `Bearer ${token(shop)}`, "Content-Type": "application/json" }, body: JSON.stringify({ paused: false }) });
  const session = await fetch(base + proxy(shop, "session", "456"), { method: "POST" }).then(r => r.json());
  const controller = new AbortController();
  const call = (route: string, data: unknown) => fetch(base + proxy(shop, route, "456"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), signal: controller.signal });
  let reply: any = {};
  for (let round = 0; round < 4; round++) reply = await call("api/offers", { shopperToken: session.token, message: "Could you do $90? It is last season and I am buying today.", product: { handle: "sizes", selectedVariantId: "1" }, negotiationId: reply.negotiationId }).then(r => r.json());
  const accepted = call("api/accept", { shopperToken: session.token, offerId: reply.card.offerId, negotiationId: reply.negotiationId });
  await waiting;
  const privacy = fetch(`${base}/webhooks`, { ...webhook(topic, shop, { customer: { id: 456 }, data_request: { id: 99 }, orders_to_redact: [], orders_requested: [] }), signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 25));
  release();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const responses = await Promise.race([Promise.all([accepted, privacy]).then(values => values.map(response => response.status)), new Promise(resolve => { timer = setTimeout(() => resolve("deadlocked"), 500); })]);
    expect(responses).toEqual([200, 200]);
  } finally { clearTimeout(timer); void accepted.catch(() => undefined); void privacy.catch(() => undefined); controller.abort(); }
});
