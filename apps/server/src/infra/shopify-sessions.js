/** Coordinates credential rotation and installation lifecycle within the single-process pilot. */
export function shopifySessions({ shopify, store }) {
  const pending = new Map();
  async function exclusive(shop, work) {
    const previous = pending.get(shop) || Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    pending.set(shop, result);
    try { return await result; }
    finally { if (pending.get(shop) === result) pending.delete(shop); }
  }
  const validate = shopify.validateAuthenticatedSession();
  return {
    exclusive,
    async accessToken(shop) {
      return exclusive(shop, async () => {
        if (!store.get(shop, "installation")?.active) throw new Error("Store installation is unavailable");
        const session = await shopify.ensureValidOfflineSession(shop);
        if (!session?.accessToken) throw new Error("Store installation is unavailable");
        return session.accessToken;
      });
    },
    async authenticate(request, response, next) {
      let shop;
      try {
        const payload = await shopify.api.session.decodeSessionToken(request.headers.authorization.slice(7));
        shop = new URL(payload.dest).hostname;
      } catch { return response.status(401).json({ error: "invalid_shopify_identity" }); }
      let proceed = false;
      let failure;
      await exclusive(shop, async () => {
        await validate(request, response, error => { proceed = true; failure = error; });
        if (proceed && !failure && !store.get(shop, "installation")?.active) {
          store.set(shop, "installation", "current", { active: true, installedAt: new Date().toISOString() });
        }
      });
      if (proceed) next(failure);
    },
  };
}
