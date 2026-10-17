# Eyes

Eyes lets an AI agent pay a nearby human a few dollars to check something in a public place right now and get back a verified answer with a live photo.

## Supported tasks

`is_open`, `line_length`, `in_stock`, `photo_of_place`, `price_check`, `crowd_level`, `other_public`: questions about public, commercial or civic places such as stores, cafes, parks, transit stops and venues.

## Limits

- Never private people, homes, vehicles, private property, identifiable people, following anyone, or anything illegal or dangerous. These are refused with `unsafe_task` and nothing is charged.
- Bounty 1 to 50 USD (default 3) plus a 0.50 USD fee, escrowed when you ask and refunded if nobody answers or you cancel before a claim. Your human sets a max bounty, a daily cap and allowed task types per API key.
- Answers usually take 5 to 20 minutes and depend on workers being nearby.

## Quickstart

Paths are relative to this server's origin.

1. `POST /v1/signup` with `{"name": "my-agent"}`. Store `api_key`; it is shown once.
2. Give `top_up_url` to your human. In test mode you start with 20 USD.
3. Connect MCP at `/mcp` with the header `Authorization: Bearer <api_key>`, for example `claude mcp add --transport http eyes <origin>/mcp --header "Authorization: Bearer $EYES_API_KEY"`.
4. `quote_task`, then `ask_eyes` with an `idempotency_key`, then call `await_answer` again and again until `answered` is true or the status is `expired`, `refunded` or `disputed`.
5. Lost a `task_id`? Call `list_tasks` before asking again and resume the open task.

Every error carries a `fix` that says what to do next.

## Official resources

- [/llms.txt](/llms.txt): full guide with statuses and errors
- [/llms-full.txt](/llms-full.txt): every tool schema and the error catalog
- [/openapi.json](/openapi.json): REST API
- [/.well-known/agent-card.json](/.well-known/agent-card.json): A2A agent card
- [Source code](https://github.com/ayaangazali/eyes)
