# Deploy and live smoke (T2.3)

Run from the repo root. Keys go in `.env` (never committed). Names are in `.env.example`.

## 1. InsForge (database, photos, worker web)
1. `npx @insforge/cli login`, then create or link the project (`npx @insforge/cli link`), and copy `INSFORGE_BASE_URL`, `INSFORGE_ANON_KEY`, `INSFORGE_API_KEY` into `.env`.
2. Apply our migrations through the REST migrations endpoint: `node --env-file=.env scripts/insforge-migrate.ts` (409 means already applied).
3. Create the public photo bucket: `npx @insforge/cli storage create-bucket photos --public`.
4. Live check that the admin key can run our functions (RLS and EXECUTE grants are unverified on InsForge):
   `curl -s -X POST "$INSFORGE_BASE_URL/api/database/rpc/eyes_agent_by_key_hash" -H "Authorization: Bearer $INSFORGE_API_KEY" -H 'content-type: application/json' -d '{"p_key_hash":"x"}'` must return `[]`, not a permission error.

## 2. MCP server on Cloudflare Containers
The server runs as one container (the repo `Dockerfile`: Node 26, `node apps/mcp/src/main.ts`, port 3000) behind the `eyes-api` Worker in `apps/edge/api`, which also owns the `api.eyes.pictures` custom domain. Account `2c040ec5bc2efe34e60ab5b1b4fd2e99`, container application `eyes-api-eyesserver`.

Run every wrangler command from `apps/edge/api` with `env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx -y wrangler@4 …`: the repo `.env` holds the clef token for the server, which is not allowed to deploy, and wrangler picks it up from the repo root. Wrangler then uses the `wrangler login` OAuth session (needs `containers (write)`). Docker must be running (OrbStack: `orb start`) to build the image.

1. Secrets: every server env var is a Worker secret, and the Durable Object passes all string bindings except `ORIGIN` into the container. Upload them from `.env`, leaving out empty values and `CLICKHOUSE_*` (the local ClickHouse is not reachable from Cloudflare, so the sink stays off), without printing them:
   ```sh
   cd /Users/xiao/tmp/eyes && umask 077 && node -e 'const fs=require("fs");const o={};for(const l of fs.readFileSync(".env","utf8").split("\n")){const m=/^([A-Z_]+)=(.+)$/.exec(l);if(m&&!m[1].startsWith("CLICKHOUSE_"))o[m[1]]=m[2].replace(/^["\x27](.*)["\x27]$/,"$1")}fs.writeFileSync("/tmp/eyes-secrets.json",JSON.stringify(o))'
   cd apps/edge/api && env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx -y wrangler@4 secret bulk /tmp/eyes-secrets.json; rm /tmp/eyes-secrets.json
   ```
   One secret: `env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx -y wrangler@4 secret put NAME`. A secret change starts a new Worker version; restart the container (step 3) for the server to read it.
   Required values include `EYES_PROVIDERS=live`, `EYES_TEST_MODE`, `EYES_LINK_SECRET`, `EYES_OAUTH_SECRET`, `EYES_PUBLIC_API_URL=https://api.eyes.pictures`, `EYES_WORKER_WEB_URL=https://app.eyes.pictures`, all `INSFORGE_*`, `INKBOX_*`, `STRIPE_*`, `PRIMITIVE_*`, and `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (clef classifier and vision).
2. Deploy: `env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx -y wrangler@4 deploy` builds the image (amd64, about 1 minute), pushes it and rolls the container. For the first minute or so after a new image, requests can fail with "no container instance can be provided"; `apps/edge` is in `.dockerignore`, so Worker-only changes do not rebuild or restart the container.
3. Restart the container (new secrets, stuck server): a deploy with a new image restarts it. Without an image change, stop the instance in the Cloudflare dashboard (Workers & Pages > Containers > eyes-api-eyesserver; unverified, not yet needed); the next request or the minute cron starts a fresh one.
4. Check: `curl -s https://api.eyes.pictures/healthz` (every provider `live`, `db` `insforge`), then `EYES_PUBLIC_API_URL=https://api.eyes.pictures pnpm smoke:live`. The container's own URL, useful when `ORIGIN` points elsewhere: `https://eyes-api.jerry-2c0.workers.dev`.
5. Logs: `env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx -y wrangler@4 tail eyes-api` shows the Worker and Durable Object; the server's stdout is in the dashboard (Workers & Pages > eyes-api > Observability, and Containers > eyes-api-eyesserver > Logs). The ops event log at `<public>/ops` is unchanged.

How it stays up and stays single: the `EyesServer` Durable Object (one, named `main`, `max_instances: 1`) starts the container on demand, and a `* * * * *` cron calls its `ensure()` so the container never idles out. The keep-alive sends no HTTP request to the server, so it never shows in the request log or ops metrics. The server's in-memory state (30 s ping re-offer timers, rate-limit buckets, the expiry/payout loop) assumes this one instance and is lost on a container restart, as it was on a local restart. The Worker sets `x-forwarded-for` to `cf-connecting-ip`, so per-IP rate limits see the real client and a client-sent header cannot dodge them.

Older hosts, for reference: the same image runs anywhere with `docker build -t eyes-mcp . && docker run -p 3000:3000 --env-file .env eyes-mcp`; Manufact notes are below.

Ops and ClickHouse settings (any host):
   Ops dashboard: `<public>/ops`, behind the operator allowlist (`ops_allowlist`; migration 015 seeds only placeholders, so add real operators at `/ops/allowlist`, signing in the first time with `EYES_OPS_KEY`). An operator signs in at `/ops/login` with a code sent by text (Inkbox) or email (Primitive); the session cookie lasts 12 h. Optional break-glass: `EYES_OPS_KEY` (32+ random chars, `openssl rand -hex 32`); opening `<public>/ops/<EYES_OPS_KEY>` signs the browser in without a code. Shorter than 32 characters, the server refuses to start. Never post that URL publicly, in a screenshot, an issue or a shared chat; to revoke it set a new key and restart.
   Optional ClickHouse for the ops event log and the Trends charts (Postgres stays the source of truth): set `CLICKHOUSE_URL` (HTTP interface, e.g. `http://127.0.0.1:8123`), `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DATABASE` (default `eyes`), then `node --env-file=.env scripts/clickhouse-migrate.ts` (safe to re-run). Local: `docker run -d --name eyes-ch -p 127.0.0.1:8123:8123 -e CLICKHOUSE_USER=eyes -e CLICKHOUSE_PASSWORD=<random> clickhouse/clickhouse-server:25.8`. Unset, the charts read the Postgres feed and the last 500 events in memory. While ClickHouse is down the server keeps the newest 10,000 events and retries with backoff; `/ops/series` reports how many it dropped.

## 3. Worker web on InsForge Sites
1. `VITE_EYES_API_URL=https://<public api origin> VITE_INKBOX_NUMBER=+1XXXXXXXXXX pnpm --filter @eyes/web-worker build`. On the shared Inkbox line (no dedicated number), also set `VITE_INKBOX_CONNECT="connect @<agent handle>"`: the JOIN page then asks for that text before START. Set `VITE_LIVE_PAYOUTS=true` only when the server has `STRIPE_SECRET_KEY`; without it the JOIN and capture pages say payouts are simulated and show no amounts, matching what the server texts workers.
2. `npx @insforge/cli deployments deploy ./apps/web/worker/dist` (static output; camera and GPS need the HTTPS `*.insforge.site` URL).
3. Or on Cloudflare, with the landing page on the apex: `pnpm --filter @eyes/web-landing build && (cd apps/web/landing && npx wrangler deploy)` serves `eyes.pictures`; build the worker web as above with `VITE_EYES_API_URL=https://api.eyes.pictures`, then `cd apps/web/worker && npx wrangler deploy` serves `app.eyes.pictures`; `api.eyes.pictures` is the `eyes-api` Worker and container from section 2. Set the server's `EYES_PUBLIC_API_URL` and `EYES_WORKER_WEB_URL` to those two names.

## 4. Webhooks
- Inkbox (iMessage line, chosen for cost): subscribe identity `eyes-dispatch` to `imessage.received` at `<public>/webhooks/inkbox`; put the signing key in `INKBOX_WEBHOOK_SIGNING_KEY`. Worker phones must be iPhones. If the console gives a shared router number plus a connect command instead of a dedicated number (the free plan: `inkbox.imessages.getTriageNumber()` returns it, and `inkbox.imessages.listNumbers()` is empty), set `INKBOX_PHONE_NUMBER` to the router number and build the worker web with `VITE_INKBOX_CONNECT`; each worker texts the connect command to the router first, then START. Cold first messages are limited to 159 chars with no links (our offers comply). Inkbox caps agent-initiated conversations at 10 new recipients per hour and 40 per 24 h, but "recipients who message the line first do not consume these first-contact slots": every worker texts START first, so the cap does not apply to Eyes.
- Stripe: two event destinations to `<public>/webhooks/stripe`: "Your account" with `checkout.session.completed` (`STRIPE_WEBHOOK_SECRET`) and "Connected accounts" with `account.updated` (`STRIPE_CONNECT_WEBHOOK_SECRET`). Fund the platform: `node --env-file=.env packages/payments/scripts/fund-platform.ts 100`.
- Primitive: HTTP endpoint webhook to `<public>/webhooks/primitive` (`PRIMITIVE_WEBHOOK_SECRET`); note the assigned domain as `PRIMITIVE_DOMAIN`.

## 5. Live smoke checklist (G1, then G2)
1. `GET <public>/healthz`: every provider `live`, db `insforge`.
2. Each worker phone (iPhone, with Settings > Messages > Send & Receive > Start New Conversations From set to the phone number, not an Apple ID email): JOIN at `<worker web>/`, text START, receive the payout setup link, finish Stripe test onboarding (SMS code 000-000, SSN 222222222, routing 110000000, account 000123456789).
3. Agent: `claude mcp add --transport http eyes <public>/mcp --header "Authorization: Bearer $EYES_API_KEY"` (key from `POST <public>/v1/signup`).
4. Ask about the demo cafe; a nearby phone gets the offer text, replies YES, gets the capture link, takes the photo; Claude's `await_answer` returns the verified answer with `photo_url`.
5. G2: the Stripe dashboard shows the top-up, then the transfer to the worker's connected account; `get_balance` drops by 3.50; "Photograph the house at 123 Oak St" is refused with `unsafe_task`.
6. Record each result in STATUS.md "Live verification" with the time and what was seen.

## Manufact redeploy notes (old host, not in use since T6.11; learned 2026-10-17)

- Merges to GitHub main do not deploy. The server builds from a Manufact-managed mirror (`manufacts/eyes-*`) that `npx mcp-use deploy` uploads to. After a merge: `git pull` on main, then `npx -y mcp-use@2.10.0 deploy --yes --json --dockerfile Dockerfile`.
- The id that `deploy` returns goes to `stopped` within seconds; the real build is the `webhook` deployment created right after it. Watch `npx mcp-use deployments list` for that one to reach `running`.
- Env changes (`servers env set`) apply only on a new deployment: `npx mcp-use deployments restart <full deployment uuid>` (short ids give `deployment_not_found`; get the uuid from `deployments list --json`).
- InsForge migrations must be applied in strictly increasing version order: the API rejects any version older than the latest applied one (`DATABASE_MIGRATION_ALREADY_EXISTS`, "Migration version must be newer than the latest applied migration"). If `007_*` merges before `006_*`, do not run `scripts/insforge-migrate.ts` until `006` is on main, or `006` can never be applied. Applied so far (2026-10-17): 001-019.
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
