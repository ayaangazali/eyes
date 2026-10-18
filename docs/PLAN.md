# Eyes: build plan to submission

Living plan. `STATUS.md` is the task board; this file says what remains, who does it, what blocks it, and the exact steps when each key lands. Updated by the orchestrator at every gate.

Hacking: Sat Oct 17 10:30 AM to Sun Oct 18 10:00 AM (submissions). Feature freeze 6:00 AM Sun.

## 1. Where we are (2026-10-17 10:53 PT)

| Area | State |
|---|---|
| Live mode | `EYES_PROVIDERS=live` on Manufact (main fec9f09): Inkbox texting (shared line +16504849720, `connect @hackathon` then START), Claude vision and safety classifier, InsForge storage, place lookup. Stripe and Primitive simulated, and every worker-facing text and page says so (#75) |
| Live-verified (STATUS) | safety rules and classifier refusals; Claude vision verdicts; face-photo deletion; real Claude over the MCP connector through quote, ask and await with a stand-in worker; worker sign-up page against the live API; owner console; smoke 13/13 |
| Not yet live-verified | a real iMessage to a phone (G1), Stripe top-up and transfer (G2), Primitive email thread, Armature analytics |
| CI and tests | lint, typecheck, unit, contract, integration, golden and demo e2e, safety rules, intent, secrets; `pnpm ax:eval` (Claude client passes locally); `safety-llm-eval` and the Claude PR reviewer run with the repo secret |
| Agent experience | 10 MCP tools (9 plus the `show_task` card), REST mirror, llms.txt, openapi.json, agent card, `eyes` CLI, every error with a fix |

## 2. Work in flight

| Task | What | Status |
|---|---|---|
| T4.26 (#80) | fewer false refusals from the Claude classifier; recall stayed 1.000 on 3 runs, 34 adversarial tasks blocked | merged 10:51 PT; needs a server redeploy |
| T4.27 (#81, fixes #78) | place lookup must not pick the wrong branch of a chain store | verifying |

Every PR: spec + test + intent verifiers, security on money/auth/webhooks/safety, ax on agent surfaces. Auto-merge on PASS + green CI. ADR-010 decides blocking vs deferred. Verdicts live in `intent/verdicts/`.

## 3. Next (in order)

1. **G1 with a person**: a teammate iPhone joins, texts `connect @hackathon` then START, gets an offer for a real task at Blue Bottle Mint Plaza, replies YES, captures; record it in STATUS and SUBMISSION.
2. **Stripe** when the key lands (section 4), then rebuild Sites with `VITE_LIVE_PAYOUTS=true`; G2.
3. **Primitive** when the key lands; the email beat of the demo.
4. Deferred issues, by demo impact: #28 (link revocation), #29 (withdraw to card), #30 (per-task event trail), #31 (durable expiry), #34 (worker report), #38 (owner link address), #54 (masked owner email), #71.
5. **Phase 4**: remaining SUBMISSION TODOs from STATUS, the 90 s video from docs/DEMO.md, backup video, final README pass.

## 4. When each key lands (exact steps)

Order agreed with the humans: Inkbox (in person) -> Manufact -> InsForge -> Stripe -> Primitive -> Armature. Anthropic is a prerequisite for any live mode: without `ANTHROPIC_API_KEY` the server refuses `EYES_PROVIDERS=live` on purpose (the safety classifier and photo verification would be off).

Set server env with `npx mcp-use servers env set 0526925a-58ae-4d83-9c3b-ed378926c260 KEY=VALUE` (secrets with `--secret` where supported), then `npx mcp-use deployments restart <running id>` (env is read at start; merges do not auto-deploy). Code changes: `npx mcp-use deploy --yes --dockerfile Dockerfile` from an up-to-date main.

| Key | Steps | Proof (live-verified) |
|---|---|---|
| `ANTHROPIC_API_KEY` | done 2026-10-17 09:40 PT: set on the server with `EYES_PROVIDERS=live`, added as the repo secret; `pnpm safety:eval` precision 0.946, recall 1.000 | STATUS: classifier refusals, vision verdicts and face deletion live-verified |
| Inkbox iMessage line | done 2026-10-17: free plan, shared line +16504849720, identity `hackathon`, `imessage.received` subscribed to `/webhooks/inkbox`, `INKBOX_API_KEY`, `INKBOX_AGENT_HANDLE`, signing key and auth token set on the server. `INKBOX_PHONE_NUMBER=+16504849720` set on the server at 09:45 PT (deploy c1824102); Sites built with `VITE_INKBOX_NUMBER=+16504849720 VITE_INKBOX_CONNECT="connect @hackathon"` (6ac27658, now ca4391f9) (add `VITE_LIVE_PAYOUTS=true` and redeploy Sites once `STRIPE_SECRET_KEY` is set); each worker iPhone texts `connect @hackathon`, then START | G1 live: Claude -> ask_eyes -> teammate iPhone gets the offer -> YES -> capture link -> photo -> Claude gets the answer |
| Stripe sandbox | set `STRIPE_SECRET_KEY`, then rebuild the worker web with `VITE_LIVE_PAYOUTS=true` and redeploy Sites (without it the JOIN and capture pages keep saying payouts are simulated); create both event destinations (account: `checkout.session.completed`; connected accounts: `account.updated`) to `/webhooks/stripe`, set both secrets; pre-fund with 4000 0000 0000 0077; worker texts START and onboards through the payout link | G2: top-up via Checkout credits the balance; verified answer creates a $3 transfer visible in the Stripe dashboard; expiry refunds |
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
| Claude API slow or down during the demo | the classifier fails closed within 12 seconds (refusal, nothing charged) and vision sends the task to review; rules still refuse the demo's unsafe task |
| Venue GPS drift | verify radius 150 m; capture at the cafe door |
| Manufact deploy breaks on a merge | redeploy the previous deployment (`npx mcp-use deployments restart <id>`); the same Docker image runs anywhere |
