import { afterEach, expect, it } from "vitest";
import { createPublicStore } from "./infra/public-store.js";
import { mintPublicDiscount, revokePublicDiscount, retryPublicRevocations } from "./public-checkout.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const offer = () => ({ offerId: "offer-1", total: 7500, expiresAt: new Date(Date.now() + 900000), items: [{ variantId: "gid://shopify/ProductVariant/1", qty: 1, list: 10000 }] });
function setup() {
  const store = createPublicStore({ path: ":memory:", encryptionKey: Buffer.alloc(32, 7).toString("base64") });
  cleanups.push(() => store.close());
  return { store, shop: "test.myshopify.com", apiKey: "test-key" };
}

it.each(["create", "configure"])("recovers a lost %s response without issuing another discount", async stage => {
  const context = setup();
  let created = false, configured: unknown, createCalls = 0, interrupted = false;
  const graphql = async (query: string, variables: any) => {
    if (query.includes("codeDiscountNodeByCode")) return { codeDiscountNodeByCode: created ? { id: "discount-1", codeDiscount: { __typename: "DiscountCodeApp", appDiscountType: { appKey: "test-key" } }, metafield: configured ? { jsonValue: configured } : null } : null };
    if (query.includes("discountCodeAppCreate")) {
      createCalls++; created = true;
      if (stage === "create" && !interrupted) { interrupted = true; throw new Error("Connection lost after creation"); }
      return { discountCodeAppCreate: { codeAppDiscount: { discountId: "discount-1" }, userErrors: [] } };
    }
    const value = JSON.parse(variables.metafields[0].value);
    configured = { lines: value.lines, total: value.total, currency: value.currency };
    if (stage === "configure" && !interrupted) { interrupted = true; throw new Error("Connection lost after configuration"); }
    return { metafieldsSet: { userErrors: [] } };
  };
  const input = offer();
  await expect(mintPublicDiscount({ ...context, graphql }, input)).rejects.toThrow("Connection lost");
  const settlement = await mintPublicDiscount({ ...context, graphql }, input);
  expect(settlement.agreedTotal).toBe(7500);
  expect(settlement.checkoutUrl).toMatch(/^https:\/\/test.myshopify.com\/cart\/1:1\?discount=DEALIFY-/);
  expect(createCalls).toBe(1);
});

it("keeps a revoked offer unusable while retrying a Shopify deactivation failure", async () => {
  const context = setup();
  let failDeactivation = true, deactivations = 0;
  const graphql = async (query: string) => {
    if (query.includes("codeDiscountNodeByCode")) return { codeDiscountNodeByCode: null };
    if (query.includes("discountCodeAppCreate")) return { discountCodeAppCreate: { codeAppDiscount: { discountId: "discount-1" }, userErrors: [] } };
    if (query.includes("discountCodeDeactivate")) { deactivations++; return { discountCodeDeactivate: { userErrors: failDeactivation ? [{ message: "Try later" }] : [] } }; }
    return { metafieldsSet: { userErrors: [] } };
  };
  const input = offer();
  await mintPublicDiscount({ ...context, graphql }, input);
  await expect(revokePublicDiscount({ ...context, graphql }, input.offerId)).rejects.toThrow();
  await expect(mintPublicDiscount({ ...context, graphql }, input)).rejects.toThrow("no longer available");
  failDeactivation = false;
  await retryPublicRevocations({ ...context, graphql });
  expect(deactivations).toBe(2);
  await retryPublicRevocations({ ...context, graphql });
  expect(deactivations).toBe(2);
});
