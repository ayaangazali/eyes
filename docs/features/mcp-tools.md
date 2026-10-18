# MCP tools

Eyes gives an AI agent nine MCP tools at `https://api.eyes.pictures/mcp`: quote a task, ask a nearby human to check a public place, wait for the answer, and manage tasks and money. Every tool also exists as a plain REST call under `/v1/*`, using the same API key and the same JSON.

## How it works

- `quote_task` is free and read-only: it returns workers nearby, a suggested bounty, and whether the task is allowed.
- `ask_eyes` escrows the bounty (default 3 USD) plus a 0.50 USD fee; it needs an `idempotency_key` so retries are not charged twice.
- `await_answer` waits up to 55 seconds per call; call it in a loop until `answered` is true or the task ends.
- `get_task`, `list_tasks`, `get_balance` and `get_spend_policy` are read-only lookups.
- `cancel_task` refunds a task no worker has claimed yet; `dispute_answer` sends an answer to human review.
- REST mirror: `POST /v1/quote`, `POST /v1/tasks`, `GET /v1/tasks`, `GET /v1/tasks/:task_id`, `POST /v1/tasks/:task_id/await`, `POST /v1/tasks/:task_id/cancel`, `POST /v1/tasks/:task_id/dispute`, `GET /v1/balance`, `GET /v1/spend-policy`.

## How to try it

```sh
curl -X POST https://api.eyes.pictures/v1/quote \
  -H "Authorization: Bearer $EYES_API_KEY" \
  -H "content-type: application/json" \
  -d '{"location":"Ferry Building, San Francisco","task_type":"line_length"}'
```

## Where in the code

- [`apps/mcp/src/server.ts`](../../apps/mcp/src/server.ts): MCP tool definitions and `/v1/*` REST routes
- [`apps/mcp/src/server.test.ts`](../../apps/mcp/src/server.test.ts): tool and REST mirror tests
