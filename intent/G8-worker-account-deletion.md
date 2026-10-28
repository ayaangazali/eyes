---
task: G8
title: Workers delete their own account
files:
  - packages/core/src/schemas.ts
  - packages/core/src/service.ts
  - packages/engine/src/index.ts
  - packages/db/migrations/046_worker_delete.sql
  - apps/mcp/src/server.ts
  - apps/mcp/src/worker-setup.int.test.ts
  - apps/web/landing/src/pages/privacy.astro
  - intent/decisions/ADR-045-worker-account-deletion.md
  - intent/INDEX.md
status: done
---

## Why

Issue #276: workers could not delete their account. STOP keeps the name, the number and the past tasks.
`DELETE /w/me` pays what is due, then deletes the personal data, as ADR-045 tells.
The money ledger keeps every amount, so the totals do not change.

## Verification

The integration test runs on a disposable Postgres.
It sees a refusal while a task is claimed, and a deletion after the paid answer.
After the deletion, the setup code, the location code and the emailed login code fail.
The ledger rows of the task keep their amounts, without the worker reference.
