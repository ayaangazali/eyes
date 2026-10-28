---
task: S13
files:
  - packages/db/migrations/051_agent_suspend_link_version.sql
  - packages/core/src/errors.ts
  - packages/core/src/schemas.ts
  - packages/core/src/service.ts
  - packages/engine/src/index.ts
  - apps/mcp/src/server.ts
  - apps/edge/monitor/worker.js
  - scripts/owner-link.ts
  - docs/features/owner-controls.md
  - apps/edge/monitor/worker.test.ts
  - apps/mcp/src/server.test.ts
  - packages/core/src/__snapshots__/core.contract.test.ts.snap
  - packages/engine/src/engine.int.test.ts
---

## Why

Ops could not stop an abusive agent, and an owner link could not be revoked on its own (OWASP API2:2023). See [ADR-052](decisions/ADR-052-suspend-agent-revoke-owner-links.md).

## What

A suspended flag (403 on every agent call), a per-agent owner link version bumped by a revoke (old links give 401), and monitor alerts on spikes of 429s, failed logins, disputes and bans.

## Verification

- `vitest` unit and contract projects pass: suspended agent gets 403 on `/v1` and `/mcp`; a monitor tick over the limit sends one alert and the next tick sends none.
- The revoke-to-401 and suspend round trip is in `engine.int.test.ts`; no Postgres was available to run it here.
