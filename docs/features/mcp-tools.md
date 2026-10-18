# MCP tools

Eyes gives an AI agent 13 model-visible MCP tools at `https://mcp.eyes.pictures/mcp`, plus the app-only `confirm_ask` action. REST counterparts use the same API key under `https://api.eyes.pictures/v1/*`; `show_task` renders the same task data as `get_task`. There is no `confirm_ask` REST endpoint.

The dedicated MCP connector is active with OAuth configured for ChatGPT and Claude. Existing `https://api.eyes.pictures/mcp` connectors still work. REST, uploads and webhooks remain on `https://api.eyes.pictures`.

## How it works

- `quote_task` is free and read-only: it returns workers nearby, a suggested bounty, and whether the task is allowed.
- In ChatGPT, Claude connectors and clients advertising MCP Apps, `ask_eyes` returns a read-only `confirmation_required` draft: no task, escrow or worker messages. Only an explicit card confirmation calls app-only `confirm_ask`, which escrows the bounty plus a 0.50 USD fee. REST, CLI and non-UI MCP `ask_eyes` still dispatch directly.
- `await_answer` waits up to 55 seconds per call; call it in a loop until `answered` is true or the task ends.
- `get_task`, `show_task`, `list_tasks`, `get_balance` and `get_spend_policy` are read-only lookups. `show_task` uses the current vanilla `ui://eyes/confirmation-card.html` widget, not a separate React view.
- `cancel_task` refunds a task no worker has claimed yet; `dispute_answer` sends an answer to human review. The card's **Ask again** gets a fresh quote and requires confirmation before posting a new paid request.
- `accept_answer` persists **Looks good** feedback on a verified or paid answer. It does not charge, pay again or prevent a later dispute.
- `report_classifier` opens a review ticket for an incorrect refusal; `get_classifier_report` reads its status. Neither posts a task or charges money. An approved request still requires an explicit retry.
- REST counterparts: `POST /v1/quote`, `POST /v1/tasks`, `GET /v1/tasks`, `GET /v1/tasks/:task_id`, `POST /v1/tasks/:task_id/await`, `POST /v1/tasks/:task_id/cancel`, `POST /v1/tasks/:task_id/accept`, `POST /v1/tasks/:task_id/dispute`, `GET /v1/balance`, `GET /v1/spend-policy`, `POST /v1/classifier-reports`, `GET /v1/classifier-reports/:ticket_id`.

The card preserves one `idempotency_key` and its submitted parameters through retries and late model updates. Concurrent confirmations create one task, escrow and set of offers. An intentional **Ask again** uses a new key after a fresh confirmation; identical questions are not globally deduplicated.

MCP Apps `visibility: ["app"]` and OpenAI private visibility keep `confirm_ask` out of a conforming host's model tools. This is not cryptographic proof of a human click and does not constrain custom clients that ignore visibility.

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
