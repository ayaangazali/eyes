# STATUS

Updated: 2026-10-17 01:35 PT by orchestrator. **G1 fakes half PASSED** (golden path e2e green in CI: MCP -> engine -> signed Inkbox webhook -> capture page -> verification -> fake payout -> answer). G1 live half needs keys (docs/DEPLOY.md). **ESCALATED: T1.5 safety (#7) needs a human A/B decision**; until it merges, quote_task and ask_eyes return not_implemented on a live server.

## Task board

| Task | Owner | State | PR | Verdicts | Blocker |
|---|---|---|---|---|---|
| T0.1 vendor notes | docs-researcher x7 | done | (initial commit) | n/a | none |
| T0.2 scaffold + CI | orchestrator | done | (initial commit) | n/a | none |
| T0.3 contracts + migration v1 + fakes | orchestrator | done | (initial commit) | n/a | none |
| T0.4 agents, hooks, intent system | orchestrator | done | (initial commit) | n/a | none |
| T1.1 MCP tools + REST + worker API | mcp-builder | **merged** #2 | [#2](https://github.com/ayaangazali/eyes/pull/2) | r3 security+ax PASS | live-verified: no |
| T1.2 engine + db | engine-builder | **merged** #6, #12 | [#6](https://github.com/ayaangazali/eyes/pull/6) | r2 security PASS, test+spec PASS; follow-up PASS | InsForge grants unverified live |
| T1.3 Inkbox comms | comms-builder | **merged** #1, #10 | [#1](https://github.com/ayaangazali/eyes/pull/1) | r2 all PASS; follow-up #10 PASS | live-verified: no |
| T1.4 worker web | worker-web-builder | **merged** #3; follow-up #13 merging | [#3](https://github.com/ayaangazali/eyes/pull/3) | r2 PASS; #13 coverage major downgraded by ruling | live-verified: no |
| T1.5 safety | safety-builder | **ESCALATED** | [#7](https://github.com/ayaangazali/eyes/pull/7) | r1 FAIL, r2 FAIL, r3 FAIL (negation too broad) | human decision A/B |
| G1 golden path e2e | integration builder | **merged** #16 | [#16](https://github.com/ayaangazali/eyes/pull/16) | integration PASS (3/3 fresh DBs, mutations killed) | unsafe_task test skipped until T1.5 |
| T2.1 Stripe | payments-builder | **merged** | [#5](https://github.com/ayaangazali/eyes/pull/5) | r1 security PASS, spec+intent PASS, test FAIL; r2 PASS | live-verified: no |
| T2.2 verification | verification-builder | **merged** #4, #8 | [#4](https://github.com/ayaangazali/eyes/pull/4) | all PASS | live-verified: no |
| T2.3 deploy | orchestrator | artifacts on main (Dockerfile proven locally, InsForge migrate script, docs/DEPLOY.md) | | | keys and logins |
| T2.4 MCP wiring + hardening | mcp-builder | fix round 1 | [#14](https://github.com/ayaangazali/eyes/pull/14) | spec+ax PASS, security+test FAIL (token in logs via userinfo/encoded targets; ordering untested) | none |
| T3.1 Primitive | comms-builder | verifying round 3 | [#11](https://github.com/ayaangazali/eyes/pull/11) | r1 security FAIL (open relay), r2 FAIL (HTML ReDoS; DMARC parent domain) | 3rd failure would escalate |
| T3.2 AX docs + CLI | ax-builder | verifying round 3 | [#9](https://github.com/ayaangazali/eyes/pull/9) | r1 FAIL, r2 FAIL (gateway 5xx double-escrow path) | 3rd failure would escalate |
| T3.3 dashboard | dashboard-builder | **merged** #15 | [#15](https://github.com/ayaangazali/eyes/pull/15) | combined PASS (no PII leak, XSS-safe, loopback only) | live-verified: no |
| T3.4 Armature + evals | orchestrator/ax-builder | blocked | | | G2, sponsor answer |

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
