# Public Shopify app: free pilot

User-authorized scope, November 17, 2026: implement the launch gaps from the repository assessment and prepare for Shopify App Store approval. The first release is free. Shopify review and live acceptance must remain explicit release gates; local checks cannot prove either.

This plan extends the historical hackathon specification. Existing pricing and public-card invariants still apply. Public distribution now requires more than one merchant, Shopify authentication, theme app extension installation, privacy lifecycle, persistent operation and truthful reporting.

## Approved test seams

The user confirmed HTTP routes for installation, store isolation and webhooks; checkout settlement for price enforcement; and the widget's public interface for shopper behavior. Shopify installation, theme rendering and payment need additional development-store acceptance.

## Implementation decisions

- Preserve the pricing engine and existing Console behavior. Keep legacy demo execution available while adding a separate production entry point.
- Use Shopify's official Node authentication libraries and an embedded merchant interface. Store identity comes from verified Shopify credentials, never a body field supplied by the browser.
- Use a theme app embed and signed app proxy for storefront requests. The public app does not replace a merchant's theme.
- Use a persistent database and encrypt Shopify tokens at rest. Each store owns its configuration, sessions, negotiations and records. The initial deployment supports one application process with a persistent volume; horizontal scaling is not claimed.
- Free pilot means no merchant charge or paid-plan UI. Abuse limits still cap AI usage. Billing is deferred until a price is explicitly approved.
- Checkout must preserve the agreed items/quantities and route payment through Shopify. The eventual paid order, not a generated checkout link, is the source of sales metrics. Estimated comparisons must be labelled.
- Avoid persistent AI customer memory in the pilot; scope conversation state to a shopper session and a shop, with retention and deletion. Any third-party processing must be disclosed.
- Scope the first release to one store currency and ordinary one-time products. Unsupported markets, subscriptions or bundle configurations must fail safely with clear messaging.

## Work and acceptance

- [ ] Shopify installation, token lifecycle and merchant authentication.
- [ ] Durable shop isolation and shopper sessions.
- [ ] Installable app embed and merchant onboarding.
- [ ] Exact agreed checkout, reliable settlement and paid-order reconciliation.
- [ ] Verified privacy/uninstall webhooks and data retention.
- [ ] Catalog pagination, abuse limits and safe outage behavior.
- [ ] Deployment, monitoring, backup/restore and reviewer instructions.
- [ ] Official requirement matrix with mandatory/optional distinctions.
- [ ] Automated tests, typechecks, build, Shopify configuration/code validation and independent review.
- [ ] Authenticated development-store test: fresh install, activate widget, negotiate, pay test order, verify reporting, uninstall and reinstall.
- [ ] Merchant identity/support/privacy details and final listing materials confirmed.
- [ ] Shopify submission and approval.

## Completed locally in this checkpoint

- [x] Exact-basket Shopify Function and repeat-safe discount minting.
- [x] Persist offers, negotiation rounds and pending approvals through restarts.
- [x] Product-page app embed with explicit acceptance and safe text rendering.
- [x] Regression tests for cold-start deletion, unknown mint invalidation and checkout-link recovery.
- [x] Independent standards/spec review and fixes for this checkpoint.

- [x] Paid/refund reporting with durable webhook jobs and missed-event reconciliation.
- [x] Customer-scoped export/redaction, 24-hour conversation expiry and uninstall write guards.
- [x] Remove unsupported recovery/uplift claims from public reporting.

## Current status

Baseline: commit 7356f3a394cd7b0f5113b541bfbbfcfc028e4413; 595 tests passed. Current checkpoint: 629 tests pass, workspace typechecks and Console build pass. Shopify app configuration validates. See research/shopify-approval-2026-11.md for current official requirements and research/backboard-public-privacy.md for AI lifecycle requirements.

Implemented foundation: official Shopify token exchange with expiring encrypted offline sessions; separate shop settings/policies/catalog runtimes; signed storefront proxy sessions; verified privacy/uninstall webhook handlers; App Bridge Console shell; product and variant pagination. The exact-basket Discount Function and signed theme embed are now connected to public checkout. Negotiations and owner approvals persist across restarts. Checkout intents recover uncertain creation/configuration responses, and post-mint invalidation queues deactivation retries. Paid-order/refund/cancellation events now queue durable reconciliation; periodic scans recover missed events and the public dashboard reports payments, refunds and net payments for recorded Dealify discount codes. Customer exports cover all retained negotiation contexts; targeted redaction, cold snapshot pruning and uninstall guards are implemented. AI restoration, provider deletion, privacy/support pages, backup/operations, live checks and final approval review remain unfinished. The user confirmed that AI chat should be restored after provider data handling is verified. The business name is Dealify; support email is pending.

The user identified development store b8wzw0-h3 and organization Shop. A new Dealify pilot app was registered there (client ID eab522082646d25b2a9d9def3bfee14b). Its local URL is a development placeholder; no production deployment or merchant installation is claimed. Extensions pass local behavior/configuration checks; development-store installation and payment remain unverified. The user reports Railway is unavailable; no provider-wide outage has been established.
