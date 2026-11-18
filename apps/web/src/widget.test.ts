// @vitest-environment jsdom
import { beforeAll, afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { waitFor } from "@testing-library/react";

beforeAll(() => { window.eval(readFileSync(resolve(process.cwd(), "extensions/dealify-widget/assets/dealify-widget.js"), "utf8")); });
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

it("loads only when opened and treats shopper-facing replies as text", async () => {
  const request = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/session")) return Response.json({ token: "shopper-token" });
    if (url.endsWith("/api/catalog")) return Response.json({ items: [{ handle: "tee", variants: [{ id: "1", title: "Small", available: true }] }] });
    return Response.json({ reply: '<img src=x onerror="alert(1)">' });
  });
  vi.stubGlobal("fetch", request);
  const widget = document.createElement("dealify-shopkeeper");
  widget.dataset.proxy = "/apps/dealify"; widget.dataset.handle = "tee"; widget.dataset.shop = "test.myshopify.com";
  document.body.append(widget);
  expect(request).not.toHaveBeenCalled();
  widget.shadowRoot!.querySelector<HTMLButtonElement>("[data-open]")!.click();
  await waitFor(() => expect(widget.shadowRoot!.querySelector("option")?.textContent).toBe("Small"));
  const input = widget.shadowRoot!.querySelector<HTMLTextAreaElement>("textarea")!;
  input.value = "Could you do $50?";
  widget.shadowRoot!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => expect(widget.shadowRoot!.querySelector("[data-messages]")?.textContent).toContain("<img src=x"));
  expect(widget.shadowRoot!.querySelector("img")).toBeNull();
  expect(JSON.parse(String(request.mock.calls.at(-1)![1]?.body || "{}"))).toMatchObject({ shopperToken: "shopper-token", product: { handle: "tee", selectedVariantId: "1" } });
});

it("shows the exact basket, accepts explicitly, and only links to the store's checkout", async () => {
  const card = { offerId: "offer-1", negotiationId: "round-1", status: "live", expiresAt: new Date(Date.now() + 900000).toISOString(), option: { total: 7500, listTotal: 10000, items: [{ variantId: "1", title: "Tee", size: "Small", qty: 2 }] } };
  const request = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/session")) return Response.json({ token: "shopper-token" });
    if (url.endsWith("/api/catalog")) return Response.json({ currency: "CAD", items: [{ handle: "tee", variants: [{ id: "1", title: "Small", available: true }] }] });
    if (url.endsWith("/api/accept")) return Response.json({ settlement: { checkoutUrl: "https://test.myshopify.com/cart/1:2?discount=DEALIFY-TEST" } });
    return Response.json({ reply: "I can offer this basket.", card });
  });
  vi.stubGlobal("fetch", request);
  const widget = document.createElement("dealify-shopkeeper");
  Object.assign(widget.dataset, { proxy: "/apps/dealify", handle: "tee", shop: "test.myshopify.com", currency: "CAD" });
  document.body.append(widget);
  const root = widget.shadowRoot!;
  root.querySelector<HTMLButtonElement>("[data-open]")!.click();
  await waitFor(() => expect(root.querySelector("option")).not.toBeNull());
  root.querySelector<HTMLTextAreaElement>("textarea")!.value = "Can you do $75 total for two?";
  root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await waitFor(() => expect(root.querySelector("[data-offer]")?.textContent).toContain("Tee · Small × 2"));
  expect(root.querySelector("[data-offer]")?.textContent).toContain("CAD");
  expect(root.querySelector("[data-offer]")?.textContent).toContain("Tax and shipping");
  expect(root.querySelector("[data-offer]")?.textContent).toContain("Only this card is binding");
  expect(request.mock.calls.filter(([url]) => url.endsWith("/api/accept"))).toHaveLength(0);
  root.querySelector<HTMLButtonElement>("[data-accept]")!.click();
  await waitFor(() => expect(root.querySelector<HTMLAnchorElement>("[data-checkout]")?.href).toBe("https://test.myshopify.com/cart/1:2?discount=DEALIFY-TEST"));
  expect(JSON.parse(String(request.mock.calls.at(-1)![1]?.body))).toMatchObject({ offerId: "offer-1", negotiationId: "round-1", shopperToken: "shopper-token" });
});

it("rejects checkout destinations outside the installed store", async () => {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/session")) return Response.json({ token: "t" });
    if (url.endsWith("/api/catalog")) return Response.json({ items: [{ handle: "tee", variants: [{ id: "1", title: "Small" }] }] });
    if (url.endsWith("/api/accept")) return Response.json({ settlement: { checkoutUrl: "https://test.myshopify.com.attacker.test/cart/1:1" } });
    return Response.json({ card: { offerId: "o", negotiationId: "n", status: "live", expiresAt: new Date(Date.now() + 60000).toISOString(), option: { total: 7500, listTotal: 10000, items: [{ title: "Tee", qty: 1 }] } } });
  });
  const widget = document.createElement("dealify-shopkeeper");
  Object.assign(widget.dataset, { proxy: "/apps/dealify", handle: "tee", shop: "test.myshopify.com" });
  document.body.append(widget);
  const root = widget.shadowRoot!;
  root.querySelector<HTMLButtonElement>("[data-open]")!.click();
  await waitFor(() => expect(root.querySelector("option")).not.toBeNull());
  root.querySelector<HTMLTextAreaElement>("textarea")!.value = "$75";
  root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await waitFor(() => expect(root.querySelector("[data-accept]")).not.toBeNull());
  root.querySelector<HTMLButtonElement>("[data-accept]")!.click();
  await waitFor(() => expect(root.querySelector("[data-messages]")?.textContent).toContain("unavailable"));
  expect(root.querySelector("a")).toBeNull();
});

it("polls pending approval, sends quantity, and deletes the session on request", async () => {
  const card = { offerId: "o", negotiationId: "n", status: "pending_owner", expiresAt: new Date(Date.now() + 60000).toISOString(), option: { total: 7500, listTotal: 10000, items: [{ title: "Tee", qty: 2 }] } };
  const request = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/session")) return Response.json({ token: "t" });
    if (url.endsWith("/api/catalog")) return Response.json({ items: [{ handle: "tee", variants: [{ id: "1", title: "Small" }] }] });
    if (url.endsWith("/api/offers/status")) return Response.json({ card: { ...card, status: "live" } });
    if (url.endsWith("/api/session/delete")) return Response.json({ ok: true });
    return Response.json({ card });
  });
  vi.stubGlobal("fetch", request);
  const widget = document.createElement("dealify-shopkeeper");
  Object.assign(widget.dataset, { proxy: "/apps/dealify", handle: "tee", shop: "test.myshopify.com" });
  document.body.append(widget);
  const root = widget.shadowRoot!;
  root.querySelector<HTMLButtonElement>("[data-open]")!.click();
  await waitFor(() => expect(root.querySelector("option")).not.toBeNull());
  root.querySelector<HTMLInputElement>('input[type="number"]')!.value = "2";
  root.querySelector<HTMLTextAreaElement>("textarea")!.value = "$75 total";
  root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await waitFor(() => expect(root.querySelector("[data-offer]")?.textContent).toContain("Waiting for"));
  expect(JSON.parse(String(request.mock.calls.at(-1)![1]?.body))).toMatchObject({ quantity: 2 });
  expect(root.querySelector("[data-accept]")).toBeNull();
  await waitFor(() => expect(root.querySelector("[data-accept]")).not.toBeNull(), { timeout: 4000 });
  root.querySelector<HTMLButtonElement>("[data-delete]")!.click();
  await waitFor(() => expect(root.querySelector("[data-messages]")?.textContent).toContain("deleted"));
  expect(request.mock.calls.at(-1)![0]).toContain("/api/session/delete");
  expect(root.querySelector("[data-offer]")?.textContent).toBe("");
});

it("recovers the saved checkout after an acceptance response is lost", async () => {
  vi.useFakeTimers();
  try {
    const card = { offerId: "o", negotiationId: "n", status: "live", expiresAt: new Date(Date.now() + 60000).toISOString(), option: { total: 7500, listTotal: 10000, items: [{ title: "Tee", qty: 1 }] } };
    let attempts = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/session")) return Response.json({ token: "t" });
      if (url.endsWith("/api/catalog")) return Response.json({ items: [{ handle: "tee", variants: [{ id: "1", title: "Small" }] }] });
      if (url.endsWith("/api/accept")) {
        if (++attempts === 1) throw new Error("Connection interrupted");
        return Response.json({ settlement: { checkoutUrl: "https://test.myshopify.com/cart/1:1?discount=DEALIFY-TEST" } });
      }
      if (url.endsWith("/api/offers/status")) return Response.json({ card: { ...card, status: "accepted" } });
      return Response.json({ card });
    });
    const widget = document.createElement("dealify-shopkeeper");
    Object.assign(widget.dataset, { proxy: "/apps/dealify", handle: "tee", shop: "test.myshopify.com" });
    document.body.append(widget);
    const root = widget.shadowRoot!;
    root.querySelector<HTMLButtonElement>("[data-open]")!.click();
    await vi.advanceTimersByTimeAsync(0);
    root.querySelector<HTMLTextAreaElement>("textarea")!.value = "$75";
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);
    root.querySelector<HTMLButtonElement>("[data-accept]")!.click();
    await vi.advanceTimersByTimeAsync(10000);
    const retry = root.querySelector<HTMLButtonElement>("[data-accept]");
    expect(retry).not.toBeNull();
    retry!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector<HTMLAnchorElement>("[data-checkout]")?.href).toBe("https://test.myshopify.com/cart/1:1?discount=DEALIFY-TEST");
    expect(attempts).toBe(2);
  } finally { vi.useRealTimers(); }
});
