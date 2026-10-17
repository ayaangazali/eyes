# ADR-013: `list_tasks`, and a `quote_task` that says what it does not check

Status: accepted (2026-10-17, orchestrator). Adds to the frozen contract: `ListTasksInput`, `ListTasksOutput`, tool `list_tasks`, route `list_tasks: "GET /v1/tasks"` and `EyesService.listTasks`. Changes description text only on `QuoteTaskOutput.allowed` and `reason_if_not`.

## Context
- An agent that loses a `task_id` (context reset, crash, restart) cannot find its open tasks. The only recovery was to replay `ask_eyes` with the same `idempotency_key`, which it has usually lost too, so it asks again and pays twice.
- The AX eval found `quote_task` returning `allowed: true` for a question that `ask_eyes` then refuses. Quote never sees the question: it runs the safety check on the task type and place only, and it ignores the agent's spend policy. The tool description said `allowed` is false "if this API key may not post that task_type", which the engine never checked.

## Decision
- `list_tasks({ status?, limit = 20 })` returns the calling agent's tasks newest first, at most 50: `task_id, status, question, place_label, bounty_usd, created_at, deadline_at, answered`, plus `next_step`. `answered` uses the same statuses as `await_answer` (verified, paid, needs_review).
- REST mirror `GET /v1/tasks?status=&limit=`; CLI `eyes tasks [--status] [--limit]`.
- `008_list_tasks.sql` adds one RPC function, `eyes_list_tasks(agent_id, status, limit)`, filtered on `agent_id` and with EXECUTE revoked from public, anon and authenticated like 002 to 006. No tables, columns or indexes.
- `quote_task` behaviour is unchanged. Its tool description and the `allowed` / `reason_if_not` field docs now say that `allowed` covers only the place and task type, that `ask_eyes` checks the question itself, and that spend policy and balance are read with `get_spend_policy` and `get_balance`.

## Alternatives rejected
- Make `quote_task` check the spend policy: a behaviour change outside this decision. The description now tells the truth about the current behaviour instead.
- Return `idempotency_key` or the answer in each row: `get_task` already returns the answer, and the contract stays the shape the orchestrator approved.
- Cursor pagination: 50 newest tasks covers recovery after a reset; add a cursor when an agent needs older tasks.

## Consequences
Tool schema snapshot regenerated; nine tools. `llms.txt`, `llms-full.txt`, `openapi.json` and the agent card list `list_tasks`. `scripts/smoke-live.ts` compares `tools/list` with `TOOLS`, so it expects `list_tasks` once this is deployed.
