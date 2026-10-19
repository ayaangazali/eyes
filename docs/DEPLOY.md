# Deploy and live smoke (T2.3)

Run from the repo root. Keys go in `.env` (never committed). Names are in `.env.example`.

## 1. InsForge (database and photos)
1. `npx @insforge/cli login`, then create or link the project (`npx @insforge/cli link`), and copy `INSFORGE_BASE_URL`, `INSFORGE_ANON_KEY`, `INSFORGE_API_KEY` into `.env`.
2. Apply our migrations through the REST migrations endpoint: `node --env-file=.env scripts/insforge-migrate.ts` (409 means already applied).
3. Create the public photo bucket: `npx @insforge/cli storage create-bucket photos --public`.
4. Live check that the admin key can run our functions (RLS and EXECUTE grants are unverified on InsForge):
   `curl -s -X POST "$INSFORGE_BASE_URL/api/database/rpc/eyes_agent_by_key_hash" -H "Authorization: Bearer $INSFORGE_API_KEY" -H 'content-type: application/json' -d '{"p_key_hash":"x"}'` must return `[]`, not a permission error.

## 2. MCP server on Manufact Cloud

Current production (2026-10-18): the actual MCP/API server runs on **Manufact Cloud**, server `eyes-prod`, origin `https://warm-spark-aocdd.run.mcp-use.com`, active deployment `7f7de08a-5412-47c3-b2d7-4a63c9e251c3`, serving source `17ba6b9131d9f7ee916a1503d735422c4f209253`. The public MCP URL remains `https://api.eyes.pictures/mcp`.

Cloudflare's `eyes-api` Worker is a thin forwarder for both `api.eyes.pictures` and `internal.eyes.pictures`. Keep its `ORIGIN` set to `https://warm-spark-aocdd.run.mcp-use.com`. The optional Manufact gateway `https://dark-steel-ofaoa.run.mcp-use.com/mcp` is a separate proxy, not the server host. The landing site and worker app remain on Cloudflare.

### Permanent deployment

The operator deployer runs with `bash /Users/xiao/tmp/eyes-deployer/deployer.sh`. It is already running; do not start a second copy. It watches `origin/jerry/live-setup`, applies database migrations first, then deploys the actual server to Manufact and updates the Cloudflare forwarder. The API pause was removed only after the successful deployment and smoke checks; static-site deployment remains separate.

For API changes, the deployer archives the clean source into a temporary directory, copies the existing `.mcp-use/cloud/link.json`, and embeds the source SHA through the staged Dockerfile. Its pinned mcp-use 2.10.1 CLI runs `deploy <source> --no-github --org 79796193-80be-4b65-a1c7-803b0725b39d --branch jerry/live-setup --dockerfile Dockerfile --json`. The wrapper loads local `/Users/xiao/tmp/eyes-manufact/.env.manufact` without passing `--env-file` to the deploy command; production secrets stay on Manufact. It waits for the matching managed deployment and runtime SHA before advancing checkpoints.

The edge-only command, run from the deployer's clean `apps/edge/api` directory, is `env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx -y wrangler@4.151.1 deploy --containers-rollout=none --keep-vars --var ORIGIN:https://warm-spark-aocdd.run.mcp-use.com --var EYES_COMMIT:17ba6b9131d9f7ee916a1503d735422c4f209253`. The deployer substitutes the current source SHA on later deployments. Do not use the historical container commands below for production.

Verified 2026-10-18: source `17ba6b9131d9f7ee916a1503d735422c4f209253`, Worker version `81c8edb5-a943-414a-a9fa-bc1e64b12aea`, migration 034 applied first (201), Cloudflare container inactive. Both OAuth protected-resource paths return `resource: https://api.eyes.pictures/mcp` with identity and actual gzip responses; the authorization-server issuer and unauthenticated MCP `WWW-Authenticate` metadata URL remain public. Ops `/login` returns 200. MCP initialization, 10 tools, free quote and widget domains passed. Latest keyed smoke: 12 PASS, signup and paid ask skipped; earlier unkeyed smoke: 13 PASS. Evidence: `/Users/xiao/tmp/eyes-hosting-evidence` and `/Users/xiao/tmp/eyes-deployer/runs/17ba6b9131d9.{manual,finish}.log`.

Server secrets belong in the Manufact environment, not in committed files. Keep `EYES_PUBLIC_API_URL=https://api.eyes.pictures`, `EYES_WORKER_WEB_URL=https://app.eyes.pictures`, and the existing provider credentials. `EDGE_SECRET` must match between the Manufact server and the Cloudflare Worker so the server can trust forwarded host and client-IP headers.

### Checks after deployment

1. `curl -s https://api.eyes.pictures/healthz` checks the public route.
2. Review the deployer's smoke log: it reuses a private probe key, skips signup and paid task creation, and must pass before checkpoints advance.
3. Confirm OAuth discovery names `https://api.eyes.pictures/mcp` as the protected resource and `https://api.eyes.pictures` as the authorization server, not the Manufact origin.
4. Confirm `https://internal.eyes.pictures/login` still reaches the ops sign-in page.

Historical hosting note: the API ran on Cloudflare Containers before this cutover. The 2026-10-18 Cloudflare rollout measurement was about two minutes; that is not a Manufact deployment timing or verification result. The legacy container path remains in `apps/edge/api`, but is not the current server host.

Ops and ClickHouse settings (any host):
   Ops dashboard: `https://internal.eyes.pictures` (its own public host, forwarded by `eyes-api` to the same Manufact server). The server derives it from `EYES_PUBLIC_API_URL` by swapping `api.` for `internal.`; set `EYES_OPS_URL` to use another name. On that host the root is the dashboard and nothing else of the API answers; on the API host `/ops*` answers 301 to it; on loopback `/ops` still works for local runs. It sits behind the operator allowlist (`ops_allowlist`; migration 015 seeds only placeholders, so add real operators at `/allowlist`, signing in the first time with `EYES_OPS_KEY`). An operator signs in at `/login` with a code sent by text (Inkbox) or email (Primitive); the session cookie lasts 12 h. Optional break-glass: `EYES_OPS_KEY` (32+ random chars, `openssl rand -hex 32`); opening `https://internal.eyes.pictures/<EYES_OPS_KEY>` signs the browser in without a code. Shorter than 32 characters, the server refuses to start. Never post that URL publicly, in a screenshot, an issue or a shared chat; to revoke it set a new key and restart.
   Optional ClickHouse for the ops event log and the Trends charts (Postgres stays the source of truth): set `CLICKHOUSE_URL` (HTTP interface, e.g. `http://127.0.0.1:8123`), `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE` (default `eyes`), then `node --env-file=.env scripts/clickhouse-migrate.ts` (safe to re-run). Local: `docker run -d --name eyes-ch -p 127.0.0.1:8123:8123 -e CLICKHOUSE_USER=eyes -e CLICKHOUSE_PASSWORD=<random> clickhouse/clickhouse-server:25.8`. Unset, the charts read the Postgres feed and the last 500 events in memory. While ClickHouse is down the server keeps the newest 10,000 events and retries with backoff; `/ops/series` reports how many it dropped.

## 3. Static worker web and landing on Cloudflare

1. Build the worker app with `VITE_EYES_API_URL=https://api.eyes.pictures` and the existing private environment values. The operator deployer uses `VITE_INKBOX_CONNECT="connect @eyes-dispatch"` and `VITE_LIVE_PAYOUTS=true` for the current deployment; only enable live-payout copy when the server has Stripe configured.
2. The deployer builds with `pnpm --filter @eyes/web-worker build`, then runs `env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx -y wrangler@4 deploy` from `apps/web/worker`. This serves `https://app.eyes.pictures`.
3. For the landing page, it runs `pnpm --filter @eyes/web-landing build`, then the same Wrangler command from `apps/web/landing`. This serves `https://eyes.pictures`.

Historical worker-page hosting: `npx @insforge/cli deployments deploy ./apps/web/worker/dist` deployed the static output to InsForge Sites. The dated `*.insforge.site` results in STATUS refer to that earlier deployment, not the current public app.

## 4. Webhooks
- Inkbox (iMessage line, chosen for cost): subscribe identity `eyes-dispatch` to `imessage.received` at `<public>/webhooks/inkbox`; put the signing key in `INKBOX_WEBHOOK_SIGNING_KEY`. Worker phones must be iPhones. If the console gives a shared router number plus a connect command instead of a dedicated number (the free plan: `inkbox.imessages.getTriageNumber()` returns it, and `inkbox.imessages.listNumbers()` is empty), set `INKBOX_PHONE_NUMBER` to the router number and build the worker web with `VITE_INKBOX_CONNECT`; each worker texts the connect command to the router first, then START. Cold first messages are limited to 159 chars with no links (our offers comply). Inkbox caps agent-initiated conversations at 10 new recipients per hour and 40 per 24 h, but "recipients who message the line first do not consume these first-contact slots": every worker texts START first, so the cap does not apply to Eyes.
- Stripe: two event destinations to `<public>/webhooks/stripe`: "Your account" with `checkout.session.completed` (`STRIPE_WEBHOOK_SECRET`) and "Connected accounts" with `account.updated` (`STRIPE_CONNECT_WEBHOOK_SECRET`). Fund the platform: `node --env-file=.env packages/payments/scripts/fund-platform.ts 100`.
- Primitive: HTTP endpoint webhook to `<public>/webhooks/primitive` (`PRIMITIVE_WEBHOOK_SECRET`); note the assigned domain as `PRIMITIVE_DOMAIN`. A new Primitive org can only send to Primitive-managed domains, its own members and addresses that emailed it first, so agent answers go out but an owner's control-link email to a normal domain (gmail.com) is refused with `403 recipient_not_allowed`; so Eyes sends what the gate refuses (owner links, ops sign-in codes, worker email) from the Inkbox dispatcher mailbox instead (`INKBOX_API_KEY` + `INKBOX_AGENT_HANDLE`, no extra setting; Inkbox allows 100 new recipients a day per org and adds a "Sent via Inkbox" footer on the free plan), and `/status` shows Email as "live (first contact via Inkbox …)". Without Inkbox those sends fail, Eyes notes it once per agent as an info event in the ops log (never the Errors tab), and `/status` says "replies only". Once Primitive grants the org `send_to_any_domain` (check `npx -y primitive account show`, field `entitlements`), set `PRIMITIVE_SEND_ANY_DOMAIN=1` and redeploy.

## 5. Live smoke checklist (G1, then G2)
1. `GET <public>/healthz`: every provider `live`, db `insforge`.
2. Each worker phone (iPhone, with Settings > Messages > Send & Receive > Start New Conversations From set to the phone number, not an Apple ID email): JOIN at `<worker web>/`, text START, receive the payout setup link, finish Stripe test onboarding (SMS code 000-000, SSN 222222222, routing 110000000, account 000123456789).
3. Agent: `claude mcp add --transport http eyes <public>/mcp --header "Authorization: Bearer $EYES_API_KEY"` (key from `POST <public>/v1/signup`).
4. Ask about the demo cafe; a nearby phone gets the offer text, replies YES, gets the capture link, takes the photo; Claude's `await_answer` returns the verified answer with `photo_url`.
5. G2: the Stripe dashboard shows the top-up, then the transfer to the worker's connected account; `get_balance` drops by 3.50; "Photograph the house at 123 Oak St" is refused with `unsafe_task`.
6. Record each result in STATUS.md "Live verification" with the time and what was seen.

## Ad hoc releases (iPhone app)
- `i098/eyes-ios-release` (public) runs `pnpm adhoc:release` from `ayaangazali/eyes` on a GitHub macOS runner. It registers the UDIDs with Apple, builds, uploads `Eyes.ipa` and `manifest.plist` to the `apps` bucket and texts the workers.
- Trigger: GitHub never started the workflow's 5-minute schedule, so the `eyes-monitor` Worker (see Alerts) starts it. Each minute it counts `worker_devices` rows with `released_at` null; when there are any, no release run is queued or running, and it has not dispatched in the last 10 minutes, it sends `repository_dispatch` (`device-registered`). Worker secrets: `RELEASE_DISPATCH_TOKEN` (fine-grained, i098, Contents read and write on that repo only, expires 2027-10-18) and `INSFORGE_API_KEY`; without the token it skips this.
- Release repo secrets: `RELEASE_ENV` (InsForge, Inkbox, App Store Connect key and issuer ids), `ASC_P8`, `DIST_P12` + `P12_PASSWORD` (Apple Distribution certificate). Rotate `RELEASE_ENV` whenever those `.env` values change.
- Test without side effects: `gh workflow run release.yml -R i098/eyes-ios-release -f dry_run=true`, or set the repo variable `DRY_RUN=true` so scheduled runs are dry runs too; delete it afterwards (`gh variable delete DRY_RUN -R i098/eyes-ios-release`).
- The API's own dispatch (`EYES_RELEASE_DISPATCH_TOKEN` as an API secret) is optional and unset; the monitor covers it within a minute.

## Historical Manufact deployment notes (2026-10-17; not the current runbook)

- At that time, merges to GitHub main did not deploy. The server built from a Manufact-managed mirror (`manufacts/eyes-*`) uploaded by `npx mcp-use deploy`. The recorded command was `npx -y mcp-use@2.10.0 deploy --yes --json --dockerfile Dockerfile`; do not apply this old-server procedure to current production.
- The id that `deploy` returns goes to `stopped` within seconds; the real build is the `webhook` deployment created right after it. Watch `npx mcp-use deployments list` for that one to reach `running`.
- Env changes (`servers env set`) apply only on a new deployment: `npx mcp-use deployments restart <full deployment uuid>` (short ids give `deployment_not_found`; get the uuid from `deployments list --json`).
- InsForge migrations must be applied in strictly increasing version order: the API rejects any version older than the latest applied one (`DATABASE_MIGRATION_ALREADY_EXISTS`, "Migration version must be newer than the latest applied migration"). If `007_*` merges before `006_*`, do not run `scripts/insforge-migrate.ts` until `006` is on main, or `006` can never be applied. Applied so far (2026-10-17): 001-020.
- Never set `EYES_FAKE_WEBHOOKS=1` on a deployed server. It exists only so local tests can send fake-signed Stripe webhooks; on a deploy with fake payments it would let anyone credit balances and mark workers onboarded (fixed in PR #56, which closes the route unless this flag is set).

## Roll back to the Mac

Use this when the container is broken and a fix is not quick. It runs the server on this Mac again and sends `api.eyes.pictures` (and with it every provider webhook, all of which point at `https://api.eyes.pictures/webhooks/<x>`) to the Inkbox tunnel. Each process runs in its own session (`os.setsid`), so it outlives the shell that started it. Agents share one uid, so stop processes by verified PID only, never `pkill -f`.

1. Start the server on `:3000` (first check `lsof -nP -iTCP:3000 -sTCP:LISTEN` is empty, or `kill` that PID):
   ```sh
   cd /Users/xiao/tmp/eyes && (nohup python3 -c 'import os; os.setsid(); os.execvp("env", ["env", "-u", "ANTHROPIC_API_KEY", "node", "--env-file=.env", "apps/mcp/src/main.ts"])' >> /tmp/eyes-mcp.log 2>&1 &)
   ```
   Check: `tail -12 /tmp/eyes-mcp.log` shows each `provider …: live` line and `Eyes MCP listening on http://0.0.0.0:3000/mcp`.
2. Start the tunnel `https://eyes-dispatch.inkboxwire.com` to it:
   ```sh
   cd /Users/xiao/tmp/eyes/packages/comms && (nohup python3 -c 'import os; os.setsid(); os.execvp("node", ["node", "--env-file=../../.env", "--input-type=module", "-e", "import { Inkbox } from \"@inkbox/sdk\"; import { connect } from \"@inkbox/sdk/tunnels/connect\"; const l = await connect(new Inkbox({ apiKey: process.env.INKBOX_API_KEY }), { name: process.env.INKBOX_AGENT_HANDLE, forwardTo: \"http://127.0.0.1:3000\" }); console.log(\"tunnel up https://eyes-dispatch.inkboxwire.com\"); await l.wait();"])' >> /tmp/eyes-tunnel.log 2>&1 &)
   ```
   Check: `curl -s https://eyes-dispatch.inkboxwire.com/healthz` returns the healthz JSON.
3. Point the Worker at the tunnel (the container keeps running but gets no traffic except via workers.dev):
   ```sh
   cd /Users/xiao/tmp/eyes/apps/edge/api && env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx -y wrangler@4 deploy --var ORIGIN:https://eyes-dispatch.inkboxwire.com
   ```
4. `EYES_PUBLIC_API_URL=https://api.eyes.pictures pnpm smoke:live` passes.

While both run, the container's expiry/payout loop also runs; that is safe (expiry is one DB call, payouts use DB leases and Stripe idempotency keys), but the Mac server's in-memory timers and rate limits are separate from the container's. Back to the container: plain `deploy` (step 3 without `--var`), then stop the tunnel and server PIDs.

## Alerts

Uptime alerts run from a separate Worker, `eyes-monitor` (`apps/edge/monitor`), so they still fire when the API server moves or dies.

1. Every minute it checks `https://api.eyes.pictures/healthz`. Healthy = HTTP 200, `ok` true, every provider `live`, `db` `insforge`.
2. Two failed checks in a row send "Eyes API is down: <reason>". The next healthy check sends "Eyes API is back up (down N min)".
3. Channel: Inkbox iMessage to `ALERT_PHONE`. `ALERT_PHONE`, `INKBOX_API_KEY` and `INKBOX_AGENT_HANDLE` are Worker secrets, set with `printf %s '<number>' | npx -y wrangler@4 secret put <NAME>` in `apps/edge/monitor`, and never written to files.
4. Deploy: `cd apps/edge/monitor && CLOUDFLARE_ACCOUNT_ID=2c040ec5bc2efe34e60ab5b1b4fd2e99 npx -y wrangler@4 deploy`. The output must show `schedule: * * * * *`.
5. Reset state after a test: `npx -y wrangler@4 kv key delete state --binding EYES_MONITOR --remote` (run in `apps/edge/monitor`).
