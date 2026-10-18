# Eyes: build plan to submission

Living plan. `STATUS.md` is the task board; this file says what remains, who does it, what blocks it, and the exact steps when each key lands. Updated by the orchestrator at every gate.

Hacking: Sat Oct 17 10:30 AM to Sun Oct 18 10:00 AM (submissions). Feature freeze 6:00 AM Sun.

## 1. Where we are (2026-10-17 04:25 PT)

| Area | State |
|---|---|
| Golden path, demo script, swarm | on fakes in CI: `pnpm test:e2e` (golden + demo), `pnpm test:demo` passes 3x in a row (G3 machine check), `pnpm swarm` fills the dashboard |
| MCP server on Manufact | live: 9 tools, REST mirror, agent docs (`/llms.txt`, `/openapi.json`, agent card), HOME and `/status`; `pnpm smoke:live` 13/13 |
| InsForge | live: Postgres (migrations 001-008), photo storage (delete verified), Sites (worker JOIN, capture, privacy) |
| Owner control (Stripe track) | live: owner console (limits, freeze, add funds, ledger); owner link to `owner_email` and (after #53) to the Checkout payer |
| Safety | live: rules layer; Claude classifier switches on with `ANTHROPIC_API_KEY` |
| Money paths | escrow, refund, payout retry, operator resolve (`pnpm resolve-task`), forged-webhook guard (#56); payout recovery after a Stripe refusal in review (#57) |
| Agent experience | AX eval (`pnpm ax:eval`) runs the scripted client in CI; Claude client runs when the key lands |
| Vendors | Stripe, Inkbox, Primitive, Claude vision/classifier, Armature: code merged, waiting on keys |

## 2. Work in flight

| Task | What | Status |
|---|---|---|
| T4.9 (#57) | payouts recover after a Stripe refusal, no starvation | round-2 adversarial verify |
| T4.13 (#60) | every user-facing sentence true on the running system | verifying |
| T4.11b (#59) | signup never claims an email was sent when email is simulated | merging |

Every PR: spec + test + intent verifiers, security on money/auth/webhooks/safety, ax on agent surfaces. Auto-merge on PASS + green CI. ADR-010 decides blocking vs deferred. Verdicts live in `intent/verdicts/`.

## 3. Next (in order)

1. **T4.14** a worker who replies NO after YES releases the claim so the task goes back to other workers (migration 010, after #57).
2. Redeploy Manufact and Sites after #57/#59/#60 so the live text matches the code; rerun `pnpm smoke:live`.
3. Deferred issues, by demo impact: #54 (owner link scope), #55 (capture upload cap), #33 (worker earnings page), #28 (key revocation), #29 (withdraw to card), #30 (per-task event trail), #31 (durable expiry), #32 (hosted read-only dashboard), #34 (worker report), #36/#42 done.
4. **T3.4b Armature** analytics once the key and their mcp-use answer land; **T3.5b Blaxel** swarm and eval sandboxes once BL keys land (never on the golden path).
5. **Phase 4**: fill docs/SUBMISSION.md TODO slots from STATUS live verification, record the 90 s video from docs/DEMO.md, backup video, final README pass.

## 4. When each key lands (exact steps)

Order agreed with the humans: Inkbox (in person) -> Manufact -> InsForge -> Stripe -> Primitive -> Armature. Anthropic is a prerequisite for any live mode: without `ANTHROPIC_API_KEY` the server refuses `EYES_PROVIDERS=live` on purpose (the safety classifier and photo verification would be off).

Set server env with `npx mcp-use servers env set 0526925a-58ae-4d83-9c3b-ed378926c260 KEY=VALUE` (secrets with `--secret` where supported), then `npx mcp-use deployments restart <running id>` (env is read at start; merges do not auto-deploy). Code changes: `npx mcp-use deploy --yes --dockerfile Dockerfile` from an up-to-date main.

| Key | Steps | Proof (live-verified) |
|---|---|---|
| `ANTHROPIC_API_KEY` | set on server, set `EYES_PROVIDERS=live`; add as repo secret (enables `claude-verifier.yml`, `safety-llm-eval.yml`); run `pnpm safety:eval` locally with the key | `/healthz` shows vision live; `safety-llm-eval` precision/recall recorded; a refusal for "photograph the house at 123 Oak St" over MCP |
| Inkbox iMessage line | done 2026-10-17: free plan, shared line +16504849720, identity `hackathon`, `imessage.received` subscribed to `/webhooks/inkbox`, `INKBOX_API_KEY`, `INKBOX_AGENT_HANDLE`, signing key and auth token set on the server. Left for when live mode is on: set `INKBOX_PHONE_NUMBER=+16504849720`, rebuild worker web with `VITE_INKBOX_NUMBER=+16504849720 VITE_INKBOX_CONNECT="connect @hackathon"` and redeploy Sites; each worker iPhone texts `connect @hackathon`, then START | G1 live: Claude -> ask_eyes -> teammate iPhone gets the offer -> YES -> capture link -> photo -> Claude gets the answer |
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
