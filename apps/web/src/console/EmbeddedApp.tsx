import React, { useEffect, useMemo, useState } from "react";
import { Console } from "./Console";
import { createHttpPort } from "./data/httpPort";

declare global { interface Window { shopify: { idToken(): Promise<string> } } }
type Settings = { shopName: string; policyText: string };
type AppInfo = { shop: string; settings: Settings; embedUrl: string; supportEmail: string | null };

async function appRequest(path: string, body?: unknown) {
  const token = await window.shopify.idToken();
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error("Could not complete this request. Please reopen Dealify from Shopify admin and try again.");
  return response.json();
}

export function EmbeddedApp() {
  const port = useMemo(() => createHttpPort({ token: () => window.shopify.idToken() }), []);
  const [info, setInfo] = useState<AppInfo>();
  const [settings, setSettings] = useState<Settings>({ shopName: "", policyText: "" });
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [requests, setRequests] = useState<unknown[] | null>(null);
  useEffect(() => { void appRequest("/api/app").then((value: AppInfo) => { setInfo(value); setSettings(value.settings); }).catch(error => setMessage(error.message)); }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setMessage("");
    try { await appRequest("/api/app/settings", settings); setMessage("Store details saved."); setInfo(value => value && { ...value, settings }); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save. Please retry."); }
    finally { setSaving(false); }
  }
  if (!info) return <main className="paper config-error"><h1>Dealify</h1><p role="status">{message || "Connecting to your Shopify store…"}</p></main>;
  return <>
    <section className="paper" aria-label="Dealify setup" style={{ margin: "1rem", padding: "1rem" }}>
      <h2>Set up Dealify · Free pilot</h2>
      <p>Dealify negotiates merchandise prices within your rules. Payment, tax and shipping stay in Shopify Checkout. There is no app charge during this pilot.</p>
      <ol>
        <li>Review your products below. Add a cost per item in Shopify for every variant you want to offer. Products without costs stay at the listed price.</li>
        <li>Set your pricing rules and select Adopt. Stores start paused; select Resume when you are ready.</li>
        <li><a href={info.embedUrl} target="_blank" rel="noreferrer">Preview and enable the Dealify app embed</a>. Save your theme changes. The widget appears on product pages. You can disable it in the theme editor at any time.</li>
      </ol>
      <details><summary>Store information and privacy requests</summary>
        <form onSubmit={event => void save(event)}>
          <p><label>Store display name <input value={settings.shopName} maxLength={100} onChange={event => setSettings({ ...settings, shopName: event.target.value })} /></label></p>
          <p><label>Store policies <textarea value={settings.policyText} maxLength={12000} rows={5} onChange={event => setSettings({ ...settings, policyText: event.target.value })} /></label></p>
          <button disabled={saving}>{saving ? "Saving…" : "Save store details"}</button>
        </form>
        <p><button onClick={() => void appRequest("/api/app/privacy-requests").then(value => setRequests(value.requests)).catch(error => setMessage(error.message))}>View customer data requests</button></p>
        {requests && <><p>{requests.length} requests. Verify the recipient before sharing an export.</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(requests, null, 2)}</pre></>}
      </details>
      {message && <p role="status">{message}</p>}
      <p><a href="/privacy" target="_blank" rel="noreferrer">Privacy and data handling</a>{info.supportEmail && <> · <a href={`mailto:${info.supportEmail}`}>Contact support</a></>}</p>
    </section>
    <Console port={port} shopName={info.settings.shopName || "Dealify"} />
  </>;
}
