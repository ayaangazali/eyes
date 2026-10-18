# Eyes: build plan to submission

Living plan. `STATUS.md` is the task board; this file says what remains, who does it, what blocks it, and the exact steps when each key lands. Updated by the orchestrator at every gate.

Hacking: Sat Oct 17 10:30 AM to Sun Oct 18 10:00 AM (submissions). Feature freeze 6:00 AM Sun.

## 1. Where we are (hosting updated 2026-10-18; other verification dated below)

| Area | State |
|---|---|
| Live mode | Manufact Cloud hosts the MCP/API application; Cloudflare supplies the edge and static sites. ChatGPT and Claude use `https://mcp.eyes.pictures/mcp`; REST/uploads/webhooks stay at `https://api.eyes.pictures`, whose legacy MCP endpoint remains supported. |
| Current verification | Dedicated-host OAuth/card metadata and live API are verified; 13 model-visible tools plus app-only `confirm_ask` share the current service. Interactive `ask_eyes` is a read-only draft until explicit card confirmation. Photo moderation rejects confirmed graphic gore or explicit sexual content, not faces alone. |
| Remaining limits | Stripe provider is live but payments/$20 credit are test-only. Follow-up visual checks on the operator's ChatGPT/Claude test accounts were quota-blocked on 2026-10-18, not unavailable for all users. Primitive unrestricted sending and external custom-alias SPF remain unresolved. |
| CI and tests | lint, typecheck, unit, contract, integration, golden and demo e2e, safety rules, intent, secrets; `pnpm ax:eval` (Claude client passes locally); `safety-llm-eval` and the Claude PR reviewer run with the repo secret |
| Agent experience | 13 model-visible MCP tools (12 plus `show_task`), app-only `confirm_ask`, unchanged direct REST/CLI dispatch, llms.txt, openapi.json, agent card, every error with a fix |

The dedicated MCP host is live and both web clients are configured there; not every third-party connector has migrated. Marketplace 1.0.3 is a configured draft with preflight complete, **not submitted or published**. Legal owner attestations and test-mode limits remain.

## 2. Work in flight

| Task | What | Status |
|---|---|---|
| T4.26 (#80) | fewer false refusals from the Claude classifier; recall stayed 1.000 on 3 runs, 34 adversarial tasks blocked | shipped; STATUS records the 2026-10-17 11:00 PT live verification |
| T4.27 (#81, fixes #78) | place lookup must not pick the wrong branch of a chain store | shipped; STATUS records the 2026-10-17 12:03 PT live verification |

Every PR: spec + test + intent verifiers, security on money/auth/webhooks/safety, ax on agent surfaces. Auto-merge on PASS + green CI. ADR-010 decides blocking vs deferred. Verdicts live in `intent/verdicts/`.

## 3. Next (in order)

1. **Client visuals:** record a fresh in-chat ChatGPT/Claude visual result only after account quotas permit it; current API/card-protocol verification is not that result.
2. **Marketplace:** retain draft status until the legal owner completes attestations and explicitly submits/publishes; keep test-payment limits visible.
3. **Email:** preserve iMessage-only onboarding and first-contact Inkbox fallback; do not claim unrestricted Primitive delivery or resolved external-alias SPF.
4. Deferred issues, by demo impact: #28 (link revocation), #29 (withdraw to card), #30 (per-task event trail), #31 (durable expiry), #34 (worker report), #38 (owner link address), #54 (masked owner email), #71.
5. **Phase 4**: remaining SUBMISSION TODOs from STATUS, the 90 s video from docs/DEMO.md, backup video, final README pass.

## 4. Historical key-onboarding sequence

Order agreed with the humans: Inkbox (in person) -> Manufact -> InsForge -> Stripe -> Primitive -> Armature. Anthropic is a prerequisite for any live mode: without `ANTHROPIC_API_KEY` the server refuses `EYES_PROVIDERS=live` on purpose (the safety classifier and photo verification would be off).

Current deployment and recovery guidance is in [DEPLOY §2](DEPLOY.md#2-mcp-server-on-manufact-cloud). The dated provisioning rows below record earlier setup, not current instructions to wait for keys or redeploy to InsForge Sites. Preserve the Manufact origin and separate MCP/REST public hosts.

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
| Manufact server deploy breaks | use the last verified Manufact deployment and the current recovery procedure in [DEPLOY §2](DEPLOY.md#2-mcp-server-on-manufact-cloud); preserve the public domains and Cloudflare forwarder. Do not silently switch the API back to a Cloudflare Container |
