# Public pilot deployment and recovery

This is the release runbook, not evidence that production is configured. The public app uses one Node 24 process and persistent SQLite. Record payloads are encrypted; database metadata is not. Protect database files, WAL and backups, and keep the encryption key in a separate restricted recovery store.

## Build and start

The root Dockerfile installs the pinned pnpm version and lockfile, builds the Console, then installs production dependencies in the runtime image. It starts `apps/server/src/public-index.js` directly so Node receives termination signals. Local environment/database files are excluded from the Docker context. Shopify extensions require a separate Shopify CLI deployment.

Locally: Node 24, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm start:public`. Historical `pnpm start` serves the demo and must not be used for the public deployment.

The updated `railway.json` selects Docker and the public entry point only as a transition for the existing service. Railway stops reading legacy config on **December 1, 2026**. Import/migrate the actual project following [Railway research](../research/railway-public-operations.md), preserving existing secrets and resources. Do not invent a project graph or apply one that omits existing volumes. Committing `.railway` files alone does not apply configuration. Remove legacy config only after the stored path is cleared and replacement settings are applied.

## Required service settings

- Repository root context and deliberately selected release commit; one replica/process, no autosleep or overlapping processes on the database. Volume deployments incur downtime; high availability is not claimed.
- Persistent `/data` volume with `DATABASE_PATH=/data/dealify.sqlite`; an ephemeral container path is insufficient.
- Required `.env.public.example` values configured as server variables. Never use a test encryption key or replace the existing production key.
- Correct Shopify credentials and stable HTTPS `SHOPIFY_APP_URL`, matching the released app, proxy and webhook configuration.
- Real monitored support email, actual hosting provider/region and finalized privacy/protected-data evidence. AI remains off until [PUBLIC-AI.md](PUBLIC-AI.md) is satisfied.
- Healthcheck `/health` using service `PORT`.

Readiness returns only `{"status":"ready"}` or HTTP 503 with `{"status":"unavailable"}`. It checks Console HTML, database decryption and a committed read/write/delete cycle. It fails during shutdown and does not expose credentials, shop identities or paths. This local check does not certify Shopify/Backboard availability, queue progress or App Store approval.

On SIGTERM/SIGINT, the app marks itself unavailable and stops accepting connections, allows existing HTTP requests up to 20 seconds to drain, then closes workers/storage. Allow enough host termination grace for cleanup and verify a real shutdown. Durable deletion intents survive forced termination.

## Deployment evidence

GitHub CI checks tests, types/build and a Docker HTTP smoke test: readiness, authentication rejection, public documents and graceful exit with synthetic configuration. Local source tests do not prove a container build; inspect CI for the proposed commit.

Verify effective settings, Node version, mount permissions and free space in the target environment. Install on the development store, save settings, redeploy and confirm settings/jobs survive. Test authentication, proxy/webhook signatures, theme activation, negotiation, test payment/refund, uninstall and reinstall on the final HTTPS host. Readiness alone cannot replace these checks.

## Backup and restore gate

Before launch, enable and verify daily volume backups (documented six-day retention), define expiry for manual copies and retained old volumes, and complete a restore drill. This is a proposal, not an enabled schedule. Weekly/monthly schedules change retention promises. Prove SQLite recovery from native snapshots; never copy only the live database without its WAL. Use SQLite's online backup API or `VACUUM INTO` for a consistent application copy and protect its readable metadata. Check integrity and actual record decryption with the matching key.

1. Stop public traffic and workers. Record the restore point and preserve the current volume privately. Inspect the staged replacement mount before restoring.
2. Keep the restored app offline. Verify integrity, key, shop isolation, session expiry and pending jobs with synthetic data first.
3. Reapply every uninstall, customer redaction and conversation deletion received since the backup. This requires bookkeeping outside that backup. **The independent deletion record/replay mechanism is not implemented yet.** Restoring an older production snapshot remains blocked until those deletions can be accounted for; never serve restored shopper data when they cannot.
4. Reconcile Shopify tokens, unknown discount/revocation outcomes and paid orders before resuming offers. Retry provider cleanup with the original provider account; preserve its surviving deletion queue.
5. Run live acceptance, resume traffic, record measured data loss/recovery time, and retire old volumes/manual copies under the approved policy.

## Monitoring and incidents

Railway healthchecks gate deployment only. Configure an independent HTTPS probe with a real recipient and verify failure/recovery alerts. Monitor disk space, restarts, write errors, stale backups and overdue reconciliation/privacy work. Authenticated `/api/app` exposes `ai.pendingDeletion`; aggregate cleanup backlog/retry failures are logged without messages/resource IDs. Reporting exposes pending order synchronization.

Keep offers paused when checkout or storage integrity is uncertain. Preserve cleanup/reconciliation records; do not erase the database, replace its key or switch provider accounts to clear errors. Use normal Shopify checkout as the merchant fallback. Avoid logging tokens, request bodies, raw webhooks, full request URLs or chat text.

Host access logs may contain IPs and request metadata. Railway's visible log windows do not prove physical deletion (upgrading can restore older logs). Obtain actual retention/deletion commitments and finalize `/privacy` before release; its current hosting details remain unfinished.

## Current blockers

The observed workspace has an expired trial and the service is offline. Native Railway CLI exits before authentication, so no migration plan was generated/applied. No subscription purchase, deployment, volume/backup setup or production AI activation is claimed. Billing can be handled in the existing Railway account without desktop Computer Use. Support email, provider/hosting terms, deletion replay, restore drill, alert recipient and live Shopify acceptance remain release gates.
