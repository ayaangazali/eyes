# ADR-013: `list_tasks`, and a `quote_task` whose suggestion `ask_eyes` accepts

Status: accepted (2026-10-17, orchestrator). Adds to the frozen contract: `ListTasksInput`, `ListTasksOutput`, tool `list_tasks`, route `list_tasks: "GET /v1/tasks"` and `EyesService.listTasks`. Adds description text to `QuoteTaskOutput.suggested_bounty_usd`, `allowed` and `reason_if_not`; no type, default or bound changes.

## Context
- An agent that loses a `task_id` (context reset, crash, restart) cannot find its open tasks. The only recovery was to replay `ask_eyes` with the same `idempotency_key`, which it has usually lost too, so it asks again and pays twice.
- The AX eval found `quote_task` returning `allowed: true` for tasks `ask_eyes` then refused. Quote never read the agent: it ran the safety check on the task type and place, always suggested the default bounty, and ignored allowed task types, max bounty, the daily cap and the balance. Its description claimed it checked the task type against the key.

## Decision
- `list_tasks({ status?, limit = 20 })` returns the calling agent's tasks newest first, at most 50: `task_id, status, question, place_label, bounty_usd, created_at, deadline_at, answered`, plus `next_step`. `answered` uses the same statuses as `await_answer` (verified, paid, needs_review). REST `GET /v1/tasks?status=&limit=`; CLI `eyes tasks [--status] [--limit]`.
- `008_list_tasks.sql` adds one RPC function, `eyes_list_tasks(agent_id, status, limit)`, filtered on `agent_id`, with EXECUTE revoked from public, anon and authenticated like 002 to 006. No tables, columns or indexes.
- `quote_task` reads the agent summary. In integer cents, `suggested_bounty_usd` is the default bounty capped by `max_bounty`, by the daily cap left minus the fee, and by the balance minus the fee, and never below the 1 USD `ask_eyes` minimum. Following the suggestion succeeds whenever `allowed` is true.
- `allowed` is false only for hard blocks: the safety rules refuse the task type at the place, the task type is not in `allowed_task_types`, `max_bounty` is below the minimum bounty, or the minimum bounty plus fee does not fit the daily cap left or the balance. `reason_if_not` says which, the amounts, and what to do (top up at `top_up_url`, wait for the midnight UTC reset, ask the user to raise the limit). It stays null when `allowed` is true. Quote still never sees the question; `ask_eyes` checks it.

## Alternatives rejected
- `allowed: false` whenever the default bounty exceeds a limit: a client that trusts `allowed` gives up when a lower bounty works. The AX eval's budget task (max bounty 2 USD, expects an answer) fails that way.
- A note in `reason_if_not` when the suggestion is capped: `reason_if_not` means "not allowed". The descriptions say the suggestion already respects the limits.
- Return `idempotency_key` or the answer in each `list_tasks` row: `get_task` returns the answer. Cursor pagination: 50 newest tasks cover recovery after a reset.

## Consequences
Tool schema snapshot regenerated; nine tools. `quote_task` makes one more RPC (`eyes_agent_summary`). `llms.txt`, `llms-full.txt`, `openapi.json` and the agent card list `list_tasks` and the new quote wording. `scripts/smoke-live.ts` compares `tools/list` with `TOOLS`, so it expects `list_tasks` once this is deployed.
