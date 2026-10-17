# STATUS

Updated: 2026-10-17 01:05 PT by orchestrator. G1 fakes half PASSED. Human decisions: #7 A, #9 A, #11 B (merging), #14 B (merging); ADR-010 adopted. Live G1 starting: first key INKBOX_API_KEY.

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
| T1.4 worker web | worker-web-builder | **merged** #3; follow-up #13 merging | [#3](https://github.com/ayaangazali/eyes/pull/3) | r2 PASS; #13 coverage major downgraded by ruling | live-verified: no |
| T1.5 safety | safety-builder | round 4 (human decision A) | [#7](https://github.com/ayaangazali/eyes/pull/7) | escalated after r3 | blocks live ask_eyes |
| G1 golden path e2e | integration builder | **merged** #16 | [#16](https://github.com/ayaangazali/eyes/pull/16) | integration PASS (3/3 fresh DBs, mutations killed) | unsafe_task test skipped until T1.5 |
| T2.1 Stripe | payments-builder | **merged** | [#5](https://github.com/ayaangazali/eyes/pull/5) | r1 security PASS, spec+intent PASS, test FAIL; r2 PASS | live-verified: no |
| T2.2 verification | verification-builder | **merged** #4, #8 | [#4](https://github.com/ayaangazali/eyes/pull/4) | all PASS | live-verified: no |
| T2.3 deploy | orchestrator | artifacts on main (Dockerfile proven locally, InsForge migrate script, docs/DEPLOY.md) | | | keys and logins |
| T2.4 MCP wiring + hardening | mcp-builder | **merging** #14 (human decision B) | [#14](https://github.com/ayaangazali/eyes/pull/14) | escalated after r3; deferred #21-#23 | live-verified: no |
| T3.1 Primitive | comms-builder | **merging** #11 (human decision B) | [#11](https://github.com/ayaangazali/eyes/pull/11) | escalated after r3; deferred #17-#20 | live-verified: no |
| T3.2 AX docs + CLI | ax-builder | round 4 (human decision A) | [#9](https://github.com/ayaangazali/eyes/pull/9) | escalated after r3 | none |
| T3.3 dashboard | dashboard-builder | **merged** #15 | [#15](https://github.com/ayaangazali/eyes/pull/15) | combined PASS (no PII leak, XSS-safe, loopback only) | live-verified: no |
| T3.4 Armature + evals | orchestrator/ax-builder | blocked | | | G2, sponsor answer |

## Sponsor coverage (update at every gate)

Live verification order once keys land: Inkbox (G1; set up in person at the event) -> Manufact deploy -> InsForge -> Stripe -> Primitive -> Armature. Supabase: not used unless the humans confirm its track brief.

| Sponsor | What we use | PR(s) | live-verified | What the demo shows |
|---|---|---|---|---|
| Manufact (mcp-use) | MCP server on mcp-use 2.10: 8 tools with LLM-first descriptions, bearer auth, REST mirror, worker API, byte-safe Node adapter; deployed on Manufact Cloud via the repo Dockerfile | #2, #14, T2.3 | no | Claude calls quote_task -> ask_eyes -> await_answer against the Manufact URL; Manufact dashboard shows sessions and gateway requests |
| InsForge | Postgres (escrow ledger, race-safe claim, expiry as plpgsql over RPC; RLS on every table), photo storage (`photos` bucket), Sites hosting for the worker capture page | #6, #12, #14, #15, T2.3 | no | capture page served from *.insforge.site; photo URL from InsForge storage; dashboard reads `eyes_dashboard_feed` |
| Stripe | Checkout top-ups (card only), per-key spend policy, Connect Express onboarding minted on click, $3 transfer on a verified answer, signed webhooks, refund on expiry/cancel | #5, #6 | no | top-up in Checkout, the worker's connected account, the transfer in the Stripe dashboard; get_spend_policy limits; refund path |
| Inkbox | iMessage line (chosen for cost): offer, capture link and paid texts; signed `imessage.received` webhook for START/YES | #1, #10, #24 | no | worker iPhone gets the offer, replies YES, gets the capture link and the paid text |
| Primitive | Capability email address per agent (ADR-007); inbound email -> ask_eyes; threaded answer with the photo attached; DMARC-verified senders only | #11 | no | an agent emails its Eyes address and gets a threaded reply with the photo |
| Armature | Agent experience: llms.txt, llms-full.txt, openapi.json, agent card, robots.txt, agents.md, `eyes` CLI, every error with a fix; analytics/evals in T3.4 (their SDK does not list mcp-use; sponsor answer needed) | #9 (in review), #14 | no | an agent onboards from llms.txt alone; Armature analytics/eval once wired |
| Blaxel | T3.5 (low priority, after G2): eval agents in Blaxel sandboxes; "swarm" demo mode with ~50 simulated agents via batch jobs; never on the golden path | none yet | no | dashboard map lights up with simulated agents |
| Anthropic (models, not a track) | Claude vision verification, Haiku safety classifier | #4, #8, #7 | no | verification checks on the answer; polite refusal |

## Deferred (ADR-010; triage at feature freeze, 6:00 AM Sun)

| Item | From | Tracking |
|---|---|---|
| Quadratic field regexes on email bodies (authenticated input) | PR #11 r3 | [#17](https://github.com/ayaangazali/eyes/issues/17) |
| trustedSender fail-closed catch untested | PR #11 r3 | [#18](https://github.com/ayaangazali/eyes/issues/18) |
| Endless-stream cap test hangs on regression | PR #11 r3 | [#19](https://github.com/ayaangazali/eyes/issues/19) |
| No per-agent inbound email reply budget | PR #11 r3 | [#20](https://github.com/ayaangazali/eyes/issues/20) |
| Request log decodes paths (log-line forging); switch to allowlist logging | PR #14 r3 | [#21](https://github.com/ayaangazali/eyes/issues/21) |
| Mangled token halves can appear in logs | PR #14 r3 | [#22](https://github.com/ayaangazali/eyes/issues/22) |
| Strict PORT parsing | PR #14 r3 | [#23](https://github.com/ayaangazali/eyes/issues/23) |
| iMessage from an Apple ID email is ignored (workers must send from the phone number) | PR #24 | [#25](https://github.com/ayaangazali/eyes/issues/25) |

Earlier verifier minors (non-blocking by severity) are in each task's intent Known gaps.

## Live verification

| Integration | live-verified | Evidence |
|---|---|---|
| Manufact deploy (mcp-use) | no | |
| InsForge DB + storage + Sites | no | |
| Inkbox outbound + inbound | no | |
| Stripe Checkout + Connect + transfer | no | |
| Primitive inbound + threaded reply | no | |
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
9. Hackathon rules: the event page publishes no rule on pre-start code. Ask the organizers (host Ray Liao) before 10:30 AM.
