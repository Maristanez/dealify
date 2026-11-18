import { randomUUID } from "node:crypto";
import { createBazaarServer } from "../application.js";

/** Each runtime owns one shop; all durable reads and writes are scoped here. */
export function tenantRuntimes({ store, shopify, env, fetchImpl }) {
  const instances = new Map();
  async function create(shop) {
    const internalToken = `Bearer ${randomUUID()}`;
    const db = {
      merchantId: shop,
      async loadLatestPolicy() {
        return store.get(shop, "policy") || { floorPct: 25, askOwner: false, paused: true, updatedAt: new Date().toISOString() };
      },
      async appendPolicy(policy) {
        const saved = { ...policy, updatedAt: new Date().toISOString() };
        store.set(shop, "policy", "current", saved);
        return saved;
      },
      async verifyBearerToken(token) { return token === internalToken ? { id: shop, shopDomain: shop, ownerUserId: null } : null; },
      async insertDeal(input) {
        const saved = { ...input, id: input.offerId, profit: input.agreedTotal - input.cost, createdAt: new Date().toISOString() };
        store.set(shop, "deal", input.offerId, saved, Date.now() + 90 * 86400000);
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
      accessToken: async () => {
        const session = await shopify.ensureValidOfflineSession(shop);
        if (!session?.accessToken || !store.get(shop, "installation")?.active) throw new Error("Store installation is unavailable");
        return session.accessToken;
      },
    });
    return { server, internalToken };
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
      const pending = instances.get(shop);
      instances.delete(shop);
      if (pending) (await pending).server.emit("close");
    },
    async close() { await Promise.all([...instances.keys()].map(shop => this.remove(shop))); },
  };
}
