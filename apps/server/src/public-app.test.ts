import { afterEach, expect, it } from "vitest";
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
function proxy(shop: string, route: string) {
  const query = new URLSearchParams({ shop, timestamp: String(Math.floor(Date.now() / 1000)), path_prefix: "/apps/dealify", logged_in_customer_id: "" });
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
    if (String(input).includes("graphql")) return Response.json({ data: { products: { nodes: [] } } });
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
    return Response.json({ data: { products: { nodes: [{ id: `gid://shopify/Product/${second ? 2 : 1}`, title: second ? "Second page product" : "First page product", handle: second ? "second" : "first", variants: { nodes: [{ id: `gid://shopify/ProductVariant/${second ? 2 : 1}`, title: "Default Title", price: "100.00", inventoryQuantity: 10, inventoryItem: { unitCost: { amount: "40.00", currencyCode: "CAD" } } }] } }], pageInfo: { hasNextPage: !second, endCursor: second ? null : "next-products" } } } });
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
    return Response.json({ data: { products: { nodes: [{ id: "gid://shopify/Product/1", title: "Every size", handle: "sizes", variants: { nodes: [variant(1)], pageInfo: { hasNextPage: true, endCursor: "next-variants" } } }] } } });
  });
  const state = await fetch(`${base}/api/console/state`, { headers: { Authorization: `Bearer ${token("first.myshopify.com")}` } }).then(r => r.json());
  expect(state.products[0].variants.map((item: { size: string }) => item.size)).toEqual(["Size 1", "Size 2"]);
});

it("deleting one shopper preserves another shopper's live offer", async () => {
  const { base } = await start({}, async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.grant_type) return Response.json({ access_token: "offline-token", expires_in: 3600, refresh_token: "refresh-token", refresh_token_expires_in: 7776000, scope: "read_products,read_inventory,write_discounts,read_orders,write_app_proxy" });
    return Response.json({ data: { products: { nodes: [{ id: "gid://shopify/Product/1", title: "Every size", handle: "sizes", variants: { nodes: [{ id: "gid://shopify/ProductVariant/1", title: "Default Title", price: "100.00", inventoryQuantity: 10, inventoryItem: { unitCost: { amount: "40.00", currencyCode: "CAD" } } }] } }] } } });
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
