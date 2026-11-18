import { createHmac, randomUUID } from "node:crypto";
import { createBackboardShopkeeper } from "@bazaar/llm";

const BASE = "https://app.backboard.io/api";
// Deliberately outside any merchant namespace: uninstall must not erase deletion jobs.
const CLEANUP = "@provider-cleanup";
const KIND = "backboard";
const id = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
const rejected = error => error?.status >= 400 && error.status < 500 && ![408, 409].includes(error.status);

/** One-shot AI processing. Only opaque resource IDs and keyed ownership hashes survive cleanup failures. */
export function publicAi({ store, env, fetchImpl }) {
  const apiKey = env.BACKBOARD_API_KEY?.trim();
  const enabled = env.PUBLIC_AI_ENABLED === "true" && Boolean(apiKey && env.BACKBOARD_MODEL_PROVIDER?.trim() && env.BACKBOARD_MODEL_NAME?.trim()
    && /^\d{4}-\d{2}-\d{2}$/.test(env.BACKBOARD_TERMS_REVIEWED_AT || "") && /^https:\/\//.test(env.BACKBOARD_PROVIDER_TERMS_URL || ""));
  const active = new Map();
  const deleting = new Map();
  const clients = new Set();
  const hash = (...parts) => createHmac("sha256", env.DATA_ENCRYPTION_KEY).update(JSON.stringify(parts)).digest("hex");
  let closing = false;
  let maintenance;

  async function request(path, method, body, signal) {
    const response = await fetchImpl(`${BASE}${path}`, {
      method, signal, headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if ((method === "DELETE" || path.endsWith("/cancel")) && response.status === 404) return null;
    if (!response.ok) throw Object.assign(new Error(`AI lifecycle HTTP ${response.status}`), { status: response.status });
    return method === "DELETE" || path.endsWith("/cancel") ? null : response.json();
  }
  function save(job) { store.set(CLEANUP, KIND, job.name, job); }
  function pending(shop) {
    const owner = shop ? hash(shop, store.get(shop, "installation")?.installedAt) : null;
    return store.list(CLEANUP, KIND).filter(job => job.attempts > 0 && (!owner || job.owner === owner)).length;
  }
  async function clean(job) {
    if (deleting.has(job.name)) return deleting.get(job.name);
    const task = (async () => {
      try {
        const signal = AbortSignal.timeout(1500);
        let assistantId = job.assistantId;
        if (!assistantId) {
          const found = await request(`/assistants?name=${encodeURIComponent(job.name)}&skip=0&limit=100`, "GET", undefined, signal);
          if (!Array.isArray(found) || found.length !== 1 || found[0].name !== job.name || !id(found[0].assistant_id)) throw new Error("AI creation still unresolved");
          assistantId = found[0].assistant_id;
          job.assistantId = assistantId; save(job);
        }
        if (job.threadRequested && !job.threadId) {
          const threads = await request(`/assistants/${assistantId}/threads?skip=0&limit=100`, "GET", undefined, signal);
          // Exactly one creation was attempted. A missing response may still arrive upstream later.
          if (!Array.isArray(threads) || threads.length !== 1 || !id(threads[0].thread_id)) throw new Error("AI thread creation still unresolved");
          job.threadId = threads[0].thread_id; save(job);
        }
        if (job.threadId && job.runId) await request(`/threads/${job.threadId}/runs/${job.runId}/cancel`, "POST", undefined, signal);
        if (job.threadId) await request(`/threads/${job.threadId}`, "DELETE", undefined, signal);
        // An assistant is disposable and never shared with another run.
        await request(`/assistants/${assistantId}`, "DELETE", undefined, signal);
        store.remove(CLEANUP, KIND, job.name);
      } catch {
        job.attempts = (job.attempts || 0) + 1;
        job.nextAt = Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(job.attempts, 12));
        save(job);
      }
    })();
    deleting.set(job.name, task);
    try { await task; } finally { deleting.delete(job.name); }
  }
  async function maintain() {
    if (!apiKey || closing) return;
    if (maintenance) return maintenance;
    maintenance = (async () => {
      for (const job of store.list(CLEANUP, KIND).filter(job => !active.has(job.name) && (job.nextAt || 0) <= Date.now()).slice(0, 20)) await clean(job);
      if (pending()) console.error("[ai/cleanup] Provider deletion pending", { jobs: pending() });
    })().finally(() => { maintenance = undefined; });
    return maintenance;
  }
  async function erase(owner, shopper) {
    for (const run of active.values()) if (run.owner === owner && (!shopper || run.shopper === shopper)) run.controller.abort();
    // Active calls clean themselves in finally; never race a DELETE against a resource still being created.
    for (const job of store.list(CLEANUP, KIND)) if (job.owner === owner && (!shopper || job.shopper === shopper) && !active.has(job.name)) { job.nextAt = Date.now(); save(job); }
    void maintain().catch(() => console.error("[ai/cleanup] Maintenance could not finish; durable jobs will retry."));
  }
  return {
    enabled,
    pending,
    maintain,
    forShop(shop) {
      if (!enabled) return null;
      const installedAt = store.get(shop, "installation")?.installedAt;
      const owner = hash(shop, installedAt);
      const lease = { owner, active: true };
      clients.add(lease);
      const erasedShoppers = new Set();
      const valid = () => !closing && lease.active && store.get(shop, "installation")?.active && store.get(shop, "installation")?.installedAt === installedAt;
      const client = createBackboardShopkeeper({
        apiKey, provider: env.BACKBOARD_MODEL_PROVIDER, model: env.BACKBOARD_MODEL_NAME,
        timeoutMs: Math.min(10000, Math.max(100, Number(env.BACKBOARD_TIMEOUT_MS) || 6500)), fetchImpl,
        publicStore: () => store.get(shop, "settings") || { shopName: "", policyText: "" },
        conversation: { async run(shopperId, signal, work) {
          if (!valid() || erasedShoppers.has(shopperId)) throw new Error("AI conversation inactive");
          const controller = new AbortController();
          const combined = AbortSignal.any([signal, controller.signal]);
          const job = { name: `dealify-${randomUUID()}`, owner, shopper: hash(owner, shopperId), nextAt: Date.now(), attempts: 0 };
          save(job); // No shopper text is sent until both resource IDs have been committed.
          const run = { owner, shopper: job.shopper, controller, done: null };
          active.set(job.name, run);
          const task = (async () => {
            try {
              let assistant;
              try { assistant = await request("/assistants", "POST", { name: job.name, system_prompt: "Follow the per-request shopping instructions.", tools: [] }, combined); }
              catch (error) {
                if (rejected(error)) { job.rejected = true; store.remove(CLEANUP, KIND, job.name); }
                throw error;
              }
              if (!id(assistant?.assistant_id)) throw new Error("AI assistant ID missing");
              job.assistantId = assistant.assistant_id; save(job);
              combined.throwIfAborted();
              job.threadRequested = true; save(job);
              let thread;
              try { thread = await request(`/assistants/${job.assistantId}/threads`, "POST", {}, combined); }
              catch (error) {
                if (rejected(error)) { job.threadRequested = false; save(job); }
                throw error;
              }
              if (!id(thread?.thread_id)) throw new Error("AI thread ID missing");
              job.threadId = thread.thread_id; save(job);
              combined.throwIfAborted();
              if (!valid() || erasedShoppers.has(shopperId)) throw new Error("AI conversation inactive");
              const result = await work({ assistantId: job.assistantId, threadId: job.threadId, recordRun(runId) {
                if (!id(runId)) throw new Error("Invalid AI run ID");
                job.runId = runId; save(job);
              } }, combined);
              job.runId = null; save(job);
              return result;
            } finally {
              active.delete(job.name);
              // Erasure is durable before the request. Provider outages must not delay the shopper's fallback or Shopify webhooks.
              if (!job.rejected) void clean(job).catch(() => console.error("[ai/cleanup] Cleanup could not finish; durable jobs will retry."));
            }
          })();
          run.done = task.catch(() => undefined);
          return task;
        } },
      });
      return { client, eraseShopper: shopperId => { erasedShoppers.add(shopperId); return erase(owner, hash(owner, shopperId)); } };
    },
    async eraseShop(shop) {
      const owner = hash(shop, store.get(shop, "installation")?.installedAt);
      for (const lease of clients) if (lease.owner === owner) { lease.active = false; clients.delete(lease); }
      await erase(owner);
    },
    async close() {
      closing = true;
      for (const run of active.values()) run.controller.abort();
      await Promise.all([...active.values()].map(run => run.done));
      await maintenance;
      await Promise.all(deleting.values());
    },
  };
}
