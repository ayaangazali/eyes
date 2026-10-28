---
task: S08-agent-request-limits
files:
  - apps/mcp/src/server.ts
  - apps/mcp/src/main.ts
  - apps/mcp/src/agent-limits.int.test.ts
  - packages/core/src/service.ts
  - packages/engine/src/index.ts
  - packages/db/migrations/050_agent_request_limits.sql
  - intent/decisions/ADR-051-agent-request-limits.md
  - .env.example
---

# Agent request limits

## Why

OWASP API4:2023 and API6:2023: `POST /v1/tasks` had no throttle, and the existing limiters live in process memory, so a second server process doubled every limit.
One agent could post unlimited tasks, quote without bound, and a worker could upload without bound.

## What

- `eyes_rate_hit` counts calls per key in Postgres, so all server processes share one count.
- `POST /v1/tasks`, `POST /v1/quote` and the MCP tools `ask_eyes`, `confirm_ask` and `quote_task` are limited per agent id.
  REST and MCP share one count per bucket.
- `POST /w/offers/:token/capture` is limited per worker id.
- `eyes_post_task` refuses a new task when the agent has `max_open_tasks` dispatched or claimed tasks that have not expired.
- Over a limit: 429 `rate_limited` with a `fix`.
- Env: `EYES_AGENT_TASKS_PER_HOUR` (30), `EYES_AGENT_QUOTES_PER_HOUR` (120), `EYES_WORKER_UPLOADS_PER_HOUR` (20), `EYES_MAX_OPEN_TASKS` (20).

## Verification

`agent-limits.int.test.ts` runs two servers on one database: call 4 of a limit of 3 is 429 and calls 1 to 3 are not; quotes and task creates count apart; a second task past an open cap of 1 is 429.
