# Eyes: build plan to submission

Living plan. `STATUS.md` is the task board; this file says what remains, who does it, what blocks it, and the exact steps when each key lands. Updated by the orchestrator at every gate.

Hacking: Sat Oct 17 10:30 AM to Sun Oct 18 10:00 AM (submissions). Feature freeze 6:00 AM Sun.

## 1. Where we are

| Area | State |
|---|---|
| Contracts, CI, intent system (Phase 0) | done; G0 passed |
| Golden path on fakes (G1 fakes half) | done; Playwright e2e green in CI |
| MCP server on Manufact | live at https://dark-wave-wfmpm.run.mcp-use.com/mcp; redeploy by hand after each merge (`npx mcp-use deploy --yes --dockerfile Dockerfile`); env changes need `deployments restart` |
| InsForge Postgres + Sites | live; signup/balance/policy served from InsForge; worker web at https://7t6779x4.insforge.site |
| Stripe, Inkbox, Primitive, Claude vision/classifier, Armature | code merged on fakes; waiting on keys |
| Safety gate (T1.5, PR #7) | round 6 in verification |
| Agent docs + `eyes` CLI (T3.2, PR #9) | round 5 in verification |

## 2. Work in flight (wave 4)

| Task | What | Why | Agent |
|---|---|---|---|
| T2.5 owner console (ADR-011) | `/owner/:token` page: users set max bounty, daily cap, allowed task types, freeze, add funds; link emailed to `owner_email`, never shown to the agent | Stripe track: clear user control over what agents can do and spend | builder + security/spec/test verifiers |
| T4.1 hardening | deferred #17-#23; per-IP throttle on signup and worker join | unauthenticated signup grants test money that can text real workers | builder + security/test verifiers |
| T3.5a demo rehearsal + swarm | `e2e/demo.spec.ts` encodes the §13 demo; `pnpm swarm` lights the dashboard with ~50 simulated agents | G3 needs a machine check that the demo passes 3x; the map needs activity | builder + integration verifier |
| SPEC coverage ledger | every SPEC/ADR obligation marked met/partial/unmet with file:line + test evidence; product gaps outside the SPEC | "cover everything" needs a list, not a feeling | auditor (read-only) |
| UX/UI audit | screenshots of every human screen at iPhone and desktop size; findings ranked | a cold-texted stranger must trust the link and finish in 60 s | auditor (read-only), then a UI builder |

Every PR: spec + test + intent verifiers, plus security on money/auth/webhooks/safety and ax on agent surfaces (SPEC §4). Auto-merge on PASS + green CI. ADR-010 decides blocking vs deferred.

## 3. Next waves (queued, start as slots free; max 4 builders)

1. **UI fixes** from the UX audit (worker web, dashboard, owner console, HOME, top-up pages): one visual language, permission-denied recovery, safety copy before capture, projector-legible dashboard.
2. **Gap builders** from the coverage ledger, highest demo impact first.
3. **T3.4 Armature + evals**: golden-path eval across Claude and a second MCP client; analytics once the key and their mcp-use answer land.
4. **T3.5b Blaxel**: run `pnpm swarm` and the ax/eval agents as Blaxel batch jobs and sandboxes (needs `BL_WORKSPACE`, `BL_API_KEY`). Never on the golden path.
5. **Phase 4 package**: README (judge-facing), submission text, 90 s video script, backup video, demo runbook card.

## 4. When each key lands (exact steps)

Order agreed with the humans: Inkbox (in person) -> Manufact -> InsForge -> Stripe -> Primitive -> Armature. Anthropic is a prerequisite for any live mode: without `ANTHROPIC_API_KEY` the server refuses `EYES_PROVIDERS=live` on purpose (the safety classifier and photo verification would be off).

Set server env with `npx mcp-use servers env set 0526925a-58ae-4d83-9c3b-ed378926c260 KEY=VALUE` (secrets with `--secret` where supported), then `npx mcp-use deployments restart <running id>` (env is read at start; merges do not auto-deploy). Code changes: `npx mcp-use deploy --yes --dockerfile Dockerfile` from an up-to-date main.

| Key | Steps | Proof (live-verified) |
|---|---|---|
| `ANTHROPIC_API_KEY` | set on server, set `EYES_PROVIDERS=live`; add as repo secret (enables `claude-verifier.yml`, `safety-llm-eval.yml`); run `pnpm safety:eval` locally with the key | `/healthz` shows vision live; `safety-llm-eval` precision/recall recorded; a refusal for "photograph the house at 123 Oak St" over MCP |
| Inkbox iMessage line (in person) | set `INKBOX_API_KEY`, `INKBOX_PHONE_NUMBER`, webhook secret; subscribe `imessage.received` to `/webhooks/inkbox`; rebuild worker web with `VITE_INKBOX_NUMBER` and redeploy Sites; each worker iPhone texts START from its phone number | G1 live: Claude -> ask_eyes -> teammate iPhone gets the offer -> YES -> capture link -> photo -> Claude gets the answer |
| Stripe sandbox | set `STRIPE_SECRET_KEY`; create both event destinations (account: `checkout.session.completed`; connected accounts: `account.updated`) to `/webhooks/stripe`, set both secrets; pre-fund with 4000 0000 0000 0077; worker texts START and onboards through the payout link | G2: top-up via Checkout credits the balance; verified answer creates a $3 transfer visible in the Stripe dashboard; expiry refunds |
| Primitive | set `PRIMITIVE_API_KEY`, `PRIMITIVE_WEBHOOK_SECRET`, `PRIMITIVE_DOMAIN`; deploy the inbound function to POST `/webhooks/primitive`; ask staff for `send_to_any_domain` | an agent emails its Eyes address and gets a threaded reply with the photo; the owner link email arrives |
| Armature | set `ANALYTICS_INGEST_API_KEY`; wire T3.4 | events visible in Armature; eval run recorded |
| Blaxel | set `BL_WORKSPACE`, `BL_API_KEY` | swarm batch job lights up the dashboard |

## 5. Gates

- **G1 live**: one real text round trip (Inkbox step above). Payout may be fake.
- **G2**: live end to end with Stripe test-mode escrow -> payout visible; safety refusal works live; ax-verifier completes signup -> ask -> answer from public docs only.
- **G3** (before 6:00 AM Sun): `pnpm test:demo` passes 3x in a row on fakes, and the live demo passes 3x in a row. Feature freeze.

## 6. Demo (SPEC §13) and what each sponsor shows

Claude asks "Is the line at Blue Bottle Coffee, Mint Plaza long right now? Use Eyes." -> quote_task, ask_eyes -> dashboard pin, "3 workers notified" -> teammate at the cafe replies YES, snaps the photo -> Claude gets "short line, about 4 people, verified 38 m away, $3.50" -> Stripe shows escrow released and $3 paid -> owner console shows the spend limit; lowering it makes the next ask fail with a fix -> "photograph the house at [address]" gets a polite refusal -> an agent's email thread gets the answer with the photo -> swarm mode lights up the map for the close.

## 7. Risks and fallbacks

| Risk | Fallback |
|---|---|
| Inkbox iMessage line not provisioned in time, or a worker texts from an Apple ID email (#25) | teammate phones send from their numbers; worst case run G1 on the fake messenger and show the capture page on a phone |
| Stripe Connect onboarding friction | pre-onboard one teammate worker before demos; show the transfer in the dashboard |
| Anthropic key late | everything else is live-ready; rules-only safety still refuses the demo's unsafe task |
| Venue GPS drift | verify radius 150 m; capture at the cafe door |
| Manufact deploy breaks on a merge | redeploy the previous deployment (`npx mcp-use deployments restart <id>`); the same Docker image runs anywhere |
