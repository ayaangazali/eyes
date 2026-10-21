---
task: S12-worker-text-replies
files:
  - packages/comms/src/inkbox.ts
  - packages/comms/src/inkbox.test.ts
  - packages/core/src/providers.ts
  - packages/db/migrations/043_worker_text_replies.sql
  - packages/db/src/dispatch.int.test.ts
  - packages/engine/src/index.ts
  - packages/engine/src/engine.int.test.ts
  - packages/engine/src/engine.adversarial.int.test.ts
  - docs/features/imessage-dispatch.md
  - cli/src/ask.int.test.ts
  - apps/mcp/src/confirmation.int.test.ts
  - packages/engine/src/location.int.test.ts
---

## Why

Fix #97, #135, and #136 using the defaults recorded in #180.
Require exact words or explicit aliases for consent and task decisions, including YES, so ordinary words cannot claim tasks.
Keep edit-distance matching for commands that do not change consent or task ownership.
Treat `yes please` as YES.
Keep `cancel` as STOP under the standard opt-out keyword rule, overriding that one default in #180.
Release a held task and opt out in one transaction for STOP.
Send the standard command menu after an opted-out worker asks for HELP, without creating location codes.
Send a capture link for photos received by text instead of treating attachments as location shares or submissions.
Allow one open task offer per worker, including concurrent dispatches and repeat offers.
ADR-039 records the internal reply and database changes.

## Verification

Before the fix, 33 parser and media cases failed and all five new signed-webhook integration cases failed.
Check exact consent words, ordinary words, supported typos, `yes please`, MMS, iMessage attachments, and carrier commands with attachments.
Check STOP and cancel with a held task, the next worker's claim, HELP without restored consent, and photo submission guidance.
Check concurrent dispatches, stale worker lists, expired offers, repeat offers, and existing dispute restrictions on local Postgres.
Run affected unit, contract, and integration suites, lint, typecheck, intent checks, and Sentrux.
