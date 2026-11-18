import { randomUUID } from "node:crypto";

const DAY = 86400000;
const ORDER_FIELDS = `id createdAt updatedAt cancelledAt test displayFinancialStatus discountCodes
  totalReceivedSet { shopMoney { amount currencyCode } }
  totalRefundedSet { shopMoney { amount currencyCode } }`;
export const ORDER_QUERY = `#graphql
query DealifyOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`;
export const ORDERS_QUERY = `#graphql
query DealifyOrders($after: String, $query: String!) {
  orders(first: 100, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ORDER_FIELDS} }
  }
}`;

function money(value) {
  const amount = value?.shopMoney?.amount;
  if (value?.shopMoney?.currencyCode !== "CAD" || !/^\d+(?:\.\d{1,2})?$/.test(String(amount))) throw new Error("Unsupported order money");
  const [whole, fraction = ""] = String(amount).split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error("Invalid order money");
  return cents;
}

/** Persist identifiers only at webhook time; reconcile the latest Shopify state to tolerate delivery order. */
export function orderLedger({ store, sessions, fetchImpl }) {
  const running = new Map();
  let closed = false;
  async function graphql(shop, query, variables) {
    const accessToken = await sessions.accessToken(shop);
    const response = await fetchImpl(`https://${shop}/admin/api/2026-10/graphql.json`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Order reconciliation is temporarily unavailable");
    const result = await response.json();
    if (result.errors?.length) throw new Error("Order reconciliation is temporarily unavailable");
    return result.data;
  }
  function queue(shop, orderId) {
    const id = String(orderId || "").replace(/^gid:\/\/shopify\/Order\//, "");
    if (!/^\d{1,20}$/.test(id)) throw new Error("Invalid order identifier");
    if (!store.get(shop, "installation")?.active || store.get(shop, "redacted-order", id)) return;
    const expiresAt = Date.now() + 7 * DAY;
    store.set(shop, "order-job", id, { id, revision: randomUUID(), attempts: 0, nextAt: 0, expiresAt }, expiresAt);
  }
  function saveOrder(shop, order) {
    if (!order) throw new Error("Order is unavailable");
    const id = String(order.id).split("/").at(-1);
    if (!/^\d{1,20}$/.test(id)) throw new Error("Invalid order identifier");
    if (store.get(shop, "redacted-order", id)) return;
    const previous = store.get(shop, "order", id);
    const offerIds = (order.discountCodes || []).map(code => store.get(shop, "checkout-code", String(code).toUpperCase())?.offerId).filter(Boolean);
    if (!offerIds.length && !previous) return;
    const createdAt = Date.parse(order.createdAt), updatedAt = Date.parse(order.updatedAt);
    if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) throw new Error("Invalid order timestamp");
    if (createdAt < Date.now() - 60 * DAY || updatedAt < Date.parse(previous?.updatedAt || "1970-01-01")) return;
    const received = money(order.totalReceivedSet), refunded = money(order.totalRefundedSet);
    store.set(shop, "order", id, {
      id,
      offerIds: offerIds.length ? offerIds : previous.offerIds,
      createdAt: order.createdAt, updatedAt: order.updatedAt,
      paid: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.displayFinancialStatus),
      cancelled: Boolean(order.cancelledAt), test: Boolean(order.test), currency: "CAD", received, refunded,
    }, createdAt + 60 * DAY);
  }
  async function refresh(shop, { scan = false } = {}) {
    if (closed || !store.get(shop, "installation")?.active) return;
    if (running.has(shop)) return running.get(shop);
    const installedAt = store.get(shop, "installation")?.installedAt;
    const stillInstalled = () => !closed && store.get(shop, "installation")?.active && store.get(shop, "installation")?.installedAt === installedAt;
    const run = (async () => {
      for (const job of store.list(shop, "order-job").filter(job => job.nextAt <= Date.now()).slice(0, 20)) {
        try {
          const result = await graphql(shop, ORDER_QUERY, { id: `gid://shopify/Order/${job.id}` });
          if (!stillInstalled()) return;
          saveOrder(shop, result.order);
          if (store.get(shop, "order-job", job.id)?.revision === job.revision) store.remove(shop, "order-job", job.id);
        } catch {
          if (!stillInstalled()) return;
          if (store.get(shop, "order-job", job.id)?.revision !== job.revision) continue;
          const attempts = job.attempts + 1;
          store.set(shop, "order-job", job.id, { ...job, attempts, nextAt: Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7)) }, job.expiresAt);
        }
      }
      let sync = store.get(shop, "order-sync") || {};
      if (!stillInstalled() || (!scan && !sync.cursor && Date.now() < (sync.nextAt || 0))) return;
      if (!store.list(shop, "checkout-code").length) return;
      const startedAt = sync.cursor ? sync.startedAt : new Date().toISOString();
      const from = sync.cursor ? sync.from : new Date(Math.max(Date.now() - 60 * DAY, Date.parse(sync.completedAt || installedAt) - 300000)).toISOString();
      try {
        for (let page = 0; page < 2; page++) {
          const data = await graphql(shop, ORDERS_QUERY, { after: sync.cursor || null, query: `updated_at:>='${from}' updated_at:<='${startedAt}' created_at:>='${new Date(Date.now() - 60 * DAY).toISOString()}'` });
          if (!stillInstalled()) return;
          if (!data?.orders?.pageInfo || !Array.isArray(data.orders.nodes)) throw new Error("Incomplete order result");
          for (const order of data.orders.nodes) saveOrder(shop, order);
          const cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
          if (data.orders.pageInfo.hasNextPage && (!cursor || cursor === sync.cursor)) throw new Error("Invalid order cursor");
          sync = { ...sync, cursor, startedAt, from, failed: false, nextAt: Date.now() + 3600000, ...(cursor ? {} : { completedAt: startedAt }) };
          store.set(shop, "order-sync", "current", sync);
          if (!cursor) break;
        }
      } catch {
        if (stillInstalled()) store.set(shop, "order-sync", "current", { ...sync, failed: true, nextAt: Date.now() + 60000 });
      }
    })();
    running.set(shop, run);
    try { await run; } finally { running.delete(shop); }
  }
  function report(shop) {
    const records = store.list(shop, "order");
    const paid = records.filter(order => order.paid && !order.test);
    const received = paid.reduce((sum, order) => sum + order.received, 0);
    const refunded = paid.reduce((sum, order) => sum + order.refunded, 0);
    return { currency: "CAD", days: 60, paidOrders: paid.length, received, refunded, net: received - refunded,
      cancelledOrders: paid.filter(order => order.cancelled).length,
      testOrders: records.filter(order => order.test && order.paid).length,
      pending: store.list(shop, "order-job").length + (store.get(shop, "order-sync")?.cursor ? 1 : 0),
      lastReconciledAt: store.get(shop, "order-sync")?.completedAt || null,
      syncFailed: store.get(shop, "order-sync")?.failed || false,
    };
  }
  const maintenance = setInterval(() => {
    for (const shop of store.shops("installation")) void refresh(shop).catch(() => undefined);
  }, 60000);
  maintenance.unref();
  return { queue, refresh, report, close: async () => { closed = true; clearInterval(maintenance); await Promise.all([...running.values()]); } };
}
