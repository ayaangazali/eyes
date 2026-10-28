---
task: S03
title: Open-ended spend limits
files:
  - packages/db/migrations/048_open_ended_spend_limits.sql
  - packages/core/src/schemas.ts
  - packages/engine/src/index.ts
  - packages/engine/src/engine.int.test.ts
  - packages/payments/src/index.ts
  - packages/ui/src/page.ts
  - packages/payments/src/index.test.ts
  - apps/mcp/src/server.test.ts
  - packages/core/src/__snapshots__/core.contract.test.ts.snap
  - intent/decisions/ADR-049-open-ended-spend-limits.md
  - intent/INDEX.md
status: done
---

## Why

Owners need caps that can be off, last a week or month, and say what happens at the limit.

## What changed

Null cap and max bounty mean no limit. Add `cap_period` and `at_limit` to the policy. The spend check uses the period window.
The owner form and `policy.json` take the new fields. A cap below one request is refused.

## Verification

Integration tests cover null caps, the week window, pause wording, old policies and the one-request rule.
Route tests cover empty form fields and the JSON fields. Run `pnpm verify:fast`.
