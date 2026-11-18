# Backboard lifecycle and privacy for Dealify's public app

Researched November 18, 2026 UTC (November 17 Toronto). Sources are Backboard's public API documentation, privacy policy, terms and security page. The current `packages/llm/src/backboard.ts` was read; no live credentials or customer data were accessed, no provider API requests were made, and no implementation was changed. Request examples below are documentation-derived shapes, not successful execution evidence.

## Finding and recommended architecture

**Backboard supports explicit assistant/thread creation and deletion. `memory: "off"` does not make conversation processing stateless or guarantee zero retention.** Assistants hold shared documents/configuration and assistant-scoped memory; individual threads hold conversation history. Threads persist until deleted and do not expire automatically. [Assistants](https://docs.backboard.io/concepts/assistants), [Threads](https://docs.backboard.io/concepts/threads), [Memory](https://docs.backboard.io/concepts/memory)

Recommendation for Dealify: create a fresh assistant owned by exactly one shop installation; give each app session its own explicitly created thread; force memory off for every public-mode call; persist provider IDs before sending shopper text; and run durable deletion jobs at the declared retention boundary. For stronger accidental-memory isolation, a separate assistant per session is possible but adds provisioning/cleanup overhead. Neither approach establishes contractual privacy compliance by itself.

Avoid the legacy base-assistant clone path for new merchants. Cloning copies documents and memories by default; each flag can disable copying. A new empty assistant is easier to audit than a clone of a demo assistant. [Clone API](https://docs.backboard.io/api-reference/assistants/clone)

## Current client gaps observed

These are source observations from this session; implementation may change concurrently.

| Source location / behavior | Privacy or lifecycle consequence | Proposed change |
|---|---|---|
| `performRun`, around lines 218–255: omit `thread_id` until a successful `run_ended`, then save it in a process-local map | A timeout/failed stream can leave a provider-created conversation whose ID was never saved. Restart loses cleanup knowledge. | Precreate and durably record thread ID before sending content. |
| `understandOffer`, around 336–349: `persistThread:false` | Creates a new remote conversation while discarding local reuse state; there is no remote DELETE. | Delete that known thread after each one-shot analysis, with retry state. |
| `greet`, around 356–371: `memoryOverride:"Readonly"`, `persistThread:false` | Bypasses ordinary memory-off policy. With isolation disabled, shared assistant memory can be retrieved. The API comment claiming no thread is left behind is incorrect for this implementation. | Disable persistent-memory greeting in public mode; if retained, use the same forced-off lifecycle and cleanup. |
| `forgetThreads`, around 374–375 | Deletes only local map entries; it is not a provider erasure operation. | Make local reset and actual privacy deletion distinct, and track asynchronous remote deletion. |
| `resolveOrCloneShopperAssistant` | Copies documents; seeded shopper names can copy memories; identity is an eight-hex-character hash and lacks explicit shop identity. | Use durable shop/session/provider-ID ownership records, opaque random labels, and fresh assistant creation. |
| `assistantFor` returns the base assistant when memory is off | Memory-off does not detach inherited documents/tools/configuration. | The base assistant used for public mode must itself belong to the correct shop and contain no demo/shared-private data. |
| No provider DELETE or cancellation calls; traces can include recalled memory text | Provider data and copied trace content can outlive local UI state. | Delete remote resources, minimize traces, include application logs/exports in retention rules. |

The API documentation separately establishes that `Readonly` retrieves memory, `off` neither reads nor saves memory, and thread history is independent of memory. [Memory modes](https://docs.backboard.io/concepts/memory), [Thread persistence](https://docs.backboard.io/concepts/threads)

## Concrete request shapes

Base URL: `https://app.backboard.io/api`. Send `X-API-Key` from the server; never expose it in the storefront. JSON requests also use `Content-Type: application/json`. The generated API pages display other auth examples, but the authentication guide explicitly documents API-key authentication. [Authentication](https://docs.backboard.io/authentication)

Placeholders in the examples are opaque internal IDs or server-selected configuration. They are not live values.

### 1. Create a clean assistant

```http
POST /api/assistants
Host: app.backboard.io
X-API-Key: <server-held-key>
Content-Type: application/json

{
  "name": "dealify-installation-<opaque-random-id>",
  "system_prompt": "<shop-specific, reviewed instructions>",
  "tools": []
}
```

The create schema requires `name` (1–255 characters), supports `system_prompt` and `tools`, and returns `assistant_id` with the created profile. Store the returned ID against the authenticated shop installation. Memory mode is a message setting; do not invent an assistant-level `memory:false` control. [Create Assistant](https://docs.backboard.io/api-reference/assistants/create)

Recommendation: do not include shopper contact data, the shop's cost/floor secrets, or uploaded private documents in this clean profile. Start with no documents and no tools. Supply approved public product context per request; add shop-specific retrieval only as a separately reviewed capability. The assistant concepts page says assistant documents are available across that assistant's threads. [Assistant scope](https://docs.backboard.io/concepts/assistants)

### 2. Precreate a thread before sending content

```http
POST /api/assistants/<assistant_id>/threads
Host: app.backboard.io
X-API-Key: <server-held-key>
Content-Type: application/json

{}
```

The endpoint returns `thread_id`, creation data and optional assistant/message fields. The concepts guide shows `{}` as the request. Do not rely on arbitrary request metadata here: `metadata_` is documented on the response, not a supported creation body in the reference. [Create Thread](https://docs.backboard.io/api-reference/assistants/create-thread), [Creation example](https://docs.backboard.io/concepts/threads)

Recommendation: persist `{shopId, installationId, sessionId, assistantId, threadId, retentionDeadline, deletionState}` before the next call. If creation times out with an unknown ID, send no shopper content into a replacement auto-created thread; reconcile the empty orphan later. Do not accept raw provider IDs from the browser as authority.

### 3. Send a message with memory off

```http
POST /api/threads/messages
Host: app.backboard.io
X-API-Key: <server-held-key>
Content-Type: application/json
Accept: text/event-stream

{
  "assistant_id": "<known-shop-assistant-id>",
  "thread_id": "<known-session-thread-id>",
  "content": "<minimal shopper message and approved public context>",
  "system_prompt": "<reviewed instructions for this operation>",
  "llm_provider": "<allowlisted-provider>",
  "model_name": "<configured-supported-model>",
  "stream": true,
  "memory": "off",
  "memory_response_citation": false,
  "web_search": "off"
}
```

These fields are documented by the message endpoint. Omit `memory_pro`; do not send it alongside `memory`. Do not activate voice, image/video generation, web search or tools as a side effect of this text-chat flow. A supplied thread appends conversation history; `memory:"off"` does not clear that history. [Message API](https://docs.backboard.io/api-reference/threads/send-message), [Memory modes](https://docs.backboard.io/concepts/memory)

Recommendation: force these flags after merging configuration, so a per-operation override cannot re-enable retrieval. Validate the response thread/assistant IDs against the expected mapping, serialize requests within one session and cap input size. Treat unsolicited recalled memories or unexpected resource IDs as an error requiring investigation, not content to show to a shopper.

### 4. Cancel a known active chat run when appropriate

```http
POST /api/threads/<thread_id>/runs/<run_id>/cancel
Host: app.backboard.io
X-API-Key: <server-held-key>
```

The cancellation endpoint is documented as idempotent, returning 200 even if the run already finished or was cancelled, with `thread_id`, `run_id`, and `cancelled`. Record run IDs when supplied. Cancellation is separate from deleting conversation data; aborting a client fetch is not evidence that erasure happened. [Cancel Run](https://docs.backboard.io/api-reference/threads/cancel-run)

### 5. Delete a session thread

```http
DELETE /api/threads/<thread_id>
Host: app.backboard.io
X-API-Key: <server-held-key>
```

The reference documents a 200 JSON response containing `message`, `thread_id` and `deleted_at`. The concepts guide says thread deletion removes its messages. The reference does not specify the response for an already-deleted ID or a deletion-versus-active-run race, so do not invent those behaviors in production retry logic. [Delete Thread](https://docs.backboard.io/api-reference/threads/delete), [Thread lifecycle](https://docs.backboard.io/concepts/threads)

Recommendation: keep a durable cleanup outbox until success is recorded; use a fresh cleanup request timeout/signal, not the already-aborted generation signal. A failed deletion must remain retryable and visible to operations. Test subsequent GET behavior with synthetic data before deciding which not-found responses mean already completed.

### 6. Delete an installation/session assistant

```http
DELETE /api/assistants/<assistant_id>
Host: app.backboard.io
X-API-Key: <server-held-key>
```

The reference documents a 200 response with `message`, `assistant_id` and `deleted_at`. The assistant concepts guide says deleting an assistant also removes its threads/documents. It does not explicitly enumerate all backup, audit-log, memory-vector or upstream-provider consequences. [Delete Assistant](https://docs.backboard.io/api-reference/assistants/delete), [Assistant deletion](https://docs.backboard.io/concepts/assistants)

Use this only for a resource proven to belong to the affected installation/session. Deleting a shared shop assistant for one shopper would delete other sessions; use thread cleanup for that case and assistant cleanup for uninstall/full-shop erasure.

### 7. Explicit memory cleanup if historical memory exists

```http
DELETE /api/assistants/<assistant_id>/memories
Host: app.backboard.io
X-API-Key: <server-held-key>
```

This endpoint explicitly deletes all assistant memories from the database and vector store and returns `success` plus `message`. It is irreversible. For selected memories there is also `DELETE /assistants/{assistant_id}/memories/{memory_id}`. [Reset Memories](https://docs.backboard.io/api-reference/memories/reset), [Memory management](https://docs.backboard.io/concepts/memory)

Recommendation: do not assume deleting a thread deletes separately extracted memories. Historical memory-enabled assistants need explicit inventory/remediation. Stop new writes first; asynchronous memory operations may require completion/reconciliation before proving erasure. Do not reset a shared assistant for a single shopper unless all stored data belongs to that shopper.

## What public policies support, and what they do not prove

Backboard's privacy policy, last updated November 2025, says customer data is not used to train its proprietary models. It separately says routed third-party providers follow their own practices. It describes AWS hosting in Canada/US, encryption in transit/at rest, user-configured memory retention, and a privacy-request contact. It does not give a numeric conversation/log/backup deletion SLA or a universal zero-retention promise. [Privacy policy](https://backboard.io/privacy)

Its terms grant processing rights to provide and improve services. That wording is broader than a product claim about proprietary-model training, so obtain the actual applicable DPA/account terms and clarify permitted improvement uses before promising compliance with Shopify's AI-data restrictions. This is a recommendation to resolve scope, not a finding that Backboard is training on these conversations. [Terms §5](https://backboard.io/terms)

The security page describes controls and its SOC 2 program. This research did not obtain an independent audit report or DPA: the linked public Trust Center returned no readable content to the web tool. A security marketing page is not proof of a particular certification scope or of settings on Dealify's account. [Security](https://backboard.io/security), [Trust Center](https://trust.backboard.io/)

| Unproven detail | Evidence still needed |
|---|---|
| Actual model-provider no-training/retention configuration for the selected route | Written provider/subprocessor terms and confirmation of the Backboard account/routing configuration. Choosing a provider name does not prove its contractual mode. |
| Time until deletion reaches replicas, logs, backups, caches, document storage and third parties | DPA/support statement with timelines, exceptions and restoration behavior. An API `deleted_at` is not that guarantee. |
| Assistant DELETE cascades every memory/vector/attachment artifact | Synthetic lifecycle test plus provider confirmation; use explicit memory reset when historical memory exists. |
| Delete/cancel ordering while generation or memory extraction is in flight | Documented contract or test evidence; design cleanup retries and a tombstone that blocks new app writes. |
| Idempotency and recovery of lost create responses | Provider-supported idempotency key/recovery semantics, or an application reconciliation design. No idempotency header for these create operations was established from the reviewed references. |
| Data residency outside primary Backboard hosting | Complete subprocessor/model-provider list and transfer terms; AWS Canada/US does not establish the entire route. |
| Precise per-shop API-key scopes or provider-enforced tenant boundaries | Account configuration and authorization guarantees. App-level ownership checks remain necessary. |
| Subject-specific erasure across assistant memory derived from multiple people | Data provenance/export and deletion behavior. Session-only memory-off processing avoids creating this harder shared-memory problem. |

Backboard's page named “Stateless Calls” is not a text-chat zero-retention API: it describes media generation and explicitly says messages/media metadata are still stored. Do not use that label to justify “we store nothing.” [Stateless Calls](https://docs.backboard.io/sdk/stateless-calls)

## Proposed evidence before enabling public shopper traffic

Use synthetic content only: create two shop assistants and two session threads each; verify conversation history and shop context stay separate; prove all public operations use memory off, including greetings and intent analysis; simulate generation timeout and application restart; verify known IDs remain queued for cleanup; delete one thread without affecting another; inspect post-delete GET/list behavior; then delete the isolated assistant and confirm expected children disappear. Check that no new memory was created, no content appears in application logs, and failed cleanup retries after recovery.

These checks establish application behavior, not provider backup erasure or contractual training guarantees. Keep externally meaningful privacy wording narrow: “Long-term memory is disabled, and conversation resources are deleted according to our stated retention schedule” only after that schedule and lifecycle are implemented and verified. Do not claim “no storage,” “zero retention,” “no third-party processing,” or “all backups instantly erased” from the public docs reviewed here.
