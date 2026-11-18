const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
export function supportEmail(env) {
  const email = String(env.SUPPORT_EMAIL || "").trim();
  return email.length <= 254 && /^[^\s<>@"']+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email) ? email : null;
}

/** Public documents are independent of merchant authentication and never interpolate shop/customer data. */
export function publicPages(app, { env, ai }) {
  const limits = pilotLimits(env);
  const email = supportEmail(env);
  const contact = email ? `<a href="mailto:${encodeURIComponent(email)}">${escape(email)}</a>` : "Support contact pending. Dealify is not ready for public installation.";
  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1>${!email ? "<p><strong>Draft pilot information. A monitored support address must be configured before public release.</strong></p>" : ""}${body}<hr><nav><a href="/support">Help and support</a> · <a href="/privacy">Privacy policy</a></nav></main></body></html>`;
  const send = (response, html) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    response.type("html").send(html);
  };
  app.get("/privacy", (_request, response) => send(response, page("Dealify privacy policy", `
    <p>Updated November 18, 2026. Dealify provides a shopping assistant and negotiated offers for participating Shopify stores. This policy covers Dealify's handling of merchant and shopper information. The store's own privacy policy also applies to shopping and orders.</p>
    <h2>Information we process</h2>
    <ul>
      <li>Merchant information: Shopify store domain, installation and access credentials, public store name/policies, product and variant information, inventory, product costs, pricing settings and approvals. Private costs and pricing rules are not sent to the AI provider or exposed to shoppers.</li>
      <li>Conversation information: a random session identifier, messages and negotiation context, selected products, offers and checkout-link status. When Shopify provides a signed customer identifier for a logged-in shopper, we use it to associate privacy requests with that shopper's sessions.</li>
      <li>Order information: identifiers, dates, Dealify discount attribution, currency, paid/test/cancellation status and amounts paid/refunded. Reporting queries do not request customer names, email, addresses or payment-card details. Shopify webhook payloads may include additional fields; we verify them and retain only the identifiers and fields needed for our services.</li>
    </ul>
    <p>We use this information to authenticate stores, enforce merchant pricing rules, provide shopping assistance, create Shopify checkout links, reconcile payments/refunds, prevent abuse and honor privacy requests. We do not sell personal information or use it for advertising. Please do not include personal or payment information in chat. Free-text messages can contain information you choose to provide.</p>
    <h2>Service providers and AI</h2>
    <p>Shopify provides store authentication, catalog information, checkout and order events. Payment details are handled by Shopify Checkout and its payment providers.</p>
    <p>${ai.enabled ? `AI text chat is enabled through Backboard and the selected model provider (${escape(env.BACKBOARD_MODEL_PROVIDER)}). Shopper messages, public product information and merchant-provided public policies are sent for inference.` : "AI text chat is currently disabled in this deployment. When enabled, it sends shopper messages, public product information and merchant-provided public policies to Backboard and the disclosed model provider."} We create isolated temporary conversations, turn persistent AI memory off and request deletion after each model call. We retry failed deletion requests. No shopper conversation is shared with another shopper's assistant.</p>
    <p>Provider logging, backups and downstream model processing follow the applicable provider terms. Our API deletion requests are not a promise of immediate deletion from every provider backup or security log. See <a href="https://backboard.io/privacy">Backboard's privacy policy</a> and <a href="https://backboard.io/terms">terms</a>${ai.enabled ? ` and <a href="${escape(env.BACKBOARD_PROVIDER_TERMS_URL)}">the selected provider's reviewed terms</a>` : ""}. Backboard documents hosting in Canada and the United States. Processing may cross national borders.</p>
    <p>Hosting providers process connection metadata to operate and secure the service. ${env.HOSTING_PROVIDER && env.HOSTING_REGION ? `This deployment uses ${escape(env.HOSTING_PROVIDER)} in ${escape(env.HOSTING_REGION)}.` : "The hosting provider and region must be finalized before this pilot's public launch."}</p>
    <h2>Retention and deletion</h2>
    <ul>
      <li>Shopper sessions and associated saved negotiation context expire after 24 hours. The widget also lets you delete the current conversation sooner.</li>
      <li>Dealify payment/refund reporting and discount attribution are retained for up to 60 days. Checkout recovery/revocation records are retained for up to 90 days; these contain offer/discount identifiers and basket amounts rather than message text.</li>
      <li>Prepared privacy exports expire after 30 days. Minimal webhook receipts expire after 7 days. Rate-limit counters expire at the end of their hourly or daily windows.</li>
      <li>Installation credentials and merchant configuration remain while the app is installed. Verified uninstall or shop-erasure requests remove active store records. Pending provider-deletion jobs survive uninstall until deletion is confirmed; they contain opaque resource identifiers and keyed ownership hashes, not conversation content.</li>
    </ul>
    <p>Expired records are removed by periodic cleanup. Provider outages can delay remote deletion. Restoring a backup requires applying current privacy deletion/expiry rules before the app serves traffic. Hosting logs and backup retention must be documented for the production deployment before public release.</p>
    <h2>Access, correction and deletion requests</h2>
    <p>Shoppers can use Delete this conversation in the widget or contact their store. Shopify's verified customer privacy requests let the store obtain or erase retained records associated with a signed customer identifier. Anonymous conversations cannot be matched to a customer account; delete them in the widget or let their 24-hour session expire. The store verifies the recipient before sharing an export.</p>
    <p>For access, correction, deletion, processing objections or questions about Dealify, contact ${contact}. Include the store domain and a description of your request; do not send passwords or payment-card details. Merchants can pause offers, disable the app embed or uninstall the app from Shopify admin.</p>
    <h2>Security and changes</h2>
    <p>We use verified Shopify authentication and webhooks, per-store access controls, encryption for stored record content and server-held credentials. Public connections use HTTPS. No security control can eliminate every risk. We update this page when our processing practices change and date the revised policy above.</p>
  `)));
  app.get("/support", (_request, response) => send(response, page("Dealify help and support", `
    <p>Contact Dealify: ${contact}. Tell us your store domain, the affected product and what happened. Do not send API keys, passwords or payment details.</p>
    <h2>Set up the free pilot</h2>
    <ol><li>Open Dealify from Shopify admin. New stores start paused.</li><li>Add a cost per item for each eligible variant in Shopify. This pilot supports CAD stores, available inventory and ordinary one-time products. Gift cards, subscriptions, transformed bundles and other presentment currencies are excluded.</li><li>Review and adopt your pricing settings. Add only public information to the store-policy field.</li><li>Enable the app embed using the link in Dealify setup, preview it on a product page, and save the theme. Resume offers when you are ready.</li></ol>
    <h2>Offers and checkout</h2>
    <p>Shoppers select an option and quantity, send an offer and explicitly accept the resulting card. Only the card is binding. Payment, shipping and taxes remain in Shopify Checkout. A discounted offer applies only to its exact basket, currency and original prices before expiry. Changing the basket removes its discount. Full-price checkout has no price hold. A checkout link does not confirm payment.</p>
    <h2>If something is unavailable</h2>
    <p>Check that offers are resumed, the embed is enabled, the product has an eligible variant with a cost and stock, and the storefront uses CAD. If an offer expires, request a new one. During provider or Shopify outages, assistance may use a standard reply or pause checkout; shoppers can still use the store's regular checkout at listed prices.</p>
    <h2>Privacy and removal</h2>
    <p>Use Delete this conversation to remove the current session. Merchants can view verified privacy requests in Dealify setup. To remove the widget, disable the Dealify app embed and save the theme; to disconnect the app, uninstall Dealify from Shopify admin. See the <a href="/privacy">privacy policy</a> for retention and provider processing.</p>
    <h2>Pricing and pilot limits</h2><p>There is no Dealify app charge during the free pilot. Any future paid plan will require a separate merchant decision.</p>
    <ul><li>${limits.dailyTurns} messages per store per 24-hour window, shared across shoppers; ${limits.hourlyTurns} messages per shopper session per hour. Chat and offer messages both count, including messages that use a standard reply or encounter a later processing failure.</li><li>${limits.dailySessions} new shopper sessions per store per 24-hour window.</li><li>${limits.minuteRequests} widget requests per session per minute, including catalog, status, checkout and deletion requests.</li><li>Messages must contain 1–${limits.messageCharacters} characters.</li></ul>
    <p>Windows begin with the first counted action and reset when their duration expires; they are not calendar-day quotas. Reaching a limit pauses the affected requests until its window resets. The store's regular checkout remains available at listed prices.</p>
  `)));
}
import { pilotLimits } from "./public-limits.js";

