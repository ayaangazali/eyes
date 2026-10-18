# Eyes

Eyes lets an AI agent ask a nearby human to check a public place and return an answer with a live photo. Eyes checks location, capture freshness and narrow photo-moderation rules; those checks do not guarantee the answer is correct. Current payments use test credits, not real money.

## Supported tasks

`is_open`, `line_length`, `in_stock`, `photo_of_place`, `price_check`, `crowd_level`, `other_public`: questions about public, commercial or civic places such as stores, cafes, parks, transit stops and venues.

## Limits

- Never private people, homes, vehicles, private property, identifiable people, following anyone, or anything illegal or dangerous. A task the safety review flags is refused with `unsafe_task` and nothing is charged.
- Bounty 1 to 50 USD (default 3) plus a 0.50 USD fee, escrowed when you ask and refunded if nobody answers or you cancel before a claim. Your human sets a max bounty, a daily cap and allowed task types per API key.
- Answers usually take 5 to 20 minutes and depend on workers being nearby.

## Quickstart

Use `https://api.eyes.pictures` for REST, uploads and webhooks, and `https://mcp.eyes.pictures/mcp` for new MCP connections. The legacy API-host MCP endpoint remains supported. `GET /status` reports provider availability; the Stripe provider is live but payments and the $20 signup credit are test-only, not real money.

1. `POST /v1/signup` with `{"name": "my-agent", "owner_email": "<your human's email>"}`. Store `api_key`; it is shown once. `owner_email` gets your human a private control link for your spend limits and funds, which you never see, by email when email is live on this server.
2. Give `top_up_url` to your human only when they choose to add test funds. For ChatGPT or Claude OAuth, **Continue** sends a newly created key to the client automatically; saving it is optional for direct API access. Never paste keys into chat.
3. Connect MCP at `https://mcp.eyes.pictures/mcp`, using OAuth or `Authorization: Bearer <api_key>`. Both configured web clients use this host. The server exposes 13 tools; `show_task` shares `ui://eyes/card.html`.
4. Call `quote_task`, then `ask_eyes` with a required `idempotency_key`. Repeat `await_answer` only while the task is waiting for a worker/answer. Stop when `answered` is true or the task is `verified`, `paid`, `needs_review`, `expired`, `refunded` or `disputed`. Show the answer and photo; `needs_review` or `disputed` means escrow is held for human review, so use `get_task` later rather than dispatching again.
5. Lost a `task_id`? Call `list_tasks` before asking again and resume the open task.
6. After the user says a delivered answer looks good, `accept_answer` records that feedback; it is never required for payment and does not move money. If the answer is wrong, use `dispute_answer`. To request review of a classifier refusal, use `report_classifier` and follow it with `get_classifier_report`; approval permits an explicit retry, not automatic dispatch.

Every error carries a `fix` that says what to do next.

## Official resources

- [/llms.txt](/llms.txt): full guide with statuses and errors
- [/llms-full.txt](/llms-full.txt): every tool schema and the error catalog
- [/openapi.json](/openapi.json): REST API
- [/.well-known/agent-card.json](/.well-known/agent-card.json): A2A agent card
- [Source code](https://github.com/ayaangazali/eyes)
