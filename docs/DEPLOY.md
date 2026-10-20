# Deploy and live smoke (T2.3)

Run from the repo root. Keys go in `.env` (never committed). Names are in `.env.example`.

## 1. InsForge (database and photos)
1. `npx @insforge/cli login`, then create or link the project (`npx @insforge/cli link`), and copy `INSFORGE_BASE_URL`, `INSFORGE_ANON_KEY`, `INSFORGE_API_KEY` into `.env`.
2. Apply our migrations through the REST migrations endpoint: `node --env-file=.env scripts/insforge-migrate.ts` (409 means already applied).
   Use all ordered files in [`packages/db/migrations`](../packages/db/migrations), not a fixed migration range.
   Check the target database's applied migrations separately; repository files do not prove what production has applied.
3. Create the public photo bucket: `npx @insforge/cli storage create-bucket photos --public`.
4. Live check that the admin key can run our functions (RLS and EXECUTE grants are unverified on InsForge):
   `curl -s -X POST "$INSFORGE_BASE_URL/api/database/rpc/eyes_agent_by_key_hash" -H "Authorization: Bearer $INSFORGE_API_KEY" -H 'content-type: application/json' -d '{"p_key_hash":"x"}'` must return `[]`, not a permission error.

## 2. MCP server on Manufact Cloud

Current production: the MCP/API application runs on **Manufact Cloud**, server `eyes-prod`, origin `https://warm-spark-aocdd.run.mcp-use.com`. New MCP connections use `https://mcp.eyes.pictures/mcp`; `https://api.eyes.pictures/mcp` remains supported for legacy clients, and REST/uploads/webhooks stay at `https://api.eyes.pictures`.

Cloudflare's `eyes-api` Worker forwards `mcp.eyes.pictures`, `api.eyes.pictures` and `internal.eyes.pictures` to the same Manufact `ORIGIN`. The optional Manufact gateway is a separate proxy, not the application host. Landing and worker pages remain on Cloudflare.

### Dedicated MCP domain: live

`https://mcp.eyes.pictures/mcp` is **live, with ChatGPT and Claude configured there**. The current registry has 13 model-visible tools plus app-only `confirm_ask`. The shared card resource is `ui://eyes/confirmation-card.html`; the legacy React-view build is removed. Not every third-party connector has migrated; existing API-host and gateway configurations remain supported.

The explicit-confirmation tool contract uses a new resource URI. After publishing, refresh/rescan tool metadata in the existing app draft and reconnect clients if needed, then open a new quote. Old rendered cards are not retroactively updated; their interactive `ask_eyes` calls remain read-only. Reuse existing reviewer credentials; do not rotate keys for this cutover.

The verified deployment sets optional `EYES_PUBLIC_MCP_URL=https://mcp.eyes.pictures/mcp`; keep `EYES_PUBLIC_API_URL=https://api.eyes.pictures`. It separates MCP/OAuth/card metadata from REST URLs. The normalized, trusted edge host selects the matching metadata: existing API-host connectors retain their API issuer and card origins. Provisioning and deployment belong to the domain owner, not this documentation change.

Historical domain-owner verification (2026-10-18 11:07 UTC): **29/29 checks passed** on deployed source `d6c40a58565f49a912405870f31af148eb8b12e3`.
The operator retained local evidence in `mcp-domain-public-dns-runtime-evidence.json` and DNS context in `mcp-domain-dns-evidence.json`.
These files are not in this repository.
This predates the current 13-tool registry and is not a fresh client-visual check.

Earlier verified readiness (same 11:07 UTC snapshot):

1. Both hosts passed TLS/health, OAuth registration and PKCE token exchange; both expose all 12 tools and a free quote leaves the balance unchanged.
2. New-host discovery advertises resource `https://mcp.eyes.pictures/mcp`, issuer `https://mcp.eyes.pictures`, and authorize/token/registration URLs on that host; the 401 challenge points to its metadata.
3. Widget metadata from `resources/list` and `resources/read` matches the new connector's ChatGPT origin and Claude hash. Existing API-host OAuth and card metadata remain unchanged. This verifies server resources, not an actual ChatGPT or Claude client migration.
4. API unauthenticated REST/upload/webhook rejection checks passed. No existing connector or optional gateway configuration was changed.

At that verification time, public DNS lookup preserved the original Host/SNI and TLS validation without hardcoded IPs or a TLS bypass; local macOS and Google resolvers still held negative results. This is historical DNS evidence, not a current outage claim. ChatGPT card protocol/live API checks are verified. Follow-up visual checks on the operator's test accounts were quota-blocked on 2026-10-18; this is not a general client limitation.

### Permanent operator deployment

The operator's deploy script runs as service `eyes-manufact-deployer`.
It is already running; do not start a second copy.
Its `api-paused` sentinel was removed after successful authenticated smoke checks.
It reads `origin/jerry/live-setup` into a clean archive, applies database migrations first, and deploys the API to Manufact rather than Cloudflare Containers.

The script copies the existing `.mcp-use/cloud/link.json` and stages the source SHA in the Dockerfile.
It uses pinned `mcp-use@2.10.1` with `deploy <source> --no-github --org <organization-id> --branch jerry/live-setup --dockerfile Dockerfile --json`.
The operator supplies the existing Manufact organization ID.
Existing server environment is preserved; it does not pass `--env-file` to deploy.
It waits for the matching deployment and runtime SHA before advancing checkpoints.
Static-site deployment continues through the operator loop.

The edge-only update runs from the clean `apps/edge/api` directory: `env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx -y wrangler@4.151.1 deploy --containers-rollout=none --keep-vars --var ORIGIN:https://warm-spark-aocdd.run.mcp-use.com --var EYES_COMMIT:<sha>`. The deployer substitutes the current source SHA. Do not use the historical container commands below for production.

Server secrets belong in the Manufact environment, not in committed files. Keep `EYES_PUBLIC_API_URL=https://api.eyes.pictures`, `EYES_WORKER_WEB_URL=https://app.eyes.pictures`, and the existing provider credentials. `EDGE_SECRET` must match between the Manufact server and the Cloudflare Worker so the server can trust forwarded host and client-IP headers.

### Post-deploy checks

1. `curl -s https://api.eyes.pictures/healthz` checks the public route.
2. Review the deployer's smoke log: it reuses a private probe key, skips signup and paid task creation, and must pass before checkpoints advance.
3. Confirm OAuth discovery names `https://api.eyes.pictures/mcp` as the protected resource and `https://api.eyes.pictures` as the authorization server, not the Manufact origin.
4. Confirm `https://internal.eyes.pictures/login` still reaches the ops sign-in page.

Earlier hosting verification (before the current 13-tool registry): protected-resource metadata and authentication challenge matched the public host; the Cloudflare edge forwarded to Manufact with its container inactive. Ops sign-in, MCP initialization, the then-current 10 tools, free quote and widget domains passed. The dated evidence is historical, not a current full-client visual result.

Historical hosting note: Cloudflare Containers was a former API host. Its dated rollout measurements and procedures are retained only as history, not as a supported recovery path for the current Manufact-hosted application.

Ops and ClickHouse settings (any host):
   Ops dashboard: `https://internal.eyes.pictures` (its own public host, forwarded by `eyes-api` to the same Manufact server). The server derives it from `EYES_PUBLIC_API_URL` by swapping `api.` for `internal.`; set `EYES_OPS_URL` to use another name. On that host the root is the dashboard and nothing else of the API answers; on the API host `/ops*` answers 301 to it; on loopback `/ops` still works for local runs. It sits behind the operator allowlist (`ops_allowlist`; migration 015 seeds only placeholders, so add real operators at `/allowlist`, signing in the first time with `EYES_OPS_KEY`). An operator signs in at `/login` with a code sent by text (Inkbox) or email (Primitive); the session cookie lasts 12 h. Optional break-glass: `EYES_OPS_KEY` (32+ random chars, `openssl rand -hex 32`); opening `https://internal.eyes.pictures/<EYES_OPS_KEY>` signs the browser in without a code. Shorter than 32 characters, the server refuses to start. Never post that URL publicly, in a screenshot, an issue or a shared chat; to revoke it set a new key and restart.
   Optional ClickHouse for the ops event log and the Trends charts (Postgres stays the source of truth): set `CLICKHOUSE_URL` (HTTP interface, e.g. `http://127.0.0.1:8123`), `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE` (default `eyes`), then `node --env-file=.env scripts/clickhouse-migrate.ts` (safe to re-run). Local: `docker run -d --name eyes-ch -p 127.0.0.1:8123:8123 -e CLICKHOUSE_USER=eyes -e CLICKHOUSE_PASSWORD=<random> clickhouse/clickhouse-server:25.8`. Unset, the charts read the Postgres feed and the last 500 events in memory. While ClickHouse is down the server keeps the newest 10,000 events and retries with backoff; `/ops/series` reports how many it dropped.

## 3. Static worker web and landing on Cloudflare

1. Build the worker app with `VITE_EYES_API_URL=https://api.eyes.pictures` and existing private environment values. The current dispatcher is `connect @eyes-dispatch`.
   Keep `VITE_LIVE_PAYOUTS=false` while Stripe uses test keys. This static build flag controls worker notices, previews, and capture wording.
   The API derives `live_payouts` from `EYES_PROVIDERS=live` and an `sk_live_` or `rk_live_` key. A test key never enables real payout wording or setup.
   `/status` identifies test payments. `/healthz` keeps reporting provider availability, so test keys do not create a false outage alert.
   Set `VITE_LIVE_PAYOUTS=true` only when the API uses live payouts, then rebuild the worker site.
   This change follows the default in issue #180. It does not change Stripe settings, keys, or the deployed build.
2. The deployer builds with `pnpm --filter @eyes/web-worker build`, then runs `env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx -y wrangler@4 deploy` from `apps/web/worker`. This serves `https://app.eyes.pictures`.
3. For the landing page, it runs `pnpm --filter @eyes/web-landing build`, then the same Wrangler command from `apps/web/landing`. This serves `https://eyes.pictures`.

Historical worker-page hosting: `npx @insforge/cli deployments deploy ./apps/web/worker/dist` deployed the static output to InsForge Sites. The dated `*.insforge.site` results in STATUS refer to that earlier deployment, not the current public app.

## 4. Webhooks

For this section, `<public>` remains `https://api.eyes.pictures`; the MCP-domain split does not move provider webhooks.

- Inkbox (iMessage line, chosen for cost): subscribe identity `eyes-dispatch` to `imessage.received` at `<public>/webhooks/inkbox`; put the signing key in `INKBOX_WEBHOOK_SIGNING_KEY`. Worker phones must be iPhones. If the console gives a shared router number plus a connect command instead of a dedicated number (the free plan: `inkbox.imessages.getTriageNumber()` returns it, and `inkbox.imessages.listNumbers()` is empty), set `INKBOX_PHONE_NUMBER` to the router number and build the worker web with `VITE_INKBOX_CONNECT`; each worker texts the connect command to the router first, then START. Cold first messages are limited to 159 chars with no links (our offers comply). Inkbox caps agent-initiated conversations at 10 new recipients per hour and 40 per 24 h, but "recipients who message the line first do not consume these first-contact slots": every worker texts START first, so the cap does not apply to Eyes.
- Stripe: two event destinations to `<public>/webhooks/stripe`: "Your account" with `checkout.session.completed` (`STRIPE_WEBHOOK_SECRET`) and "Connected accounts" with `account.updated` (`STRIPE_CONNECT_WEBHOOK_SECRET`). Fund the platform: `node --env-file=.env packages/payments/scripts/fund-platform.ts 100`.
- Primitive: signed inbound webhook remains at `<public>/webhooks/primitive`, with `PRIMITIVE_WEBHOOK_SECRET` and `PRIMITIVE_DOMAIN`. Outbound DNS and one owner Gmail delivery are verified; unrestricted domain sending remains disabled. First-contact owner/ops/worker delivery can fall back to Inkbox. External custom-alias SPF remains unresolved; do not claim all email delivery paths work.

## 5. Live smoke checklist (G1, then G2)
1. `GET <public>/healthz`: every provider `live`, db `insforge`.
2. Each worker phone must use its phone number for iMessage. JOIN at `<worker web>/` and text START.
   Test keys intentionally provide no payout setup link. Workers see that no real money moves.
3. Agent: connect to `https://mcp.eyes.pictures/mcp` with an existing key or the web OAuth flow; signup and all REST calls remain under `https://api.eyes.pictures`.
4. Ask about the demo cafe; a nearby phone gets the offer text, replies YES, gets the capture link, takes the photo; Claude's `await_answer` returns the verified answer with `photo_url`.
5. Check the Stripe test top-up and the Eyes ledger. The old G2 onboarding-and-transfer flow is disabled for new workers on test keys.
   Existing test accounts can still receive test transfers; none move real money.
6. Record each result in STATUS.md "Live verification" with the time and what was seen.

## Ad hoc releases (iPhone app)

Current iPhone distribution is ad hoc, not TestFlight. The native app remains connected across task photos. The worker page's three-second post-install fill/disabled timer is a grace period, not OS installation detection. Email setup is optional: **Use iMessage only** skips it.
- `i098/eyes-ios-release` (public) runs `pnpm adhoc:release` from `ayaangazali/eyes` on a GitHub macOS runner. It registers the UDIDs with Apple, builds, uploads `Eyes.ipa` and `manifest.plist` to the `apps` bucket and texts the workers.
- Trigger: GitHub never started the workflow's 5-minute schedule, so the `eyes-monitor` Worker (see Alerts) starts it. Each minute it counts `worker_devices` rows with `released_at` null; when there are any, no release run is queued or running, and it has not dispatched in the last 10 minutes, it sends `repository_dispatch` (`device-registered`). Worker secrets: `RELEASE_DISPATCH_TOKEN` (fine-grained, i098, Contents read and write on that repo only, expires 2027-10-18) and `INSFORGE_API_KEY`; without the token it skips this.
- Release repo secrets: `RELEASE_ENV` (InsForge, Inkbox, App Store Connect key and issuer ids), `ASC_P8`, `DIST_P12` + `P12_PASSWORD` (Apple Distribution certificate). Rotate `RELEASE_ENV` whenever those `.env` values change.
- Test without side effects: `gh workflow run release.yml -R i098/eyes-ios-release -f dry_run=true`, or set the repo variable `DRY_RUN=true` so scheduled runs are dry runs too; delete it afterwards (`gh variable delete DRY_RUN -R i098/eyes-ios-release`).
- The API's own dispatch (`EYES_RELEASE_DISPATCH_TOKEN` as an API secret) is optional and unset; the monitor covers it within a minute.

## Historical Manufact deployment notes (2026-10-17; not the current runbook)

- At that time, merges to GitHub main did not deploy. The server built from a Manufact-managed mirror (`manufacts/eyes-*`) uploaded by `npx mcp-use deploy`. The recorded command was `npx -y mcp-use@2.10.0 deploy --yes --json --dockerfile Dockerfile`; do not apply this old-server procedure to current production.
- The id that `deploy` returns goes to `stopped` within seconds; the real build is the `webhook` deployment created right after it. Watch `npx mcp-use deployments list` for that one to reach `running`.
- Env changes (`servers env set`) apply only on a new deployment: `npx mcp-use deployments restart <full deployment uuid>` (short ids give `deployment_not_found`; get the uuid from `deployments list --json`).
- Apply InsForge migrations in strictly increasing version order.
  The API rejects older versions with `DATABASE_MIGRATION_ALREADY_EXISTS`: "Migration version must be newer than the latest applied migration".
  If `007_*` merges before `006_*`, do not run `scripts/insforge-migrate.ts` until `006` is on main.
  Otherwise, `006` can never be applied.
  Use the migration files and target database history described in section 1, not the old deployment snapshot.
- Never set `EYES_FAKE_WEBHOOKS=1` on a deployed server. It exists only so local tests can send fake-signed Stripe webhooks; on a deploy with fake payments it would let anyone credit balances and mark workers onboarded (fixed in PR #56, which closes the route unless this flag is set).

## Historical rollback-to-Mac procedure

The procedure below predates current Manufact hosting. It is retained as history, not the current recovery command. Restore the last verified Manufact deployment with operator approval; do not silently move the API, MCP host or webhooks to a local tunnel.

For these historical commands, set `EYES_REPO_ROOT="$PWD"` from the repository root before changing directories.

1. Start the server on `:3000` (first check `lsof -nP -iTCP:3000 -sTCP:LISTEN` is empty, or `kill` that PID):
   ```sh
   cd "$EYES_REPO_ROOT" && (nohup python3 -c 'import os; os.setsid(); os.execvp("env", ["env", "-u", "ANTHROPIC_API_KEY", "node", "--env-file=.env", "apps/mcp/src/main.ts"])' >> /tmp/eyes-mcp.log 2>&1 &)
   ```
   Check: `tail -12 /tmp/eyes-mcp.log` shows each `provider …: live` line and `Eyes MCP listening on http://0.0.0.0:3000/mcp`.
2. Start the tunnel `https://eyes-dispatch.inkboxwire.com` to it:
   ```sh
   cd "$EYES_REPO_ROOT/packages/comms" && (nohup python3 -c 'import os; os.setsid(); os.execvp("node", ["node", "--env-file=../../.env", "--input-type=module", "-e", "import { Inkbox } from \"@inkbox/sdk\"; import { connect } from \"@inkbox/sdk/tunnels/connect\"; const l = await connect(new Inkbox({ apiKey: process.env.INKBOX_API_KEY }), { name: process.env.INKBOX_AGENT_HANDLE, forwardTo: \"http://127.0.0.1:3000\" }); console.log(\"tunnel up https://eyes-dispatch.inkboxwire.com\"); await l.wait();"])' >> /tmp/eyes-tunnel.log 2>&1 &)
   ```
   Check: `curl -s https://eyes-dispatch.inkboxwire.com/healthz` returns the healthz JSON.
3. Point the Worker at the tunnel (the container keeps running but gets no traffic except via workers.dev):
   ```sh
   cd "$EYES_REPO_ROOT/apps/edge/api" && env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx -y wrangler@4 deploy --var ORIGIN:https://eyes-dispatch.inkboxwire.com
   ```
4. `EYES_PUBLIC_API_URL=https://api.eyes.pictures pnpm smoke:live` passes.

While both run, the container's expiry/payout loop also runs; that is safe (expiry is one DB call, payouts use DB leases and Stripe idempotency keys), but the Mac server's in-memory timers and rate limits are separate from the container's. Back to the container: plain `deploy` (step 3 without `--var`), then stop the tunnel and server PIDs.

## Alerts

Uptime alerts run from a separate Worker, `eyes-monitor` (`apps/edge/monitor`), so they still fire when the API server moves or dies.

1. Every minute it checks `https://api.eyes.pictures/healthz`. Healthy = HTTP 200, `ok` true, every provider `live`, `db` `insforge`.
   HTTP 503 with `{"ok":false}` means the database read failed or exceeded two seconds.
   Concurrent probes share one unfinished read to avoid filling the database connection pool.
2. Two failed checks in a row send "Eyes API is down: <reason>". The next healthy check sends "Eyes API is back up (down N min)".
3. Channel: Inkbox iMessage to `ALERT_PHONE`. `ALERT_PHONE`, `INKBOX_API_KEY` and `INKBOX_AGENT_HANDLE` are Worker secrets, set with `printf %s '<number>' | npx -y wrangler@4 secret put <NAME>` in `apps/edge/monitor`, and never written to files.
4. Deploy: `cd apps/edge/monitor && CLOUDFLARE_ACCOUNT_ID="<account-id>" npx -y wrangler@4 deploy`.
   Substitute the operator's existing Cloudflare account ID.
   The output must show `schedule: * * * * *`.
5. Reset state after a test: `npx -y wrangler@4 kv key delete state --binding EYES_MONITOR --remote` (run in `apps/edge/monitor`).
