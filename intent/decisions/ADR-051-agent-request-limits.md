# ADR-051: Agent request limits counted in Postgres

Status: accepted

## Decision

Add table `agent_rate_hits` and RPC `eyes_rate_hit(key, max, window_s, now)`.
It takes a per-key advisory lock, drops expired rows, and either records the call (returns 0) or returns the seconds to wait.
The server calls it for agent task creates and quotes (key `<bucket> <agent id>`) and worker photo uploads (key `/w/capture <worker id>`).
Without a database RPC the server falls back to its in-memory throttle.

`eyes_post_task` gains `p_max_open integer default null`, so the old function is dropped and recreated.
It counts the agent's unexpired `dispatched` and `claimed` tasks under the existing agent row lock and raises `eyes:rate_limited` at the cap.
The engine passes `config.max_open_tasks`.
`eyes_post_reviewed_task` calls the 14-argument form and so skips the cap: an operator already approved that request.

## Consequences

One extra Postgres round trip per limited call; rows older than one day are deleted on each call.
Limits hold across server processes. Defaults are set by env and may be tuned from the `events` table.
