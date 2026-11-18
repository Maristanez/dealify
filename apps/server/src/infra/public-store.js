import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { Session } from "@shopify/shopify-api";

/** Durable store for the single-process pilot. All records are authenticated-encrypted at rest. */
export function createPublicStore({ path, encryptionKey }) {
  const key = Buffer.from(encryptionKey || "", "base64");
  if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must contain 32 random bytes encoded as base64");
  if (!path) throw new Error("DATABASE_PATH must point to a persistent volume");
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS records (
      shop TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      expires INTEGER, PRIMARY KEY(shop,kind,id)
    );
    CREATE INDEX IF NOT EXISTS records_expiry ON records(expires);`);
  let closed = false;
  const identity = (shop, kind, id) => Buffer.from(JSON.stringify([shop, kind, id]));
  function encode(value, shop, kind, id) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(identity(shop, kind, id));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
  }
  function decode(row) {
    if (!row) return undefined;
    const bytes = Buffer.from(row.data, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    decipher.setAAD(identity(row.shop, row.kind, row.id));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
  }
  const store = {
    check() {
      // Check existing ciphertext as well as a committed write; a wrong key must not appear ready.
      decode(database.prepare("SELECT * FROM records LIMIT 1").get());
      store.set("@health", "probe", "current", { ready: true });
      if (store.get("@health", "probe")?.ready !== true) throw new Error("Storage check failed");
      store.remove("@health", "probe", "current");
    },
    get(shop, kind, id = "current") {
      return decode(database.prepare("SELECT * FROM records WHERE shop=? AND kind=? AND id=? AND (expires IS NULL OR expires>?)").get(shop, kind, id, Date.now()));
    },
    set(shop, kind, id, value, expires = null) {
      database.prepare("INSERT INTO records VALUES (?,?,?,?,?) ON CONFLICT(shop,kind,id) DO UPDATE SET data=excluded.data, expires=excluded.expires")
        .run(shop, kind, id, encode(value, shop, kind, id), expires);
    },
    list(shop, kind) {
      return database.prepare("SELECT * FROM records WHERE shop=? AND kind=? AND (expires IS NULL OR expires>?)").all(shop, kind, Date.now()).map(decode);
    },
    shops(kind) {
      return database.prepare("SELECT DISTINCT shop FROM records WHERE kind=? AND (expires IS NULL OR expires>?)").all(kind, Date.now()).map(row => row.shop);
    },
    entries(shop, kind) {
      return database.prepare("SELECT * FROM records WHERE shop=? AND kind=? AND (expires IS NULL OR expires>?)").all(shop, kind, Date.now()).map(row => ({ id: row.id, value: decode(row) }));
    },
    remove(shop, kind, id) { database.prepare("DELETE FROM records WHERE shop=? AND kind=? AND id=?").run(shop, kind, id); },
    removeKind(shop, kind) { database.prepare("DELETE FROM records WHERE shop=? AND kind=?").run(shop, kind); },
    removeShop(shop) { database.prepare("DELETE FROM records WHERE shop=?").run(shop); },
    prune() { database.prepare("DELETE FROM records WHERE expires IS NOT NULL AND expires<=?").run(Date.now()); },
    close() { if (!closed) { closed = true; database.close(); } },
  };
  store.sessionStorage = {
    async storeSession(session) {
      if (!session.isOnline && (!session.expires || !session.refreshToken)) throw new Error("An expiring offline Shopify token is required");
      store.set(session.shop, "session", session.id, session.toPropertyArray(true));
      return true;
    },
    async loadSession(id) {
      const row = database.prepare("SELECT * FROM records WHERE kind='session' AND id=?").get(id);
      return row ? Session.fromPropertyArray(decode(row), true) : undefined;
    },
    async deleteSession(id) { database.prepare("DELETE FROM records WHERE kind='session' AND id=?").run(id); return true; },
    async deleteSessions(ids) { for (const id of ids) await this.deleteSession(id); return true; },
    async findSessionsByShop(shop) { return store.list(shop, "session").map(value => Session.fromPropertyArray(value, true)); },
  };
  return store;
}
