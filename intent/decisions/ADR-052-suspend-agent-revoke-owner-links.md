# ADR-052: Suspend an agent, revoke owner links, alert on abuse spikes

Status: accepted. Builds on ADR-019 (owner key rotation) and ADR-011 (owner console).

## Decision

- `agents.suspended` (default false) is set by ops with `POST /ops/agents/:id/suspend {suspended}`. The `/mcp` and `/v1/*` auth step answers 403 `agent_suspended` for a suspended agent, after the key check.
- `agents.owner_link_version` (default 0) is bumped by `POST /ops/agents/:id/revoke-owner-links`. An owner token is `p:<agent_id>` for version 0 and `p:<agent_id>:<version>` after. Every owner call compares the token version with the stored one; a mismatch is `owner_link_invalid` (401 on the owner routes).
- The monitor Worker counts rows in `events` over 10 minutes for four signals: 429s, failed ops logins, answer disputes and worker bans. A signal at its limit sends one iMessage through the existing `send()` and stays quiet until it falls under the limit.

## Rejected

- Setting the owner cap to 0 to stop an agent: it blocks spending, not reads, and the owner can undo it.
- A link expiry: owners would lose a working link on a timer. A version bump revokes on demand.
- A new alert channel: the monitor already reaches the operator outside the server.

## Consequences

Migration 051 adds two columns and two functions. Old v0 links keep working until the first revoke. Each owner call reads the agent row once more. Limits are constants in `apps/edge/monitor/worker.js`.
