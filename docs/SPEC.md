# EYES: build spec

Source of truth for every builder and verifier. Sections are numbered so task cards and intent files can cite them (`§6`). Where vendor docs contradicted this spec, the ADRs in `intent/decisions/` win (ADR-002 await cap, ADR-003 seams and ownership, ADR-004 vendor changes).

Priority when things conflict: (1) a working, honest end-to-end demo, (2) green CI on main, (3) verified work with intent docs, (4) feature breadth.

## §1 Product

Eyes lets any AI agent pay a nearby human a few dollars to check something in the physical world. The agent is the customer; the human is the API.

Problem: agents can read the whole internet but cannot see the street. "Is this store open right now?" "How long is the DMV line?" "Is oat milk in stock at this Trader Joe's?" Online data is stale or missing for right-now questions. A human standing nearby can answer in 60 seconds.

Flow:
1. An agent (Claude, ChatGPT, Codex, any MCP client) calls an Eyes tool with a question, location, bounty, deadline.
2. Eyes texts nearby registered humans ("workers") the task.
3. The first worker to reply YES claims it, walks over, opens a capture page that takes a live photo and GPS.
4. Eyes verifies: GPS within radius, photo captured live within the deadline, and a moderation check confirms the photo is safe to share (Eyes never judges whether the answer is correct; a human disputes wrong answers, ADR-025).
5. The agent receives a structured answer (text, photo URL, timestamp, distance, confidence). The worker is paid automatically.

Pricing: default $3 bounty to the human plus $0.50 Eyes fee, escrowed from the agent's balance on post, refunded if unclaimed or expired.

Sponsor tracks:
- Primitive: agents get an Eyes email identity; agents email questions to their private Eyes address (ADR-007) and get threaded answers with the photo attached. Workers are reached by text only; worker email replies were dropped (ADR-007). Inbound mail reaches our signed `/webhooks/primitive` route from Primitive's managed subdomain. Prize: best agent communication setup, demo must show an agent-side email thread.
- Stripe: prepaid agent balance via Checkout; per-API-key spend controls (max bounty, daily cap, allowed task types); escrow, release, Connect Express payout to workers (test mode); refunds on expiry. Prize wants clear user control over what agents can do and spend: spend limits and the refund path must be visible in the demo.
- Inkbox: the Eyes dispatcher is an Inkbox identity with a phone number; texts or iMessages workers, receives YES claims, sends capture links and payout confirmations.
- Manufact: MCP server built with the mcp-use SDK (TypeScript), deployed on Manufact Cloud.
- Armature: best Agent Experience (AX), see §9.
- InsForge: Postgres, storage (photos), functions, schedules (cron), Sites hosting for worker pages.

## §2 Process rules

- Builders run as background agents, each in its own git worktree on branch `feat/<task-id>-<slug>`. Builders never edit files they do not own (§5 task cards, ADR-003).
- At most 4 builders run at once. Verifiers and researchers do not count.
- A builder's job ends when it opens a PR with code, tests, an intent file and a passing `pnpm verify:fast`. It does not mark its own task done.
- Contracts are frozen after Gate G0: `packages/core`, MCP tool signatures, merged migrations, provider interfaces, route factory signatures. Changing one needs orchestrator approval, an ADR in `intent/decisions/`, and a notice to every running builder.
- A PR merges (squash) only when: required CI is green, required verifiers returned `VERDICT: PASS` (recorded in the intent file), the intent file is complete, and no contract conflict is open. Policy for this event: auto-merge on PASS plus green CI.
- Three failed verifications on one task escalate to the humans with a summary and two options.
- ADR-010 (humans, 2026-10-17): findings on money, auth/secrets, data integrity, the safety classifier or the demo path block a merge; defense-in-depth edges (log formatting, perf on authenticated input, hardening of already-guarded paths) merge and get a follow-up issue or PR, listed in STATUS.md "Deferred" and in the intent file's Known gaps, triaged at feature freeze.
- `STATUS.md` is the task board. No sponsor integration is called working until it has worked live once (`live-verified: yes/no`).

## §3 Agents

Definitions live in `.claude/agents/`. Shared rules: `docs/process/builder-rules.md`, `docs/process/verifier-rules.md`.

Verdict format (all verifiers):
```
VERDICT: PASS | FAIL
TASK: <id>
FINDINGS:
- [blocker|major|minor] <file>:<line>: <problem>. Repro: <steps/test>. Suggested fix: <one line>.
EVIDENCE: <commands run + key output>
```
Blockers and majors must be fixed before merge. Minors go to the intent file's "Known gaps".

## §4 Verification protocol

- Every PR: `spec-verifier`, `test-verifier`, `intent-auditor`.
- Plus `security-verifier` on payments, comms, safety, webhooks, auth.
- Plus `ax-verifier` on agent-facing surfaces (MCP tools, REST, docs, CLI).
- Every gate (G0 to G3): `integration-verifier` and `ax-verifier` on merged `main`.
- Verification is evidence-based: commands actually run, outputs actually seen.
- `claude-verifier.yml` runs on every PR when `ANTHROPIC_API_KEY` is set (non-blocking).

## §5 Task graph

Phase 0 (orchestrator): T0.1 vendor notes, T0.2 scaffold + CI, T0.3 contracts + migration v1 + provider fakes, T0.4 agents, hooks, intent system, STATUS. Gate G0: CI green, contracts frozen, humans have the keys list.

Phase 1, golden path on fakes plus first live text:
- T1.1 `mcp-builder`: `quote_task`, `ask_eyes`, `await_answer`, `get_task`, `cancel_task` over `EyesService`; REST mirror; worker `/w/*` routes; composition root; real `Geo`. Verifiers: spec, test, ax, intent.
- T1.2 `engine-builder`: `createEyesService`; state machine `dispatched -> claimed -> submitted -> verified -> paid` plus `expired/refunded/disputed/needs_review`; nearest-N dispatch within radius; first-YES-wins race-safe claim in the database; escrow and refund ledger in plpgsql; expiry; InsForge transport and storage. Verifiers: spec, test, security, intent.
- T1.3 `comms-builder`: Inkbox `Messaging` adapter, inbound webhook route with signature verification, YES/STOP/START parsing, message templates within iMessage limits. Verifiers: spec, test, security, intent.
- T1.4 `worker-web-builder`: JOIN onboarding page (with "text START" step); capture page with live camera (`capture="environment"`, no gallery), geolocation, optional answer, upload to `/w/offers/:token/capture`. Verifiers: spec, test, intent.
- T1.5 `safety-builder`: deterministic rule layer plus LLM classifier; at least 30 fixtures. Verifiers: spec, test, security, intent.
- Gate G1: golden path e2e green on fakes in CI, and one live run: Claude -> `ask_eyes` -> a teammate's phone gets a real Inkbox text -> photo -> Claude gets the answer (payout may still be fake).

Phase 2, money, verification, deploy:
- T2.1 `payments-builder`: Stripe adapter: Checkout top-up, Connect Express onboarding, transfers on release, webhook verification, `/topup/:token`, `/w/connect/:token`. Verifiers: spec, test, security, intent.
- T2.2 `verification-builder`: `verifySubmission` (gps_ok within 150 m, fresh_ok, vision_ok via Claude vision, confidence) and `createClaudeVision`; auto-approve only if all pass, else `needs_review` with escrow held. Verifiers: spec, test, intent.
- T2.3 orchestrator: deploy MCP on Manufact, worker web on InsForge Sites, env wiring, live smoke checklist. Verifiers: integration.
- T2.4 `mcp-builder`: `dispute_answer`, `get_balance`, `get_spend_policy`; real `quote_task` numbers. Verifiers: spec, test, ax, intent.
- Gate G2: live end-to-end including Stripe test-mode escrow -> payout visible in the dashboard; safety refusal works live.

Phase 3, Primitive, AX, dashboard (feature freeze at 6:00 AM Sunday):
- T3.1 `comms-builder`: Primitive agent email identity; agents email their capability address (ADR-007) and get threaded answers with the photo attached; DMARC-verified senders only. Verifiers: spec, test, security, intent.
- T3.2 `ax-builder`: `/llms.txt`, `/llms-full.txt`, `/openapi.json`, `/.well-known/agent-card.json`, agent self-signup (API key + funding link, $20 test grant), error catalog surfaced with `fix`, CLI `eyes ask "..."`. Verifiers: spec, test, ax, intent.
- T3.3 `dashboard-builder`: live map, task timeline, ledger, payouts. Verifiers: spec, intent.
- T3.4 orchestrator or `ax-builder`: Armature analytics and a golden-path eval across Claude and one other client. Verifiers: ax, integration.
- Gate G3: the demo script (§13) passes 3 times in a row. Feature freeze.

Phase 4 (6:00 to 9:30 AM Sunday): bug fixes only, demo 5 times, backup video, README, submission text. Submissions are due 10:00 AM Sunday (docs/vendor/hackathon.md).

## §6 MCP tool surface (the product)

Every description, parameter doc and error is written for an LLM reader: explicit, with examples, always saying what to do next. Schemas are frozen in `packages/core/src/schemas.ts` (`TOOLS`).

1. `quote_task(location, task_type)` -> `{ workers_nearby, est_minutes_to_answer, suggested_bounty_usd, allowed, reason_if_not, resolved_location }`. `location` is `{lat, lng}`, an address, or "place name, city".
2. `ask_eyes(question, location, task_type, bounty_usd=3, deadline_minutes=30, require_photo=true, idempotency_key)` -> `{ task_id, status: "dispatched", workers_notified, escrowed_usd, deadline_at, next_step }`. `task_type` is one of `is_open, line_length, in_stock, photo_of_place, price_check, crowd_level, other_public`.
3. `await_answer(task_id, timeout_seconds=50, max 55)` long-polls until answered or timeout (ADR-002). The description must tell the agent to call it immediately after `ask_eyes` and to keep calling it, because agents cannot watch for events in the background.
4. `get_task(task_id)` -> status in `dispatched|claimed|submitted|verified|paid|expired|refunded|disputed|needs_review`.
5. `cancel_task(task_id)` -> refund if unclaimed.
6. `dispute_answer(task_id, reason)` -> holds payout, flags for review.
7. `get_balance()`, `get_spend_policy()`.

Answer:
```
{ task_id, answer_text, answer_bool|null, photo_url, captured_at, worker_distance_m,
  verification: { gps_ok, fresh_ok, vision_ok, vision_reason },
  confidence (0-1), worker_rating, cost_usd }
```
Error shape: `{ error, message, fix, ...context }` from `EyesError.toBody()`, for example `{ error: "insufficient_balance", balance_usd: 1.2, needed_usd: 3.5, fix: "Ask your user to top up at <link>, or lower bounty_usd to 0.70 or less." }`. The catalog is `ERRORS` in `packages/core/src/errors.ts`.

HTTP routes are listed in `HTTP_ROUTES` (`packages/core/src/schemas.ts`).

## §7 Intent folder

Anyone (human, judge, future agent) can open `intent/` and see why each file exists, what was decided and how it was verified.

```
intent/
  INDEX.md                  generated by `pnpm intent:index`: file -> intent file(s)
  T1.3-inkbox-dispatch.md   one file per task, updated by follow-up PRs on the same task
  decisions/ADR-00N-*.md    architecture and contract decisions, doc-vs-spec conflicts
  verdicts/T1.3-PR12-security.md   raw verifier verdicts
```

Template (15 to 30 lines):
```markdown
---
task: T1.3
title: Inkbox dispatch + claim
agent: comms-builder
pr: <link>
files: [packages/comms/src/**, packages/comms/package.json]
spec_refs: [§1 Flow 2-3, §5 T1.3]
vendor_refs: [docs/vendor/inkbox.md]
status: verified | needs-follow-up
---
## Why
<the user or agent-facing reason this code exists, 2-3 sentences>
## What
<bullet list>
## Decisions & alternatives rejected
<choice: reason>
## Assumptions
<vendor behavior assumed; link the vendor note>
## Verification
<tests added; verifier verdicts (agent: PASS/FAIL + link); CI run link; live-verified yes/no>
## Known gaps
<minors deferred, follow-ups>
```

Enforcement (`scripts/check-intent.ts`, CI job `intent`): every changed file under `apps/`, `packages/`, `cli/`, `scripts/`, `db/` must be listed (globs allowed) in the `files` of an intent file changed in the same diff, with non-empty Why and Verification. Modifying (not adding) a file under `packages/core/src/` or `packages/db/migrations/` also needs an ADR in the same diff. `intent/INDEX.md` must be fresh.

## §8 CI

Required jobs in `.github/workflows/ci.yml` run without secrets (fakes only): `lint`, `typecheck`, `unit`, `contract`, `integration` (Postgres service), `e2e` (Playwright), `safety-rules`, `intent`, `secrets-scan` (gitleaks), `build`. Non-blocking: `safety-llm-eval.yml`, `claude-verifier.yml`, `live-smoke.yml` (manual).

## §9 Agent experience (AX)

- Agent self-signup without a dashboard: returns an API key and a Stripe Checkout link for a human to fund; test mode grants $20.
- Serve `/llms.txt`, `/llms-full.txt`, `/openapi.json`, `/.well-known/agent-card.json`.
- Every error includes `fix`.
- `idempotency_key` on `ask_eyes`; all retries are safe.
- Same capabilities via MCP, REST and CLI.
- `ax-verifier` must complete the full flow using only public docs and tool descriptions before G2 and G3 pass.

## §10 Repo layout

```
apps/mcp            mcp-use server, REST mirror, worker API, route mounting, composition root
apps/web/worker     JOIN onboarding + capture page
apps/web/dashboard  demo dashboard
packages/core       frozen contracts: zod schemas, error catalog, provider interfaces, fakes, EyesService
packages/engine     EyesService implementation: state machine, dispatch, expiry
packages/db         migrations, migrate script, Postgres + InsForge transports, InsForge storage
packages/comms      Inkbox + Primitive adapters and webhook routes
packages/payments   Stripe adapter and routes
packages/verify     gps / fresh / photo moderation checks, clef-omni + Claude adapters
packages/safety     rules + classifier
cli/                `eyes` CLI
docs/vendor         researcher notes      docs/public   llms.txt etc.
evals/safety        classifier eval fixtures
intent/  scripts/  e2e/  .claude/agents/  .github/workflows/  STATUS.md
```

## §11 Data model

`packages/db/migrations/001_init.sql` (frozen). All money is integer cents (ADR-001). Tables: `agents`, `workers` (+ `opted_in`), `tasks` (+ `place_label`, `require_photo`, `dispute_reason`; unique `agent_id, idempotency_key`), `offers` (which workers were texted for which task), `submissions`, `ledger` (unique `task_id, type`; unique `type, stripe_ref`). Expiry: expire overdue tasks and refund escrow.

## §12 Safety and abuse

Eyes only allows tasks about public, commercial or civic places.
- Every task passes the rule layer and the LLM classifier before dispatch. Reject: targeting a specific private person; private residences or home addresses; a person's vehicle; entering private property; photographing identifiable people; following anyone; illegal or dangerous tasks. Rejections return a clear, non-judgmental `unsafe_task` error with `fix`.
- Workers are told never to photograph faces; photos with prominent faces are rejected (vision verdict `prominent_faces`).
- Per-agent spend caps and daily caps. Workers can report a task; reported tasks pause (stretch).

## §13 Demo script (90 seconds)

1. "Agents can read the whole internet but can't see the street outside." In Claude: "Is the line at [DEMO_CAFE] long right now? Use Eyes."
2. Claude calls `quote_task` then `ask_eyes`; the dashboard shows the pin and "3 workers notified."
3. A teammate already at the cafe gets the text, replies YES, snaps the photo.
4. Claude receives: "Short line, about 4 people, photo attached, verified 38 m away, $3.50 total." The Eyes dashboard ledger shows the escrow released; the Stripe dashboard shows the top-up and the $3 transfer to the worker's connected account (escrow is an Eyes ledger entry, not a Stripe object).
5. A rejected task ("photograph the house at [address]") returns a polite refusal. An agent emails Eyes and gets a threaded answer with the photo attached.
6. Close: "Eyes turns 8 billion humans into an API agents can pay for."

## §14 Team and decisions

- Ayaan: AX, safety, dashboard, demo and pitch. Jerry: engine, MCP, payments, verification. Shryuk: comms, worker web, Primitive. Humans review PRs in their lane, run live phone tests, unblock accounts and keys.
- Execution mode: single orchestrator.
- Repo: `ayaangazali/eyes`, public.
- Merge policy: auto-merge on verifier PASS plus green CI.
- Worker phones, Stripe Connect status, public domain, demo cafe: collected at Gate G0 (see STATUS.md "Needs from humans").
