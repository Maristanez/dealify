# Railway public-app operations — November 2026

Researched November 18, 2026 against official Railway/Railpack and SQLite documentation. This is a deployment proposal and evidence checklist, not a record of configured production properties. The account observation recorded in `docs/PUBLIC-APP-PLAN.md` is an expired trial, offline `bazaar-chat` service and failed build. No live deployment, backup schedule, restore or monitoring alert was verified here. No secrets were read or exported.

Repository baseline: `railway.json` selects Nixpacks, builds with `pnpm build`, starts the legacy demo with `pnpm start`, and checks `/health`. Public execution is `pnpm start:public`; `.env.public.example` targets Node 24 and `DATABASE_PATH=/data/dealify.sqlite`. `apps/server/src/infra/public-store.js` uses SQLite WAL and AES-256-GCM for record payloads; `shop`, `kind`, `id` and `expires` remain plaintext metadata. Do not describe this as whole-file database encryption. The parent implementation may change these files after this inspection.

## Deployment configuration and the December cutoff

**Migrate before December 1, 2026.** Railway states that existing Config as Code deployments stop supporting `railway.json`/`railway.toml` on that date; new services cannot opt in. Until cutover, file settings override dashboard settings. [Config as Code deprecation](https://docs.railway.com/config-as-code)

Recommended migration sequence:

1. Verify the linked project/environment and resource inventory. Preview `railway config migrate`; generate with `railway config migrate --apply`. Inspect the generated ownership scope and every existing volume/mount.
2. Translate to the public start command and intended readiness path. Run `railway config migrate cutover` only for the intended environment. This clears stored Config File paths; it does not deploy, change variables or move/delete volume data.
3. Run `railway config plan`, reject unintended deletions, then apply the reviewed changes. Omitting resources from whole-project IaC can delete them. A named partial limits ownership when repositories share an environment.
4. Remove the legacy file only after cutover and the replacement settings are applied. A remaining stored path plus a missing file breaks the next build. Even without a stored path, root legacy files are auto-detected until removed or the cutoff.
5. Deploy and verify the effective configuration. Committing `.railway/railway.ts` alone does not apply it; IaC needs CLI/CI plan/apply.

These are documented lifecycle distinctions; no migration command was executed. [IaC migration and ownership](https://docs.railway.com/infrastructure-as-code#migrating-from-config-as-code)

**Secret handling:** ordinary `railway config pull` imports values as `preserve()`. Avoid `--include-variables` (writes decrypted non-sealed values), `--show-values` and `--decrypt-variables`; default plan output redacts values. Install the matching `railway` SDK before evaluating TypeScript IaC. `config apply --json` is a mutation, not a read-only preview; use `config plan --json` for inspection. [CLI reference](https://docs.railway.com/cli/config)

`preserve()` retains an existing Railway value; it does not provision a missing key. Import and retain existing volume resources and mounts. Placement changes, detachments and volume deletion are destructive operations requiring separate review. [IaC reference](https://docs.railway.com/infrastructure-as-code/reference)

## Runtime and persistence

Proposed release settings: repository root build context, Node 24, lockfile-based dependency install, Console build at build time, `pnpm start:public`, one process, and `/data` mounted with the database and WAL files beneath it. Pin Node explicitly: Railpack's `RAILPACK_NODE_VERSION` overrides package version declarations, and the default is the current LTS. Do not infer Node 24 from the repository's broad `>=22` engine constraint. [Railpack Node configuration](https://railpack.com/languages/node/)

Railway's current default builder is Railpack; a Dockerfile is another deliberate runtime option. Confirm the chosen builder and resulting Node version in build evidence rather than carrying forward the legacy Nixpacks choice accidentally. [Build configuration](https://docs.railway.com/builds/build-configuration), [Dockerfiles](https://docs.railway.com/builds/dockerfiles)

Volumes mount at service startup, not build time. Use the absolute database path and check write access. [Volume mounting](https://docs.railway.com/volumes) SQLite schema initialization/migration must occur during startup before readiness; Railway pre-deploy commands run in separate containers without the persistent volume. [Pre-deploy limits](https://docs.railway.com/deployments/pre-deploy-command)

Railway documents one volume per service, no replicas with volumes, and brief redeployment downtime. This matches the single-process pilot but does not establish high availability. Deleted volumes have a 48-hour recovery window before permanent deletion; do not confuse that with application-row deletion. [Volume constraints](https://docs.railway.com/volumes/reference)

## Backups, recovery and deletion

Railway supports volume snapshots including SQLite, manual backup deletion, and schedules with these retention windows: daily every 24 hours/6 days retained; weekly every 7 days/27 days; monthly every 30 days/89 days. Multiple schedules can coexist. Manual backup expiry is not specified on the page. [Backups](https://docs.railway.com/volumes/backups)

Restore is staged for review, then deployed: a replacement volume mounts at the original path; the previous volume remains unmounted, with newer backups still attached to it. Restore works only within the same project/environment. Wiping a volume deletes its backups. Manual backups have a documented 50%-of-volume-size limit. The page describes copy-on-write snapshots but does not establish SQLite application-consistency guarantees or a measured recovery objective. [Restore procedure and limits](https://docs.railway.com/volumes/backups)

**Recommended application backup:** use SQLite's online backup API or `VACUUM INTO` to produce a completed, consistent copy before copying it elsewhere; never copy only the live `.sqlite` file. The WAL is part of persistent database state and separating it can lose committed transactions. [SQLite backup methods](https://www.sqlite.org/backup.html), [WAL handling](https://www.sqlite.org/wal.html)

Proposed pilot policy, requiring operator confirmation and a restore drill:

- Start with daily snapshots and an explicitly bounded application-backup lifecycle. Six days is a proposed platform snapshot window, not proof it is enabled. A daily schedule targets roughly one day of potential loss only if backups succeed; establish a measured recovery time.
- Keep the encryption key in a separately access-controlled recovery store and associate its version with each backup. A usable database copy without its matching key is insufficient; never store key material beside database backups or in build artifacts.
- Restore disposable synthetic data first. Check SQLite integrity, record decryption, tenant separation and durable job state. Keep workers/external calls disabled until old uninstall/redaction requests have been reapplied and Shopify token/settlement state reconciled. Prevent a restore from resurrecting erased records or repeating external side effects.
- Maintain deletion bookkeeping outside the backup being restored; specify when snapshots, manual copies and retained old volumes expire. App-row deletion alone does not erase snapshots. Do not add weekly/monthly retention to the privacy policy without accounting for the longer windows and restore suppression.

## Readiness and continuous monitoring

Railway uses the service `PORT` for healthchecks, accepts a successful `2xx` response, defaults to a 300-second timeout and may send hostname `healthcheck.railway.app`. Its check gates startup traffic only; it is not continuous monitoring. A volume still creates redeploy downtime. [Healthchecks](https://docs.railway.com/deployments/healthchecks)

Recommended readiness contract: unauthenticated, minimal response; succeed only after configuration, database initialization and a bounded read/write check succeed; return 503 on failure or draining. Do not expose credentials, shop identities, database paths or raw error messages. Keep Shopify/AI outages out of this local readiness gate and track them separately so a vendor incident does not cause a restart loop.

Add an external HTTPS probe with a real alert recipient; test a failed probe and recovery. Also monitor restart/crash events, disk capacity, database write errors, overdue webhook/reconciliation/provider-deletion jobs, failed backups and stale backup age. A healthy HTTP response does not prove those asynchronous obligations are progressing. These are recommended checks, not configured services.

## Host logs and remaining evidence

Railway lists log access windows of Free 3 days, Trial/Hobby 7, Pro 30 and Enterprise up to 90. Its note says upgrading can restore logs outside the earlier window, so these numbers are not evidence of irreversible deletion. HTTP logs include path, host, user agent and source IP; stdout sanitization alone does not control all host logs. The reviewed page supplies no subject-specific purge procedure or guaranteed physical-erasure timeline. Obtain those details from Railway before publishing an exact host-log deletion promise. [Logging and retention](https://docs.railway.com/observability/logs)

Recommended app logging: bounded event names, status classes and correlation IDs; no tokens, authorization headers, full request URLs, raw webhooks, chat text or provider response bodies. Test representative failures for accidental disclosure. Review access permissions and any external log destination separately.

Release evidence still missing: funded/operational hosting; selected region and resources; actual secret provisioning; effective Node/build/start/health settings; persistent-volume restart proof; successful and failed readiness behavior; configured backup schedule and latest successful backup; restore integrity/decryption/privacy replay drill; monitoring recipient and delivered alert; host retention/erasure terms; stable HTTPS URL; live Shopify installation and checkout. Local tests and this research cannot mark those complete.
