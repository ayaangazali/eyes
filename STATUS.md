# STATUS

Updated: 2026-10-17 03:55 PT by orchestrator. 24 PRs merged this session. Live: Manufact (9 tools) + InsForge (DB 001-008, Sites). Open: #53 (owner link to payer). Building: T4.9 payouts. Auditing: full-main security sweep, fresh-eyes journeys. Waits on vendor keys: docs/PLAN.md §4.

## Task board

| Task | Owner | State | PR | Verdicts | Blocker |
|---|---|---|---|---|---|
| T0.1 vendor notes | docs-researcher x7 | done | (initial commit) | n/a | none |
| T0.2 scaffold + CI | orchestrator | done | (initial commit) | n/a | none |
| T0.3 contracts + migration v1 + fakes | orchestrator | done | (initial commit) | n/a | none |
| T0.4 agents, hooks, intent system | orchestrator | done | (initial commit) | n/a | none |
| T1.1 MCP tools + REST + worker API | mcp-builder | **merged** #2 | [#2](https://github.com/ayaangazali/eyes/pull/2) | r3 security+ax PASS | live-verified: no |
| T1.2 engine + db | engine-builder | **merged** #6, #12 | [#6](https://github.com/ayaangazali/eyes/pull/6) | r2 security PASS, test+spec PASS; follow-up PASS | InsForge grants unverified live |
| T1.3 Inkbox comms | comms-builder | **merged** #1, #10; iMessage send #24 merging | [#1](https://github.com/ayaangazali/eyes/pull/1) | r2 all PASS; follow-up #10 PASS | live-verified: no |
| T1.4 worker web | worker-web-builder | **merged** #3, #13; live on InsForge Sites | [#3](https://github.com/ayaangazali/eyes/pull/3) | r2 PASS; #13 coverage major downgraded by ruling | live-verified: no |
| T1.5 safety | safety-builder | **merged** #7 (round 7 PASS) | [#7](https://github.com/ayaangazali/eyes/pull/7) | r6 FAIL (3 majors, false positives), r7 PASS; deferred #36 | live: rules refusal yes; classifier needs ANTHROPIC_API_KEY |
| G1 golden path e2e | integration builder | **merged** #16 | [#16](https://github.com/ayaangazali/eyes/pull/16) | integration PASS (3/3 fresh DBs, mutations killed) | unsafe_task test skipped until T1.5 |
| T2.1 Stripe | payments-builder | **merged** | [#5](https://github.com/ayaangazali/eyes/pull/5) | r1 security PASS, spec+intent PASS, test FAIL; r2 PASS | live-verified: no |
| T2.2 verification | verification-builder | **merged** #4, #8 | [#4](https://github.com/ayaangazali/eyes/pull/4) | all PASS | live-verified: no |
| T2.3 deploy | orchestrator | **live**: Manufact (MCP/REST/docs), InsForge (DB 001-007, storage, Sites) | | smoke:live 13/13 | vendor keys |
| T2.4 MCP wiring + hardening | mcp-builder | **merged** #14 (human decision B) | [#14](https://github.com/ayaangazali/eyes/pull/14) | escalated after r3; deferred #21-#23 | live-verified: no |
| T3.1 Primitive | comms-builder | **merged** #11 (human decision B) | [#11](https://github.com/ayaangazali/eyes/pull/11) | escalated after r3; deferred #17-#20 | live-verified: no |
| T3.2 AX docs + CLI | ax-builder | **merged** #9, docs served live | [#9](https://github.com/ayaangazali/eyes/pull/9) | r5 FAIL, r6 PASS; deferred #42 | none |
| T3.3 dashboard | dashboard-builder | **merged** #15 | [#15](https://github.com/ayaangazali/eyes/pull/15) | combined PASS (no PII leak, XSS-safe, loopback only) | live-verified: no |
| T3.4a AX eval harness | ax-builder | **merged** #43; client B runs in CI | [#43](https://github.com/ayaangazali/eyes/pull/43) | PASS; polish reviewed | client A needs ANTHROPIC_API_KEY |
| T3.4b Armature analytics | | blocked | | | key + sponsor answer on mcp-use |
| T2.5 owner console (ADR-011) | payments-builder | **merged** #35, live-verified | [#35](https://github.com/ayaangazali/eyes/pull/35) | security PASS, spec+test PASS, polish reviewed; #38 filed | none |
| T4.1 hardening (#17-#23, throttles) | mcp/comms builder | **merged** #37 | [#37](https://github.com/ayaangazali/eyes/pull/37) | PASS; XFF key cap queued in T4.4 | none |
| T2.3b smoke:live | ops builder | **merged** #26 | [#26](https://github.com/ayaangazali/eyes/pull/26) | PASS (2 minors in Known gaps) | none |
| T4.5 UI fixes (UX audit 0-6, 8, 11, 12, 15-23) | ui builder | **merged** #47; Sites redeployed | [#47](https://github.com/ayaangazali/eyes/pull/47) | UX re-audit PASS (18/19 fixed, 1 partial by design) | real-iPhone check pending |
| T4.6 dispatch skips busy workers; YES claims open offer | engine/comms builder | **merged** #39; 006 applied to InsForge | [#39](https://github.com/ayaangazali/eyes/pull/39) | PASS; race minor fixed with a worker row lock | none |
| T3.5a demo e2e + swarm | integration builder | **merged** #40 | [#40](https://github.com/ayaangazali/eyes/pull/40) | PASS: 45/45 demo runs; G3 machine check `pnpm test:demo` | none |
| T3.5b Blaxel batch/sandboxes | | queued | | | BL keys, after G2 |
| UX/UI audit | ux auditor | **done**: 1 blocker, 12 major, 12 minor; 46 screenshots | | | fixes in T4.5/T4.6; 9, 10, 13, 24 queued after T2.5/T4.1 |
| T4.4 HOME/status pages, guards | mcp/payments builder | **merged** #44 | [#44](https://github.com/ayaangazali/eyes/pull/44) | PASS | none |
| T4.2 payout retry + operator resolve (ADR-012) | engine builder | **merged** #45; 007 applied to InsForge | [#45](https://github.com/ayaangazali/eyes/pull/45) | r1 FAIL (fake-provider resolve, inactive-account transfers), r2 PASS | #46, #52 follow-ups |
| T4.3 worker STOP/START/HELP replies | engine builder | **merged** #48 | [#48](https://github.com/ayaangazali/eyes/pull/48) | PASS; Inkbox cap does not apply (vendor quote) | none |
| T4.8 delete face-rejected photos (ADR-014) | engine/db builder | **merged** #49 | [#49](https://github.com/ayaangazali/eyes/pull/49) | PASS; live InsForge delete verified | none |
| T5.1 README, submission, demo runbook | docs builder | **merged** #41 | [#41](https://github.com/ayaangazali/eyes/pull/41) | r1 FAIL (2 majors), fixed | TODO slots after keys |
| T3.6 list_tasks + honest quote (ADR-013) | ax builder | **merged** #50; 008 applied; live (9 tools) | [#50](https://github.com/ayaangazali/eyes/pull/50) | PASS (160-policy quote-honesty probe, 0 failures) | none |
| T4.7 CLI write-back guard + safety precision (#42, #36) | builder | **merged** #51 | [#51](https://github.com/ayaangazali/eyes/pull/51) | PASS; 3 guard fixtures added | none |
| T4.9 payout recovery + no starvation (#46, #52) | engine builder | building | | | none |
| T4.10 owner link to the Checkout payer (#38, ADR-015) | payments builder | verifying | [#53](https://github.com/ayaangazali/eyes/pull/53) | | none |
| SPEC coverage ledger | auditor | **done**: 140 rows (62 met, 29 partial, 4 unmet, 33 key, 6 human, 6 in flight); 15 gaps | | | gaps queued in PLAN §3 or filed #27-#34 |

## Sponsor coverage (update at every gate)

Live verification order once keys land: Inkbox (G1; set up in person at the event) -> Manufact deploy -> InsForge -> Stripe -> Primitive -> Armature. Supabase: not used unless the humans confirm its track brief.

| Sponsor | What we use | PR(s) | live-verified | What the demo shows |
|---|---|---|---|---|
| Manufact (mcp-use) | **Deployed** (redeployed by hand after merges; https://dark-wave-wfmpm.run.mcp-use.com/mcp). MCP server on mcp-use 2.10: 8 tools with LLM-first descriptions, bearer auth, REST mirror, worker API, byte-safe Node adapter; deployed on Manufact Cloud via the repo Dockerfile | #2, #14, T2.3 | partial (routing yes, providers fake) | Claude calls quote_task -> ask_eyes -> await_answer against the Manufact URL; Manufact dashboard shows sessions and gateway requests |
| InsForge | Postgres (escrow ledger, race-safe claim, expiry as plpgsql over RPC; RLS on every table), photo storage (`photos` bucket), Sites hosting for the worker capture page (https://7t6779x4.insforge.site) | #6, #12, #14, #15, T2.3 | **yes** (DB + Sites; storage pending first live capture) | capture page served from *.insforge.site; photo URL from InsForge storage; dashboard reads `eyes_dashboard_feed` |
| Stripe | Checkout top-ups (card only), per-key spend policy, Connect Express onboarding minted on click, $3 transfer on a verified answer, signed webhooks, refund on expiry/cancel | #5, #6 | no | top-up in Checkout, the worker's connected account, the transfer in the Stripe dashboard; get_spend_policy limits; refund path |
| Inkbox | iMessage line (chosen for cost): offer, capture link and paid texts; signed `imessage.received` webhook for START/YES | #1, #10, #24 | no | worker iPhone gets the offer, replies YES, gets the capture link and the paid text |
| Primitive | Capability email address per agent (ADR-007); inbound email -> ask_eyes; threaded answer with the photo attached; DMARC-verified senders only | #11 | no | an agent emails its Eyes address and gets a threaded reply with the photo |
| Armature | Agent experience: llms.txt, llms-full.txt, openapi.json, agent card, robots.txt, agents.md, `eyes` CLI, every error with a fix; AX eval harness (#43); analytics in T3.4 (their SDK does not list mcp-use; sponsor answer needed) | #9, #14, #43 | docs served live; analytics no | an agent onboards from llms.txt alone; Armature analytics/eval once wired |
| Blaxel | T3.5 (low priority, after G2): eval agents in Blaxel sandboxes; "swarm" demo mode with ~50 simulated agents via batch jobs; never on the golden path | none yet | no | dashboard map lights up with simulated agents |
| Anthropic (models, not a track) | Claude vision verification, Haiku safety classifier | #4, #8, #7 | no | verification checks on the answer; polite refusal |

## Deferred (ADR-010; triage at feature freeze, 6:00 AM Sun)

#17-#23 fixed by PR #37 (2026-10-17).

| Item | From | Tracking |
|---|---|---|
| iMessage from an Apple ID email is ignored (workers must send from the phone number) | PR #24 | [#25](https://github.com/ayaangazali/eyes/issues/25) |
| Four contrived benign phrasings still rule-blocked | PR #7 r7 | [#36](https://github.com/ayaangazali/eyes/issues/36) |
| Face-rejected photos stay in the public bucket | coverage ledger | [#27](https://github.com/ayaangazali/eyes/issues/27) |
| No per-agent key / link revocation | coverage ledger | [#28](https://github.com/ayaangazali/eyes/issues/28) |
| No withdrawal of unused balance to card | coverage ledger | [#29](https://github.com/ayaangazali/eyes/issues/29) |
| Owner link goes to an address the agent chooses | PR #35 security | [#38](https://github.com/ayaangazali/eyes/issues/38) |
| Stripe-refused transfer blocked ~24 h under reused key | PR #45 | [#46](https://github.com/ayaangazali/eyes/issues/46) |
| Payout batch starvation; opted-out capture-page line | PR #45 r2 | [#52](https://github.com/ayaangazali/eyes/issues/52) |
| Money/dispatch failures only in console logs | coverage ledger | [#30](https://github.com/ayaangazali/eyes/issues/30) |
| Expiry runs in-process only | coverage ledger | [#31](https://github.com/ayaangazali/eyes/issues/31) |
| Dashboard loopback-only | coverage ledger | [#32](https://github.com/ayaangazali/eyes/issues/32) |
| No worker earnings page | coverage ledger | [#33](https://github.com/ayaangazali/eyes/issues/33) |
| Worker task report (SPEC §12 stretch) | coverage ledger | [#34](https://github.com/ayaangazali/eyes/issues/34) |

Earlier verifier minors (non-blocking by severity) are in each task's intent Known gaps.

## Live verification

| Integration | live-verified | Evidence |
|---|---|---|
| Manufact deploy (mcp-use) | **yes** for routing, MCP and agent docs (2026-10-17 03:55 PT: deploy c7e4c396 at main aa894e4, 9 MCP tools incl. list_tasks, smoke 13 PASS. 03:40 PT: deploy ec837deb at main 2ebc6da (#43-#49), `/status` shows the commit, HOME 200, smoke:live 13 PASS / 0 FAIL. Earlier, 03:10 PT: `EYES_PUBLIC_API_URL=https://dark-wave-wfmpm.run.mcp-use.com pnpm smoke:live` on deploy b2df1ae5 (main after #9): 13 PASS, 0 FAIL: healthz, /llms.txt, /openapi.json, agent card, signup, balance, spend-policy, MCP tools/list (8), MCP get_balance, MCP quote_task, three unsigned webhooks rejected). First deploy 2026-10-17 01:52 PT: | Deployed with `mcp-use deploy --no-github` + repo Dockerfile; server `dark-wave-wfmpm`, MCP URL https://dark-wave-wfmpm.run.mcp-use.com/mcp. Gateway forwards ALL paths (ADR-004 risk resolved): /healthz 200, / HTML, /v1/balance 401, /w/offers/x 404 offer_invalid, /topup/done 200, POST /webhooks/inkbox unsigned 401, /mcp without key 401. Now backed by InsForge Postgres (see below); vendors still fake until keys land. |
| InsForge DB + storage + Sites | **yes** (2026-10-17 02:10 PT) | Migrations 001-004 applied to project `hackathon`; anon denied on functions and tables; `photos` bucket. Manufact deploy 35d2cc74 `/healthz` -> `"db":"insforge"`; live signup -> balance -> spend-policy served from InsForge Postgres. Worker web live at https://7t6779x4.insforge.site (Sites deployment 5f2bbf5a). Photo upload to storage not yet exercised live (needs a capture). |
| Inkbox outbound + inbound | no | |
| Stripe Checkout + Connect + transfer | no | |
| Primitive inbound + threaded reply | no | |
| Owner console (ADR-011, Stripe user control) | **yes** (2026-10-17 02:55 PT) | Migration 005 applied to InsForge (201; anon gets 404 on both functions). Deploy e444ec99 (main c8b4af8): owner link from `scripts/owner-link.ts` -> GET 200 with `cache-control: no-store`, `referrer-policy: no-referrer`; form POST max $2 / cap $5 / 2 types -> 303; the agent's `GET /v1/spend-policy` shows the new limits; the agent's next $3 ask -> `bounty_exceeds_max` with fix "Lower bounty_usd to 2 or less"; refund copy on the page; malformed token -> 404. |
| Safety gate, rules layer | **yes** (2026-10-17 02:33 PT) | Deploy 9e99b696 (main 433b76a): live `POST /v1/tasks` "Photograph the house at 12 Pine St." -> 422 `unsafe_task` / private_residence with a fix; live `POST /v1/quote` for the Ferry Building -> 200 (`allowed: true`); a safe ask -> 409 `no_workers_nearby`, nothing charged. Classifier layer not live (no ANTHROPIC_API_KEY). |
| Claude vision verification | no | |
| Armature analytics | no | |

## Needs from humans (G0)

Keys go in `.env` at the repo root (never committed) and later as Manufact env vars. Exact names are in `.env.example`.

1. InsForge: create a project. `INSFORGE_BASE_URL`, `INSFORGE_ANON_KEY`, `INSFORGE_API_KEY` (ik_...).
2. Inkbox: console API key `INKBOX_API_KEY`; create identity `eyes-dispatch` with a US number (`INKBOX_PHONE_NUMBER`). Provision at least 1 hour before any live text (10DLC takes 10 to 15 min). Every worker phone must text START to it first.
3. Stripe: new sandbox, enable Connect and set platform branding. `STRIPE_SECRET_KEY` (sk_test_). At deploy, two event destinations both pointing to `/webhooks/stripe`: "Your account" with `checkout.session.completed` (`STRIPE_WEBHOOK_SECRET`) and "Connected accounts" with `account.updated` (`STRIPE_CONNECT_WEBHOOK_SECRET`). Pre-fund the platform with card 4000 0000 0000 0077 before demos.
4. Primitive: sign up, note the auto-assigned `*.primitive.email` domain (`PRIMITIVE_DOMAIN`), `PRIMITIVE_API_KEY`, `PRIMITIVE_WEBHOOK_SECRET`. Ask staff to enable `send_to_any_domain`.
5. Anthropic: `ANTHROPIC_API_KEY` (vision + safety classifier). Also add it as a repo secret to enable `claude-verifier` and `safety-llm-eval`.
6. Manufact: `MCP_USE_API_KEY` and org slug.
7. Armature: `ANALYTICS_INGEST_API_KEY`; ask them to enable Evaluation; confirm mcp-use support.
8. Decisions: worker phones for the demo (whose, how many), demo cafe, public domain (or use Manufact + InsForge default URLs).
9. Hackathon rules: the event page publishes no rule on pre-start code. Ask the organizers (host Ray Liao) before 10:30 AM. The repo's first commit is 2026-10-16 22:47 PT; docs/SUBMISSION.md has a TODO to disclose it per their answer.
10. Privacy contact: who the worker privacy page (apps/web/worker/privacy.html, PR #47) names for data deletion requests (an email address the team monitors).
