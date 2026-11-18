import { readFileSync, writeFileSync } from "node:fs";
const key = process.env.SHOPIFY_API_KEY;
const url = process.env.SHOPIFY_APP_URL;
if (!key || !/^[a-zA-Z0-9_-]+$/.test(key) || !url) throw new Error("Set SHOPIFY_API_KEY and SHOPIFY_APP_URL for the registered app. No secret is needed.");
const origin = new URL(url);
if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("SHOPIFY_APP_URL must be an HTTPS origin without credentials, a path or query.");
const source = readFileSync(new URL("../shopify.app.toml.example", import.meta.url), "utf8")
  .replace("REPLACE_WITH_REGISTERED_CLIENT_ID", key).replaceAll("https://REPLACE_WITH_APP_HOST", origin.origin);
writeFileSync(new URL("../shopify.app.toml", import.meta.url), source);
console.log("Configured shopify.app.toml for the registered app. No secrets were written.");
