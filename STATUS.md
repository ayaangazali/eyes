# STATUS

Updated: 2026-10-16 23:15 PT by orchestrator. Gate: **G0 passed**. Phase 1 + early Phase 2/3 running (T2.1, T2.2, T3.2 started early: their inputs are frozen contracts; ledger moved to engine per ADR-003).

## Task board

| Task | Owner | State | PR | Verdicts | Blocker |
|---|---|---|---|---|---|
| T0.1 vendor notes | docs-researcher x7 | done | (initial commit) | n/a | none |
| T0.2 scaffold + CI | orchestrator | done | (initial commit) | n/a | none |
| T0.3 contracts + migration v1 + fakes | orchestrator | done | (initial commit) | n/a | none |
| T0.4 agents, hooks, intent system | orchestrator | done | (initial commit) | n/a | none |
| T1.1 MCP tools + REST + worker API | mcp-builder | verifying | [#2](https://github.com/ayaangazali/eyes/pull/2) | spec PASS, test PASS, intent PASS, ax FAIL (2 major), security pending | fix round after security |
| T1.2 engine + db | engine-builder | building | | | none |
| T1.3 Inkbox comms | comms-builder | fix round 1 | [#1](https://github.com/ayaangazali/eyes/pull/1) | intent PASS, spec FAIL, security FAIL, test FAIL | no free text in cold offer (ADR-005) |
| T1.4 worker web | worker-web-builder | verifying | [#3](https://github.com/ayaangazali/eyes/pull/3) | intent PASS, spec/test pending | none |
| T1.5 safety | safety-builder | building | | | none |
| T2.1 Stripe | payments-builder | building | | | none |
| T2.2 verification | verification-builder | verifying | [#4](https://github.com/ayaangazali/eyes/pull/4) | intent PASS, spec/test pending | none |
| T2.3 deploy | orchestrator | blocked | | | keys, T1.1, T1.2 |
| T2.4 money tools | mcp-builder | blocked | | | T2.1 |
| T3.1 Primitive | comms-builder | blocked | | | G2 |
| T3.2 AX docs + CLI | ax-builder | building | | | none |
| T3.3 dashboard | dashboard-builder | blocked | | | G2 |
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
