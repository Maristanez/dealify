import { randomUUID } from "node:crypto";
import { createBazaarServer } from "../application.js";
import { mintPublicDiscount, revokePublicDiscount, retryPublicRevocations } from "../public-checkout.js";

/** Each runtime owns one shop; all durable reads and writes are scoped here. */
export function tenantRuntimes({ store, sessions, env, fetchImpl, ai }) {
  const instances = new Map();
  async function create(shop) {
    let active = true;
    const installedAt = store.get(shop, "installation")?.installedAt;
    const runtimeStore = { ...store, set(...args) {
      const installation = store.get(shop, "installation");
      if (!active || !installation?.active || installation.installedAt !== installedAt) throw new Error("Store runtime is no longer active");
      return store.set(...args);
    } };
    const internalToken = `Bearer ${randomUUID()}`;
    const shopAi = ai.forShop(shop);
    const db = {
      merchantId: shop,
      async loadLatestPolicy() {
        return store.get(shop, "policy") || { floorPct: 25, askOwner: false, paused: true, updatedAt: new Date().toISOString() };
      },
      async appendPolicy(policy) {
        const saved = { ...policy, updatedAt: new Date().toISOString() };
        runtimeStore.set(shop, "policy", "current", saved);
        return saved;
      },
      async verifyBearerToken(token) { return token === internalToken ? { id: shop, shopDomain: shop, ownerUserId: null } : null; },
      async insertDeal(input) {
        const saved = { ...input, id: input.offerId, profit: input.agreedTotal - input.cost, createdAt: new Date().toISOString() };
        runtimeStore.set(shop, "deal", input.offerId, saved, Date.now() + 60 * 86400000);
        return saved;
      },
      async listDeals() { return []; }, // Issued offers are not confirmed paid orders.
    };
    const server = await createBazaarServer({
      ownerDb: db,
      env: {
        ...env, PUBLIC_APP: "true", SHOPIFY_SHOP: shop, SHOPIFY_API_VERSION: "2026-10",
        SHOPIFY_ADMIN_ACCESS_TOKEN: undefined, SHOPIFY_CLIENT_ID: undefined, SHOPIFY_CLIENT_SECRET: undefined,
        BACKBOARD_API_KEY: undefined, ELEVENLABS_API_KEY: undefined,
      },
      fetchImpl,
      aiClient: shopAi?.client,
      accessToken: () => sessions.accessToken(shop),
      checkout: {
        mint: (offer, graphql) => mintPublicDiscount({ store: runtimeStore, shop, apiKey: env.SHOPIFY_API_KEY, graphql }, offer),
        revoke: (offerId, graphql) => revokePublicDiscount({ store: runtimeStore, shop, apiKey: env.SHOPIFY_API_KEY, graphql }, offerId),
        maintain: graphql => retryPublicRevocations({ store: runtimeStore, shop, apiKey: env.SHOPIFY_API_KEY, graphql }),
      },
      durableState: {
        load: () => store.get(shop, "runtime"),
        save: snapshot => runtimeStore.set(shop, "runtime", "current", snapshot, Date.now() + 86400000),
        activeShopperIds: () => store.list(shop, "shopper").map(session => session.id),
      },
    });
    server.on("close", () => { active = false; });
    return { server, internalToken, shopAi };
  }
  return {
    async get(shop) {
      if (!instances.has(shop)) {
        const promise = create(shop).catch(error => { instances.delete(shop); throw error; });
        instances.set(shop, promise);
      }
      return instances.get(shop);
    },
    async remove(shop) {
      await ai.eraseShop(shop);
      const pending = instances.get(shop);
      instances.delete(shop);
      if (pending) (await pending).server.emit("close");
    },
    async deleteShopper(shop, shopperId) {
      const runtime = await this.get(shop);
      await runtime.shopAi?.eraseShopper(shopperId);
      await runtime.server.deleteShopper(shopperId);
      for (const { id, value } of store.entries(shop, "privacy-request")) {
        if (!value.shopperData?.some(session => session.sessionId === shopperId)) continue;
        store.set(shop, "privacy-request", id, { ...value, shopperData: value.shopperData.filter(session => session.sessionId !== shopperId) }, Date.parse(value.receivedAt) + 30 * 86400000);
      }
    },
    async customerData(shop, customerId) {
      const shoppers = store.list(shop, "shopper").filter(session => customerId && session.customerId === customerId);
      if (!shoppers.length) return [];
      const runtime = await this.get(shop);
      return Promise.all(shoppers.map(session => runtime.server.exportShopper(session.id)));
    },
    async deleteCustomer(shop, customerId) {
      for (const { id, value } of store.entries(shop, "shopper")) {
        if (!customerId || value.customerId !== customerId) continue;
        await this.deleteShopper(shop, value.id);
        store.remove(shop, "shopper", id);
      }
    },
    async prune() {
      for (const shop of store.shops("runtime")) {
        const running = instances.get(shop);
        if (running) { (await running).server.expireShopperData(); continue; }
        const snapshot = store.get(shop, "runtime");
        if (!snapshot) continue;
        const active = new Set(store.list(shop, "shopper").map(session => session.id));
        if (!active.size) { store.removeKind(shop, "runtime"); continue; }
        const negotiations = (snapshot.negotiations || []).filter(([, value]) => active.has(value.shopperId));
        const negotiationIds = new Set(negotiations.map(([id]) => id));
        store.set(shop, "runtime", "current", {
          ...snapshot, negotiations,
          offers: (snapshot.offers || []).filter(([, value]) => active.has(value.shopperId)),
          shopperContexts: (snapshot.shopperContexts || []).filter(([id]) => active.has(id)),
          ...(snapshot.owner ? { owner: {
            ...snapshot.owner,
            approvals: snapshot.owner.approvals.filter(([, value]) => active.has(value.shopperId)),
            feed: snapshot.owner.feed.filter(value => active.has(value.event.shopperId)),
            askedNegotiations: snapshot.owner.askedNegotiations.filter(id => negotiationIds.has(id)),
          } } : {}),
        }, Math.max(...store.list(shop, "shopper").map(session => session.expires)));
      }
    },
    async close() { await Promise.all([...instances.keys()].map(shop => this.remove(shop))); },
  };
}
