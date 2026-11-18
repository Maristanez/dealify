import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const FIND_DISCOUNT = `#graphql
query DealifyDiscount($code: String!) {
  codeDiscountNodeByCode(code: $code) {
    id
    metafield(namespace: "$app", key: "offer") { jsonValue }
    codeDiscount { __typename ... on DiscountCodeApp { appDiscountType { appKey } } }
  }
}`;
export const CREATE_DISCOUNT = `#graphql
mutation DealifyCreateDiscount($codeAppDiscount: DiscountCodeAppInput!) {
  discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
    codeAppDiscount { discountId }
    userErrors { field message code }
  }
}`;
export const CONFIGURE_DISCOUNT = `#graphql
mutation DealifyConfigureDiscount($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { userErrors { field message code } }
}`;
export const DEACTIVATE_DISCOUNT = `#graphql
mutation DealifyDeactivateDiscount($id: ID!) {
  discountCodeDeactivate(id: $id) { userErrors { message } }
}`;

/** A durable mint intent and deterministic code make retrying an unknown API outcome safe. */
export async function mintPublicDiscount({ store, shop, apiKey, graphql }, offer) {
  const config = {
    currency: "CAD", total: offer.total,
    lines: offer.items.map(item => ({ variantId: item.variantId, quantity: item.qty || 1, unitPrice: item.list })).sort((a, b) => a.variantId.localeCompare(b.variantId)),
  };
  if (!config.lines.length || config.lines.some(line => !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(line.variantId) || !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 10 || !Number.isSafeInteger(line.unitPrice) || line.unitPrice <= 0)) throw new Error("This basket cannot receive an offer.");
  const list = config.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  if (!Number.isSafeInteger(config.total) || config.total <= 0 || config.total > list || offer.expiresAt.getTime() <= Date.now()) throw new Error("Please request a fresh offer.");
  const code = `DEALIFY-${createHash("sha256").update(`${shop}:${offer.offerId}`).digest("hex").slice(0, 24).toUpperCase()}`;
  let record = store.get(shop, "checkout", offer.offerId);
  const signature = JSON.stringify(config);
  if (record && record.signature !== signature) throw new Error("This offer changed. Please request a fresh offer.");
  if (record?.status === "revoked") throw new Error("This offer is no longer available.");
  if (record?.settlement) return record.settlement;
  record ||= { id: offer.offerId, code, signature, expiresAt: offer.expiresAt.toISOString(), status: "creating" };
  const save = () => {
    store.set(shop, "checkout", offer.offerId, record, Date.now() + 90 * 86400000);
    if (config.total < list) store.set(shop, "checkout-code", code, { offerId: offer.offerId }, Date.now() + 60 * 86400000);
  };
  save();
  // At list price there is no promised discount or price hold. Shopify shows the current price.
  if (config.total < list) {
    const existing = (await graphql(FIND_DISCOUNT, { code })).codeDiscountNodeByCode;
    if (existing) {
      if (existing.codeDiscount?.__typename !== "DiscountCodeApp" || existing.codeDiscount.appDiscountType?.appKey !== apiKey) throw new Error("The checkout code conflicts with an existing discount. Please request a fresh offer.");
      if (existing.metafield && !isDeepStrictEqual(existing.metafield.jsonValue, config)) throw new Error("The offer configuration changed. Please request a fresh offer.");
      record.discountId = existing.id;
    } else {
      const result = (await graphql(CREATE_DISCOUNT, { codeAppDiscount: {
        title: `Dealify offer ${code}`, code, functionHandle: "dealify-discount", discountClasses: ["ORDER"],
        context: { all: "ALL" }, usageLimit: 1, appliesOncePerCustomer: true,
        appliesOnOneTimePurchase: true, appliesOnSubscription: false,
        startsAt: new Date().toISOString(), endsAt: record.expiresAt,
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
      } })).discountCodeAppCreate;
      if (result?.userErrors?.length || !result?.codeAppDiscount?.discountId) throw new Error("Shopify could not create this offer. Please retry shortly.");
      record.discountId = result.codeAppDiscount.discountId;
    }
    record.status = "created"; save();
    if (!existing?.metafield) {
      const result = (await graphql(CONFIGURE_DISCOUNT, { metafields: [{ ownerId: record.discountId, namespace: "$app", key: "offer", type: "json", value: signature, compareDigest: null }] })).metafieldsSet;
      if (!result || result.userErrors?.length) throw new Error("Shopify could not finish this offer. Please retry shortly.");
    }
  }
  const cart = offer.items.map(item => `${String(item.variantId).split("/").at(-1)}:${item.qty || 1}`).join(",");
  const discounted = config.total < list;
  record.status = "configured";
  record.settlement = {
    offerId: offer.offerId, code: discounted ? code : null, agreedTotal: config.total,
    checkoutUrl: `https://${shop}/cart/${cart}${discounted ? `?discount=${encodeURIComponent(code)}` : ""}`,
    expiresAt: record.expiresAt, ...(record.discountId ? { discountId: record.discountId } : {}),
  };
  save();
  return record.settlement;
}

/** Persist the refusal before calling Shopify, including when the upstream outcome is unknown. */
export async function revokePublicDiscount({ store, shop, apiKey, graphql }, offerId) {
  const record = store.get(shop, "checkout", offerId);
  if (!record || record.revokedAt) return;
  record.status = "revoked";
  const save = () => store.set(shop, "checkout", offerId, record, Date.now() + 90 * 86400000);
  save();
  if (!record.discountId && record.code && Date.parse(record.expiresAt) > Date.now()) {
    const existing = (await graphql(FIND_DISCOUNT, { code: record.code })).codeDiscountNodeByCode;
    // A timed-out create may still be processing. Keep retrying until found or natively expired.
    if (!existing) throw new Error("Awaiting the outcome of Shopify discount creation.");
    if (existing.codeDiscount?.__typename !== "DiscountCodeApp" || existing.codeDiscount.appDiscountType?.appKey !== apiKey) throw new Error("The checkout code belongs to another app.");
    record.discountId = existing.id;
    save();
  }
  if (record.discountId && Date.parse(record.expiresAt) > Date.now()) {
    const result = (await graphql(DEACTIVATE_DISCOUNT, { id: record.discountId })).discountCodeDeactivate;
    if (!result || result.userErrors?.length) throw new Error("Shopify discount deactivation needs a retry.");
  }
  record.revokedAt = new Date().toISOString();
  save();
}

export async function retryPublicRevocations(context) {
  for (const record of context.store.list(context.shop, "checkout")) {
    if (record.status !== "revoked" || record.revokedAt) continue;
    try { await revokePublicDiscount(context, record.id); }
    catch { /* Keep the durable intent for the next maintenance pass. Native expiry still applies. */ }
  }
}
