# Public pilot AI processing

AI text chat is implemented but must stay disabled in production until the provider review below is complete. Voice remains disabled. The free pilot has no merchant billing; provider charges are borne by Dealify.

## Data flow

Each model call creates a fresh empty Backboard assistant and a fresh thread. It does not clone the demo assistant. The server durably saves a cleanup intent before creation, saves both returned IDs before sending shopper content, forces memory off, disables memory citations, tools, web search and media generation, and rejects unexpected resource IDs or retrieved memories/files. Responses use generic Dealify shopping instructions and the current merchant's public policies. Browser-supplied product records are not trusted as catalog facts.

The model receives the shopper's message, public catalog facts and applicable public store policies. Offer selection also receives only the engine's approved options; it never receives costs or floors. Existing parsing and offer validation remain authoritative. Every call has a timeout and a deterministic fallback. Prices and final checkout remain controlled by code and Shopify.

The application attempts to cancel an unfinished known run, delete the thread and delete its disposable assistant after each call. Failed deletions remain in encrypted SQLite and retry with backoff, including after restart and uninstall. Unknown creation responses are recovered by the assistant's exact opaque name or by listing its single thread. No shopper content is sent before creation is confirmed and saved. Never remove the database or change to a different Backboard account while deletion jobs are outstanding.

Deletion jobs live in the reserved `@provider-cleanup` namespace and have no expiry until deletion is confirmed. They contain opaque provider IDs, a random label, keyed ownership hashes, timestamps and retry counts, not messages, customer IDs, shop domains or credentials. The hashes use the deployment encryption key. Customer deletion aborts active calls and prevents the interrupted request from starting another call. This is a single-process design, matching the pilot database/runtime constraint.

The widget discloses processing before enabling Send. The merchant setup identifies the provider and explains that public policies are sent to AI. Do not put private business information into those policies.

## Production activation evidence

Before setting `PUBLIC_AI_ENABLED=true`, record evidence for the actual Backboard account, selected provider and model:

1. Backboard and downstream provider training use, logging, retention, deletion/backups, subprocessors and transfer regions, including any account-specific terms. A successful DELETE response is not proof that all provider logs/backups are immediately erased.
2. Applicable data-processing agreements and Shopify protected-data requirements. Obtain any additional commitments needed for the app's actual promises and use.
3. Accurate merchant/shopper disclosures and the published privacy page, with a real monitored support contact.
4. A synthetic-data API test proving creation, response validation, cancellation and deletion; then development-store acceptance through the real signed proxy.

Set `BACKBOARD_TERMS_REVIEWED_AT` to the actual review date and `BACKBOARD_PROVIDER_TERMS_URL` to the reviewed downstream terms. Also configure the key, provider and model. These settings are an operator gate, not an automated legal certification. The application never infers consent or term verification from an API key. Keep the key server-side and do not reuse legacy memory settings or assistant IDs.

Backboard's [privacy policy](https://backboard.io/privacy) says it does not train proprietary models on customer data but routes data under downstream providers' own practices. Its [terms](https://backboard.io/terms) permit chat logging for quality assurance, debugging and analytics unless an enterprise agreement says otherwise. Public documentation alone does not establish a universal no-training/zero-retention promise for the complete processing chain.

## Evidence on November 18, 2026

HTTP regressions cover cross-store policy isolation, forced memory-off configuration, unreviewed configuration, unexpected thread IDs, recalled-memory rejection, removal of untrusted product payloads, shopper cancellation, lost thread-creation responses, timeout cancellation, and deletion retry after uninstall/restart. A widget regression checks processing disclosure before Send is enabled.

A live call using the existing Railway-configured Backboard account and `openai/gpt-5.6-terra` answered a synthetic fourteen-day returns question in approximately 2.9 seconds. Assistant creation, thread creation, response, thread DELETE and assistant DELETE each returned HTTP 200; the deletion queue was empty afterward. No real customer/store data was used, and no production activation settings were changed. The configured hosting service was offline and its Railway workspace showed an expired trial. Live Shopify proxy/payment checks and the account-specific terms review remain open.
