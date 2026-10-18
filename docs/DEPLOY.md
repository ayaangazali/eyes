# Deploy and live smoke (T2.3)

Run from the repo root. Keys go in `.env` (never committed). Names are in `.env.example`.

## 1. InsForge (database, photos, worker web)
1. `npx @insforge/cli login`, then create or link the project (`npx @insforge/cli link`), and copy `INSFORGE_BASE_URL`, `INSFORGE_ANON_KEY`, `INSFORGE_API_KEY` into `.env`.
2. Apply our migrations through the REST migrations endpoint: `node --env-file=.env scripts/insforge-migrate.ts` (409 means already applied).
3. Create the public photo bucket: `npx @insforge/cli storage create-bucket photos --public`.
4. Live check that the admin key can run our functions (RLS and EXECUTE grants are unverified on InsForge):
   `curl -s -X POST "$INSFORGE_BASE_URL/api/database/rpc/eyes_agent_by_key_hash" -H "Authorization: Bearer $INSFORGE_API_KEY" -H 'content-type: application/json' -d '{"p_key_hash":"x"}'` must return `[]`, not a permission error.

## 2. MCP server on Manufact (mcp-use)
1. `npx mcp-use login` (or `--api-key $MCP_USE_API_KEY --org <org>`).
2. `npx mcp-use deploy --no-github --name eyes` from the repo root. The committed `Dockerfile` is used as-is (Node 24, `node apps/mcp/src/main.ts`, HOST 0.0.0.0).
3. Set env on the server (`npx mcp-use servers env --help` for the exact verb): `EYES_PROVIDERS=live`, `EYES_TEST_MODE=true`, `EYES_LINK_SECRET` (32+ random chars), `EYES_PUBLIC_API_URL=https://<slug>.run.mcp-use.com`, `EYES_WORKER_WEB_URL=https://<appkey>.insforge.site`, all `INSFORGE_*`, `INKBOX_*`, `STRIPE_*`, `PRIMITIVE_*`, `ANTHROPIC_API_KEY`. Redeploy after env changes.
   Optional: `EYES_OPS_KEY` (32+ random chars, `openssl rand -hex 32`) serves the live dashboard (map, task timeline, money ledger) at `<public>/ops/<EYES_OPS_KEY>`. Unset or empty, `/ops/...` answers the same 404 as any unknown route; shorter than 32 characters, the server refuses to start. The URL is the credential and the page shows where workers are: never post it publicly, in a screenshot, an issue or a shared chat. Give it to a person directly, and to revoke it set a new key and restart.
4. Check that the gateway forwards non-`/mcp` paths (unverified, ADR-004): `curl -s https://<slug>.run.mcp-use.com/healthz` and `/llms.txt`. If they 404, run the same image elsewhere (`docker build -t eyes-mcp . && docker run -p 3000:3000 --env-file .env eyes-mcp`, e.g. Fly, Railway, Render) and use that URL for webhooks, REST, docs and the worker web API, keeping Manufact for `/mcp`.

## 3. Worker web on InsForge Sites
1. `VITE_EYES_API_URL=https://<public api origin> VITE_INKBOX_NUMBER=+1XXXXXXXXXX pnpm --filter @eyes/web-worker build`. On the shared Inkbox line (no dedicated number), also set `VITE_INKBOX_CONNECT="connect @<agent handle>"`: the JOIN page then asks for that text before START. Set `VITE_LIVE_PAYOUTS=true` only when the server has `STRIPE_SECRET_KEY`; without it the JOIN and capture pages say payouts are simulated and show no amounts, matching what the server texts workers.
2. `npx @insforge/cli deployments deploy ./apps/web/worker/dist` (static output; camera and GPS need the HTTPS `*.insforge.site` URL).

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

## Manufact redeploy notes (learned 2026-10-17)

- Merges to GitHub main do not deploy. The server builds from a Manufact-managed mirror (`manufacts/eyes-*`) that `npx mcp-use deploy` uploads to. After a merge: `git pull` on main, then `npx -y mcp-use@2.10.0 deploy --yes --json --dockerfile Dockerfile`.
- The id that `deploy` returns goes to `stopped` within seconds; the real build is the `webhook` deployment created right after it. Watch `npx mcp-use deployments list` for that one to reach `running`.
- Env changes (`servers env set`) apply only on a new deployment: `npx mcp-use deployments restart <full deployment uuid>` (short ids give `deployment_not_found`; get the uuid from `deployments list --json`).
- InsForge migrations must be applied in strictly increasing version order: the API rejects any version older than the latest applied one (`DATABASE_MIGRATION_ALREADY_EXISTS`, "Migration version must be newer than the latest applied migration"). If `007_*` merges before `006_*`, do not run `scripts/insforge-migrate.ts` until `006` is on main, or `006` can never be applied. Applied so far (2026-10-17): 001-014.
- Never set `EYES_FAKE_WEBHOOKS=1` on a deployed server. It exists only so local tests can send fake-signed Stripe webhooks; on a deploy with fake payments it would let anyone credit balances and mark workers onboarded (fixed in PR #56, which closes the route unless this flag is set).

## Keyless sandbox server (T4.29, ADR-023)

- A second Manufact server, never the live one, runs with `EYES_SANDBOX=1` so Manufact's evals, Inspector and Public Chat (which can only authenticate by OAuth) and judges can run quote_task, ask_eyes and await_answer with no API key. A caller with no `Authorization` header gets a sandbox agent with play money, and a simulated worker answers every task in about 5 seconds.
- It needs its own InsForge project (migrations 001-014) and `EYES_PROVIDERS=fake`. `main.ts` refuses to start with `EYES_SANDBOX=1` and `EYES_PROVIDERS=live`, any `EYES_FAKE_WEBHOOKS` or any `ANTHROPIC_API_KEY`: anyone can call it, so it runs the safety rules only. Never point it at the live database: the simulated worker only answers for its own 555-01XX numbers, but `ask_eyes` would still add those fictional workers to whatever pool it is given.
- Place lookup is fake there: only the three demo places resolve by name; callers pass `{lat, lng}` for any other place.
- Deploy it from a clean checkout whose `.mcp-use/cloud/link.json` does not link the live server, with `npx -y mcp-use@2.10.0 deploy --new --no-github --name eyes-sandbox --dockerfile Dockerfile`, then set `EYES_SANDBOX=1`, `EYES_PROVIDERS=fake`, `EYES_TEST_MODE=true`, a new `EYES_LINK_SECRET`, `EYES_PUBLIC_API_URL`, `EYES_WORKER_WEB_URL`, the new project's `INSFORGE_BASE_URL` and `INSFORGE_API_KEY`, and `EYES_COMMIT`, and restart.
