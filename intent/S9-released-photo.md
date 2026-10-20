---
task: S9-released-photo
files:
  - packages/core/src/schemas.ts
  - packages/core/src/service.ts
  - packages/db/migrations/042_unavailable_photo_verdict.sql
  - packages/engine/src/index.ts
  - packages/engine/src/engine.int.test.ts
  - packages/verify/src/index.ts
  - packages/verify/src/index.test.ts
---

## Why

Issue #99 leaves a photo hidden after an ops release when the moderation provider failed.
Follow the stated default in issue #180: deliver that photo after the agent pays, but never deliver a confirmed block.
Store unavailable moderation as a null internal verdict instead of mixing it with confirmed blocks.
Keep the public verification boolean false and preserve old false verdicts without guessing from reason text.
ADR-025 records the release rule and migration order.

## Verification

The new release regression failed before the fix: the paid task returned a null photo URL.
Run verification unit tests, core contract tests, engine integration tests, and migration integration tests.
Check that an unavailable photo stays hidden before release and appears after release.
Check that blocked photos stay hidden after release, including a block whose reason matches the outage message.
Check that repeated release and payout retries produce one ledger release and one transfer.
Run lint, typecheck, the intent check, and the Sentrux gate.
