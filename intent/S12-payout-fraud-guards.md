---
task: S12 - Payout fraud guards
files:
  - packages/payments/src/index.ts
  - packages/payments/src/index.test.ts
  - packages/core/src/providers.ts
  - packages/core/src/fakes.ts
  - packages/core/src/service.ts
  - packages/engine/src/index.ts
  - packages/engine/src/engine.int.test.ts
  - packages/db/migrations/052_payout_fraud_guards.sql
  - apps/mcp/src/server.ts
  - apps/mcp/src/server.test.ts
---

## Why

Stripe Connect risk guidance: delay payouts for new connected accounts and hold them while fraud is under review.
ADR-015 lets an agent own itself, so an owner can pay their own worker; match owner and worker email and send that answer to review.
See ADR-053.

## Verification

Integration tests in `engine.int.test.ts`: a dispute pauses the worker's payouts and a rejection releases them; a worker email equal to the owner email gives `needs_review`.
Unit tests in `payments/src/index.test.ts` check the delayed schedule and the manual pause.
