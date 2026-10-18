# STATUS

Updated: 2026-10-17 06:45 PT by orchestrator. 46 PRs merged in total, 0 open. Live: Manufact a26cb06b (main e8f423f) + InsForge (DB 001-014, Sites) + ops dashboard. Everything left needs vendor keys, a person, or a product decision: docs/PLAN.md §4 and 'Needs from humans'.

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
| T4.9 payout recovery + no starvation (#46, #52) | engine builder | **merged** #57; 009 applied; live | [#57](https://github.com/ayaangazali/eyes/pull/57) | r1 FAIL, r2 FAIL, r3 PASS (1315 retry sequences, 0 double pays except accepted S6 class) | none |
| T4.14 NO after YES releases the claim | engine builder | **merged** #61; 010 applied; live | [#61](https://github.com/ayaangazali/eyes/pull/61) | PASS (200 race reps); follow-up #62 | none |
| T4.15 capture upload cap (#55) | builder | **merged** #64; live | [#64](https://github.com/ayaangazali/eyes/pull/64) | PASS (60 s read deadline, per-token cap, ~74 MB/upload measured) | none |
| T4.16 owner key rotation (#28, ADR-019) | builder | **merged** #63; 011 applied; live | [#63](https://github.com/ayaangazali/eyes/pull/63) | PASS (old key dies on REST and MCP at once) | per-link revocation still open (#28) |
| T4.17 worker earnings page (#33, ADR-020) | builder | **merged** #65; 012 applied; live | [#65](https://github.com/ayaangazali/eyes/pull/65) | PASS (e: token isolation, no setup link on a forwardable page) | none |
| T4.18 re-offer on release; no orphan photos (#62) | builder | **merged** #66; 013 applied; live | [#66](https://github.com/ayaangazali/eyes/pull/66) | PASS; re-offer capped once per worker per task | none |
| T4.19 ops dashboard on the deployed server (#32) | builder | **merged** #67; live at /ops/<key> | [#67](https://github.com/ayaangazali/eyes/pull/67) | PASS (no feed read on a wrong key; key in 0 logs) | key held by the orchestrator; ask for the link |
| T4.20 owner link scope (#54) | builder | **merged** #68; 014 applied; live | [#68](https://github.com/ayaangazali/eyes/pull/68) | security PASS; race test added | masked owner email (item 2) dropped: needs a column |
| T5.2 docs refresh | docs builder | **merged** #69 | [#69](https://github.com/ayaangazali/eyes/pull/69) | accuracy PASS; minors fixed | none |
| Second full-main security sweep | auditor | **done**: 0 blocker, 0 major, 3 minor (public page headers, /w/join membership oracle, precise worker coords on the hosted ops feed); token matrix, rotation, money invariants and grants all sound | | | minors in T4.21 |
| Second fresh-eyes journey audit | auditor | **done**: 0 blocker, 2 major, 12 minor; 102 doc promises: 62 true, 2 false (ADR count), 38 need keys; all 10 false promises from the first audit now true | | | fixes in T4.22a/b; operator contact needs a human |
| T4.22a agent/owner AX fixes | builder | building | | | none |
| T4.22b worker-facing fixes | builder | building | | | none |
| T4.21 sweep-2 minors (headers, join oracle, coarse ops feed; ADR-021) | builder | **merged** #70; live | [#70](https://github.com/ayaangazali/eyes/pull/70) | PASS; timing side channel -> #71 | none |
| T4.11b honest owner-email claim (ADR-018) | builder | **merged** #59 | [#59](https://github.com/ayaangazali/eyes/pull/59) | PASS | none |
| T4.13 user-facing text matches the running system | builder | **merged** #60 | [#60](https://github.com/ayaangazali/eyes/pull/60) | PASS | none |
| T4.10 owner link to the Checkout payer (#38, ADR-015) | payments builder | **merged** #53 | [#53](https://github.com/ayaangazali/eyes/pull/53) | security PASS; follow-ups #54 | none |
| T4.11a honest surfaces (closed sign-up without a line, simulated/classifier status, required idempotency_key; ADR-017) | builder | **merged** #58 | [#58](https://github.com/ayaangazali/eyes/pull/58) | PASS | none |
| T4.12 SECURITY: forged Stripe webhook on fake-payment deploys | builder | **merged** #56; **closed live** (deploy 6fbfd899: forged POST /webhooks/stripe -> 404) | [#56](https://github.com/ayaangazali/eyes/pull/56) | security PASS (26 variants) | none |
| Full-main security sweep | auditor | **done**: 1 blocker (forged fake Stripe webhook -> T4.12), 2 major (XFF bypass: refuted on Manufact, gateway appends the real address, 7 spoofed signups hit 429 at the 4th; owner-email relay -> #54), 2 minor (#55) | | | |
| Fresh-eyes journey audit | auditor | **done**: 2 blockers, 9 major, 9 minor; 68 doc promises: 32 true, 10 false, 26 need keys | | | fixes in T4.11a/b |
| SPEC coverage ledger | auditor | **done**: 140 rows (62 met, 29 partial, 4 unmet, 33 key, 6 human, 6 in flight); 15 gaps | | | gaps queued in PLAN §3 or filed #27-#34 |

## Sponsor coverage (update at every gate)

Live verification order once keys land: Inkbox (G1; set up in person at the event) -> Manufact deploy -> InsForge -> Stripe -> Primitive -> Armature. Supabase: not used unless the humans confirm its track brief.

| Sponsor | What we use | PR(s) | live-verified | What the demo shows |
|---|---|---|---|---|
| Manufact (mcp-use) | **Deployed** (redeployed by hand after merges; https://dark-wave-wfmpm.run.mcp-use.com/mcp). MCP server on mcp-use 2.10: 9 tools with LLM-first descriptions, bearer auth, REST mirror, worker API, byte-safe Node adapter; deployed on Manufact Cloud via the repo Dockerfile | #2, #14, T2.3 | partial (routing yes, providers fake) | Claude calls quote_task -> ask_eyes -> await_answer against the Manufact URL; Manufact dashboard shows sessions and gateway requests |
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
| Owner link payer scope, masked owner email, agent name in signup email | PR #53 | [#54](https://github.com/ayaangazali/eyes/issues/54) |
| Global capture upload cap stalls all workers | security sweep | [#55](https://github.com/ayaangazali/eyes/issues/55) (T4.15 building) |
| Released claims: re-offer; orphaned photo on NO-vs-capture race | PR #61 | [#62](https://github.com/ayaangazali/eyes/issues/62) (fixed by #66) |
| POST /w/join timing side channel | PR #70 | [#71](https://github.com/ayaangazali/eyes/issues/71) |
| Money/dispatch failures only in console logs | coverage ledger | [#30](https://github.com/ayaangazali/eyes/issues/30) |
| Expiry runs in-process only | coverage ledger | [#31](https://github.com/ayaangazali/eyes/issues/31) |
| Dashboard loopback-only | coverage ledger | [#32](https://github.com/ayaangazali/eyes/issues/32) |
| No worker earnings page | coverage ledger | [#33](https://github.com/ayaangazali/eyes/issues/33) |
| Worker task report (SPEC §12 stretch) | coverage ledger | [#34](https://github.com/ayaangazali/eyes/issues/34) |

Earlier verifier minors (non-blocking by severity) are in each task's intent Known gaps.

## Live verification

| Integration | live-verified | Evidence |
|---|---|---|
| Manufact deploy (mcp-use) | **yes** for routing, MCP and agent docs (2026-10-17 06:45 PT: deploy a26cb06b at main e8f423f; HOME sends CSP and no-referrer; smoke 13 PASS. 06:05 PT: deploy 03c5dd9e at main 4eebc47 with first-payer owner scope; 014 applied; smoke 13 PASS. 06:00 PT: deploy 2785276d at main d96b1db; EYES_OPS_KEY set as a write-only secret; /ops/<key> 200 and /ops/<key>/feed 200, wrong key 404; smoke 13 PASS. 05:45 PT: deploy c6beb519 at main 6b6e924 with re-offer; 013 applied; smoke 13 PASS. 05:30 PT: deploy dc1493ea at main fd3f3fa with key rotation, earnings page, upload deadline; 011-012 applied; bad earnings token 404, GET rotate 404; smoke 13 PASS. 05:00 PT: deploy 8a0ab65c at main 8f6e5c6 with release-on-NO; 010 applied; smoke 13 PASS; Sites 7f450f07. 04:55 PT: deploy 63bba472 at main 40ecee4 with payout recovery; 009 applied; smoke 13 PASS; no payout-loop errors in logs. 04:35 PT: deploy c7116a68 at main 9112dbc; `/status` shows "simulated deploy" and "Safety review: rules only"; smoke 13 PASS. Sites deployment 13c4ca58: JOIN shows "Worker sign-up opens soon" and the iPhone note until the Inkbox line exists. 03:55 PT: deploy c7e4c396 at main aa894e4, 9 MCP tools incl. list_tasks, smoke 13 PASS. 03:40 PT: deploy ec837deb at main 2ebc6da (#43-#49), `/status` shows the commit, HOME 200, smoke:live 13 PASS / 0 FAIL. Earlier, 03:10 PT: `EYES_PUBLIC_API_URL=https://dark-wave-wfmpm.run.mcp-use.com pnpm smoke:live` on deploy b2df1ae5 (main after #9): 13 PASS, 0 FAIL: healthz, /llms.txt, /openapi.json, agent card, signup, balance, spend-policy, MCP tools/list (8), MCP get_balance, MCP quote_task, three unsigned webhooks rejected). First deploy 2026-10-17 01:52 PT: | Deployed with `mcp-use deploy --no-github` + repo Dockerfile; server `dark-wave-wfmpm`, MCP URL https://dark-wave-wfmpm.run.mcp-use.com/mcp. Gateway forwards ALL paths (ADR-004 risk resolved): /healthz 200, / HTML, /v1/balance 401, /w/offers/x 404 offer_invalid, /topup/done 200, POST /webhooks/inkbox unsigned 401, /mcp without key 401. Now backed by InsForge Postgres (see below); vendors still fake until keys land. |
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
10. Privacy and operator contact: an email address the team monitors, named on the worker privacy page (data deletion) and on owner-facing pages that today say "ask the Eyes operator" for an owner link (second journey audit, major 2).
