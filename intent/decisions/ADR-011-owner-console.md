# ADR-011: Owner console with a link the agent never sees

Status: accepted (2026-10-17, orchestrator). Adds to the frozen contract: `OwnerPolicyInput`, `OwnerConsole`, error `owner_link_invalid`, routes `owner_console` and `owner_policy`, and `EyesService.ownerConsole` / `updateSpendPolicy`.

## Context
`get_spend_policy` tells agents "only your user can change these limits", but nothing let a user change them. The Stripe track asks for clear user control over what agents can do and spend (SPEC §1). The top-up link (`t:` token) cannot carry that control: agents receive it in `get_balance`, `signup` and `insufficient_balance` errors, so an agent holding it could raise its own limits.

## Decision
- New HMAC link token `p:<agent_id>` (ADR-009 shape, no expiry). It is never returned by any agent-facing tool, REST response, error or log line.
- Delivery: emailed to `owner_email` at signup when one is given (through the `Email` provider), and printed by an operator script for the demo.
- `GET /owner/:token` renders a server-side HTML page: balance, escrow, today's spend, the last 20 tasks and last 50 ledger rows, a limits form, and an add-funds button that uses the existing top-up flow. `POST /owner/:token/policy` (form post, 303 back) updates `max_bounty_cents`, `daily_cap_cents` and `allowed_task_types` on `agents`. Setting the daily cap to 0 freezes spending.
- No new tables or columns: the policy columns exist in `001_init.sql`. `005_owner.sql` adds two RPC functions (console read, policy update) because InsForge is reachable only over RPC.

## Alternatives rejected
- Reuse the `t:` token: the agent holds it.
- Owner accounts with login: too much surface for the event; one capability link per agent matches the agent email identity (ADR-007).

## Consequences
A leaked owner link grants control until the link secret rotates; there is no per-link revocation. Agent-supplied text (task questions) is rendered on a human page, so every field is HTML-escaped.
