# Eyes

AI agents can read the whole internet, but they cannot see the street. "Is this cafe open right now?", "How long is the line?", "Is oat milk in stock at this store?": online data is stale or missing for questions about right now, and a person standing nearby can answer in a minute. Eyes is an MCP server that lets any agent pay a nearby human about $3 to go and look. The agent is the customer and the human is the API: the agent asks, Eyes texts nearby workers, the first to reply YES takes a live photo on site, Eyes checks it, and the agent gets a structured, verified answer while the worker gets paid.

Built for YC's "Make Something Agents Want" hackathon (Oct 17-18, 2026) by Ayaan, Jerry and Shryuk.

**What is live today.** The MCP server is deployed on Manufact and backed by InsForge Postgres. Vendor keys (Inkbox, Stripe, Primitive, Anthropic) have not landed yet, so the deployed server runs those providers as fakes and every full round trip so far has run on fakes in CI. The safety rule layer is live-verified: the deployed server refuses "photograph the house at ..." with `unsafe_task` and a fix. [STATUS.md](STATUS.md) is the source of truth: nothing below is called live unless its "live-verified" column says yes.

## How it works

1. **Ask.** An agent (Claude, ChatGPT, Codex, any MCP client) calls `quote_task`, then `ask_eyes` with a question, a place, a bounty and a deadline. Eyes runs a safety check and escrows the bounty plus a $0.50 fee from the agent's prepaid balance.
2. **Dispatch.** Eyes texts the nearest available workers (up to 3 within 3 km) over iMessage. The first text has no link and no question text, only the kind of check, the place and the pay.
3. **Claim and capture.** The first worker to reply YES gets a capture link. The page opens the camera (no gallery uploads) and reads GPS.
4. **Verify.** Eyes checks that the worker was within 150 m, that the photo was taken live before the deadline, and that a vision model agrees the photo answers the question and shows no prominent faces.
5. **Answer and pay.** The agent's `await_answer` call returns the answer, photo URL, distance, checks and confidence. Escrow is released and the worker is paid $3 through Stripe Connect. If a check fails, the escrow stays held for human review instead.

```mermaid
sequenceDiagram
    participant A as Agent
    participant E as Eyes MCP server
    participant W as Worker iPhone
    participant C as Capture page
    A->>E: quote_task, then ask_eyes
    E->>E: safety check, escrow $3.50
    E->>W: iMessage offer
    W->>E: YES (first YES wins)
    E->>W: capture link
    W->>C: live photo + GPS
    C->>E: upload capture
    E->>E: verify GPS, freshness, vision
    A->>E: await_answer (long poll)
    E-->>A: answer, photo, checks
    E->>W: $3 Stripe transfer + paid text
```

## Try it as an agent

MCP URL: `https://dark-wave-wfmpm.run.mcp-use.com/mcp` (bearer auth). Get a key without a dashboard:

```sh
curl -s -X POST https://dark-wave-wfmpm.run.mcp-use.com/v1/signup \
  -H 'content-type: application/json' \
  -d '{"name": "my-agent", "owner_email": "owner@example.com"}'
```

Put the human owner's email in `owner_email`: that is how they get the private owner console for this key's limits ([Owner controls](#owner-controls)), which the agent never sees. The response holds `agent_id`, `api_key` (shown once), `balance_usd` (test mode grants $20), `top_up_url` for a human to add funds (a real Stripe Checkout once Stripe is configured), `email_address` (your private Eyes email address, once Primitive is configured) and `next_step`. Then connect, for example from Claude Code:

```sh
claude mcp add --transport http eyes https://dark-wave-wfmpm.run.mcp-use.com/mcp \
  --header "Authorization: Bearer $EYES_API_KEY"
```

Until the vendor keys land, the deployed server resolves only `{lat, lng}` coordinates and three demo places ("Blue Bottle Coffee, Mint Plaza, San Francisco", "Ferry Building, San Francisco" and "Trader Joe's, 401 Bay St, San Francisco") and has no opted-in workers yet (opting in needs the Inkbox line), so `ask_eyes` there returns `no_workers_nearby` and charges nothing. Its `/status` page says which parts are live and which are simulated. The whole loop runs on fakes in [e2e/golden-path.spec.ts](e2e/golden-path.spec.ts).

### The 9 tools

| Tool | What it does |
|---|---|
| `quote_task` | Free check before spending: workers nearby, estimated minutes, a suggested bounty that already fits this key's limits and balance, whether this key may post that task type here, and where Eyes thinks the place is. It never sees the question; `ask_eyes` checks that. |
| `ask_eyes` | Escrows bounty plus fee and texts nearby workers. `idempotency_key` is required; a retry with the same key returns the same task instead of charging twice. |
| `await_answer` | Long-polls up to 55 s per call ([ADR-002](intent/decisions/ADR-002-await-answer-cap.md)). Call it right after `ask_eyes` and keep calling: agents cannot listen for events in the background, so this loop is how the answer arrives. |
| `get_task` | Instant status and answer lookup. |
| `cancel_task` | Refunds the full escrow while no worker has claimed the task. |
| `dispute_answer` | Flags a wrong answer; holds the payout if it has not gone out and sends the task to human review. |
| `get_balance` | Balance, escrowed amount and a top-up link for your human. |
| `get_spend_policy` | The limits your human set on this key: max bounty, daily cap, remaining today, allowed task types. |
| `list_tasks` | Your own tasks, newest first, optionally filtered by status. Use it to find a task_id you lost before asking again ([ADR-013](intent/decisions/ADR-013-list-tasks.md)). |

Task types: `is_open`, `line_length`, `in_stock`, `photo_of_place`, `price_check`, `crowd_level`, `other_public`. Every tool description is written for an LLM reader with an example and a "Next:" line ([apps/mcp/src/server.ts](apps/mcp/src/server.ts)). The same capabilities are on REST under `/v1/*` (`HTTP_ROUTES` in [packages/core/src/schemas.ts](packages/core/src/schemas.ts)). `llms-full.txt`, `openapi.json` and the agent card are generated from the same schemas ([cli/src/docs.ts](cli/src/docs.ts)), the `eyes` CLI ([cli](cli)) validates with them, and the docs, starting with the hand-written `llms.txt`, are served live at https://dark-wave-wfmpm.run.mcp-use.com/llms.txt.

### Example exchange

Field names are the real schema; the values are illustrative and long strings are shortened. The agent calls `ask_eyes`:

```json
{ "question": "How many people are waiting in line right now?",
  "location": "Blue Bottle Coffee, Mint Plaza, San Francisco",
  "task_type": "line_length", "bounty_usd": 3,
  "idempotency_key": "6f1c2a9e-line-check" }
```

Eyes escrows $3.50, texts three workers and answers at once:

```json
{ "task_id": "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b", "status": "dispatched",
  "workers_notified": 3, "escrowed_usd": 3.5, "deadline_at": "2026-10-18T17:30:00Z",
  "next_step": "Call await_answer with task_id \"3f0e8c1a-...\" now, and keep calling it until answered is true ..." }
```

A few `await_answer` calls later:

```json
{ "task_id": "3f0e8c1a-...", "status": "paid", "answered": true,
  "answer": {
    "task_id": "3f0e8c1a-...",
    "answer_text": "Short line, about 4 people", "answer_bool": null,
    "photo_url": "<public URL in the InsForge photos bucket>",
    "captured_at": "2026-10-18T17:08:41Z", "worker_distance_m": 38,
    "verification": { "gps_ok": true, "fresh_ok": true, "vision_ok": true,
                      "vision_reason": "Photo shows the counter with four people in line." },
    "confidence": 0.95, "worker_rating": 5, "cost_usd": 3.5 },
  "next_step": "Answered, verified and the worker is paid. Use answer.answer_text and answer.photo_url. ..." }
```

### Errors say what to do next

Every refusal is `{ error, message, fix, ...context }` and the `fix` is an instruction an agent can follow ([packages/core/src/errors.ts](packages/core/src/errors.ts)). One exception: over MCP, arguments that do not match a tool's input schema come back as a plain "Input validation error" text that names each bad field, because the MCP SDK checks them before the tool runs. Asking Eyes to "Photograph the house at 123 Oak St" returns:

```json
{ "category": "private_residence",
  "reason": "The task is about a private home or home address. Eyes only checks public, commercial or civic places.",
  "error": "unsafe_task",
  "message": "Eyes only checks public, commercial or civic places, and never targets private people or homes.",
  "fix": "Ask about a public place such as a store, cafe, park or transit stop. Do not include home addresses, apartment numbers or questions about where someone lives." }
```

Money errors carry the numbers: `insufficient_balance` says how far to lower `bounty_usd` or where your human can top up, and `daily_cap_exceeded` says how much is left today.

## Be a worker

Sign-up opens once the Eyes texting line is set up; until then the JOIN page at **https://7t6779x4.insforge.site** says "Worker sign-up opens soon" and collects nothing. Once it is open: on your iPhone, enter your name and number, share your location once, then text **START** to the Eyes number it shows. Eyes cannot text you until you do (Inkbox requires recipients to opt in). After START you get a payout setup link for Stripe; then tasks arrive by text when one is near you. Reply YES to claim, open the link, take one photo, and you are paid when it verifies.

iPhone only for now: Eyes texts over an Inkbox iMessage line because it costs less than SMS. Send from your phone number, not an Apple ID email ([#25](https://github.com/ayaangazali/eyes/issues/25)). Never photograph faces.

## Owner controls

The person who funds an agent decides what it may spend. Each API key has a max bounty per task, a daily cap (UTC day) and a list of allowed task types; `ask_eyes` enforces them and returns `bounty_exceeds_max`, `daily_cap_exceeded` or `task_type_not_allowed` with a fix. Defaults are $10 max bounty, $20 per day, all task types. The agent can read its limits with `get_spend_policy` but cannot change them.

The owner console ([ADR-011](intent/decisions/ADR-011-owner-console.md)) is where a human changes them: a private `/owner/<token>` page that is never shown to the agent. When email delivery is set up, Eyes emails the link to the `owner_email` given at signup and to whoever pays a top-up through Checkout ([ADR-015](intent/decisions/ADR-015-owner-link-to-payer.md)); the operator can always print it with `pnpm owner-link <agent_id>`. It shows balance, escrow, today's spend, recent tasks and the ledger; it sets max bounty, daily cap and allowed task types; a daily cap of 0 freezes spending; and an add-funds button opens Stripe Checkout once Stripe is configured. It is a separate link from the top-up link because the agent holds the top-up link and could otherwise raise its own limits.

## Safety

Eyes sends real people to real places, so it only accepts tasks about public, commercial or civic places ([SPEC §12](docs/SPEC.md)). Refused: targeting a specific private person, private homes or home addresses, a person's vehicle or license plate, entering private property, photographing or identifying people, following anyone, and anything illegal or dangerous.

- **Rules, then a classifier.** Every task passes a deterministic rule layer before any money moves, and then a Claude Haiku classifier when `ANTHROPIC_API_KEY` is set ([packages/safety](packages/safety)); `/status` says which. Without the key (the deployed server today) only the rules run: they refuse homes and home addresses, but some tasks about a specific person or vehicle get past them; those are left to the classifier. The rules are kept narrow (31 patterns that need no negation logic) because "don't photograph faces" must pass while "take a photo of her face" must not; that judgment goes to the classifier. If the classifier is on but unavailable, the task is refused and nothing is charged, and the server will not start in live mode without the classifier key. 200 labelled fixtures live in [evals/safety](evals/safety).
- **Faces.** Workers are told never to photograph faces, on the JOIN page, in the capture text and on the capture page. The vision check rejects photos with prominent faces, which sends the task to review with escrow held.
- **No agent text in a cold text.** The first message to a worker names only the kind of check, the place and the pay ([ADR-005](intent/decisions/ADR-005-offer-task-type-and-field-docs.md)). An ASCII filter cannot keep Unicode links and phone numbers out of free text, so the question is shown only after a worker claims.

## Money

- **Integer cents everywhere** ([ADR-001](intent/decisions/ADR-001-integer-cents.md)). USD appears only at the agent-facing edge. Float math drifts and Stripe amounts are integer minor units.
- **Escrow on ask.** `ask_eyes` moves the bounty (default $3) plus the $0.50 fee out of the agent's balance in the same database transaction that creates the task. A balance below zero is a check constraint, so overspend fails in Postgres, not only in code.
- **Released only on a verified answer.** All three checks pass, the bounty is released and transferred to the worker's Stripe Connect Express account, and the fee stays with Eyes. Any failed check sets `needs_review` and keeps the escrow held.
- **Refunded on expiry or cancel.** Nobody answers before the deadline, or the agent cancels before a claim: the full $3.50 goes back.
- **No double moves.** The ledger allows one row per task per type (escrow, release, refund, payout, fee), so a retry cannot release twice, and Stripe webhook redelivery is idempotent.
- **Top-ups** go through Stripe Checkout. Workers get our own `/w/connect/<token>` link by text, which mints a fresh Stripe onboarding link on click because Stripe's links expire within minutes.

## Sponsors

From the coverage table in [STATUS.md](STATUS.md), with the live-verified column as it stands.

| Sponsor | What we use | Where in the repo | Live-verified |
|---|---|---|---|
| Manufact (mcp-use) | MCP server on mcp-use 2.10: 9 tools with LLM-first descriptions, bearer auth, REST mirror and worker API, deployed on Manufact Cloud from the repo Dockerfile | [apps/mcp](apps/mcp), [Dockerfile](Dockerfile) | partial: routing yes, providers fake |
| InsForge | Postgres (escrow ledger, race-safe claim and expiry as plpgsql over RPC, RLS on every table), `photos` storage bucket, Sites hosting for the worker pages | [packages/db](packages/db), [scripts/insforge-migrate.ts](scripts/insforge-migrate.ts), [apps/web/worker](apps/web/worker) | **yes** (database and Sites; storage waits for the first live capture) |
| Stripe | Checkout top-ups, per-key spend policy, Connect Express onboarding minted on click, $3 transfer on a verified answer, signed webhooks, refund on expiry or cancel | [packages/payments](packages/payments) | no |
| Inkbox | iMessage line: offer, capture link and paid texts; signed `imessage.received` webhook for START and YES | [packages/comms/src/inkbox.ts](packages/comms/src/inkbox.ts) | no |
| Primitive | A private email address per agent ([ADR-007](intent/decisions/ADR-007-agent-email-identity.md)); inbound email becomes `ask_eyes`; the answer comes back in the same thread with the photo attached; DMARC-verified senders only | [packages/comms/src/primitive.ts](packages/comms/src/primitive.ts) | no |
| Armature | Agent experience: errors with a fix, LLM-first tool docs; `llms.txt`, `openapi.json` and agent card served live at https://dark-wave-wfmpm.run.mcp-use.com/llms.txt, `eyes` CLI in [cli](cli); analytics and evals not wired yet | [packages/core/src/errors.ts](packages/core/src/errors.ts), [apps/mcp/src/server.ts](apps/mcp/src/server.ts) | no |
| Blaxel | Planned: eval agents in sandboxes and a simulated agent swarm for the dashboard; never on the golden path | not built | no |
| Anthropic (models, not a track) | Claude Sonnet vision for photo verification, Claude Haiku safety classifier | [packages/verify](packages/verify), [packages/safety](packages/safety) | no |

## Architecture

```mermaid
flowchart LR
    agents["Agents: MCP, REST, email"] --> mcp["apps/mcp<br/>mcp-use server on Manufact"]
    mcp --> engine["packages/engine<br/>EyesService"]
    engine --> db[("InsForge Postgres<br/>ledger, claims, expiry")]
    engine --> comms["packages/comms<br/>Inkbox, Primitive"]
    engine --> pay["packages/payments<br/>Stripe"]
    engine --> verify["packages/verify<br/>GPS, fresh, vision"]
    engine --> safety["packages/safety<br/>rules + classifier"]
    worker["apps/web/worker<br/>InsForge Sites"] --> mcp
```

Every transport (MCP, REST, email, worker web) calls one `EyesService` interface and never touches the database; state transitions that move money are single plpgsql functions so each one is one transaction ([ADR-003](intent/decisions/ADR-003-seams-and-ownership.md)).

| Path | What lives there |
|---|---|
| [apps/mcp](apps/mcp) | mcp-use server, REST mirror, worker API, webhook mounting, composition root |
| [apps/web/worker](apps/web/worker) | JOIN onboarding and the capture page |
| [apps/web/dashboard](apps/web/dashboard) | demo dashboard: live map, task timeline, ledger (loopback only) |
| [packages/core](packages/core) | frozen contracts: zod schemas, error catalog, provider interfaces, fakes, `EyesService` |
| [packages/engine](packages/engine) | `EyesService` implementation: state machine, dispatch, expiry |
| [packages/db](packages/db) | migrations, Postgres and InsForge transports, InsForge storage |
| [packages/comms](packages/comms) | Inkbox and Primitive adapters and webhook routes |
| [packages/payments](packages/payments) | Stripe adapter and routes |
| [packages/verify](packages/verify) | GPS, freshness and vision checks |
| [packages/safety](packages/safety) | rules and classifier |
| [evals/safety](evals/safety) | classifier eval fixtures |
| [e2e](e2e) | Playwright golden path |
| [intent](intent) | why every file exists |

## How this repo was built

One orchestrator ran builder and verifier agents ([.claude/agents](.claude/agents)), each builder in its own git worktree, owning a fixed set of files. The point was to make every change explain itself, so a judge, a teammate or a future agent can open any file and find out why it exists and how it was checked.

- **Every file has a why.** [intent/INDEX.md](intent/INDEX.md) maps each file under `apps/` and `packages/` to its intent file (task, why, what, decisions, assumptions, verification, known gaps). CI fails a PR that changes code without one ([scripts/check-intent.ts](scripts/check-intent.ts)).
- **Verifiers, not self-grading.** Builders never mark their own work done. Spec, test, security and AX verifiers return PASS or FAIL with evidence, recorded in [intent/verdicts](intent/verdicts). The safety gate took seven rounds: [round 6 FAIL](intent/verdicts/T1.5-PR7-r6.md), [round 7 PASS](intent/verdicts/T1.5-PR7-r7.md).
- **Decisions are written down.** [intent/decisions](intent/decisions) holds the ADRs, including where vendor docs overrode the plan ([ADR-004](intent/decisions/ADR-004-vendor-driven-changes.md)) and which findings block a merge ([ADR-010](intent/decisions/ADR-010-blocking-vs-deferred-findings.md)).
- **Vendor APIs from notes, not memory.** [docs/vendor](docs/vendor) has one researched note per sponsor.
- **Plan and board.** [docs/SPEC.md](docs/SPEC.md), [docs/PLAN.md](docs/PLAN.md), [STATUS.md](STATUS.md), deploy steps in [docs/DEPLOY.md](docs/DEPLOY.md).

## Develop locally

Needs Node 24, pnpm and Docker (or OrbStack).

```sh
pnpm install
pnpm db:up
export DATABASE_URL=postgres://postgres:eyes@127.0.0.1:54329/eyes
pnpm db:migrate
pnpm verify:fast
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:e2e
cp .env.example .env
node --env-file=.env apps/mcp/src/main.ts
```

`db:up` starts Postgres 17 on port 54329. `verify:fast` is lint, typecheck, unit, contract, safety rule fixtures and the intent check, all without a database. `test:integration` runs the engine, ledger and dashboard against that Postgres, and `test:e2e` is the Playwright golden path on fakes. The last line starts the server on fakes at http://127.0.0.1:3000/mcp.

`pnpm smoke:live` checks a deployed server end to end. Deploying is in [docs/DEPLOY.md](docs/DEPLOY.md). The demo runbook is [docs/DEMO.md](docs/DEMO.md) and the submission draft is [docs/SUBMISSION.md](docs/SUBMISSION.md).
