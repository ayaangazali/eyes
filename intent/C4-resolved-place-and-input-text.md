---
task: C4
title: Return the resolved task location and reject invalid text
files:
  - packages/core/src/schemas.ts
  - packages/core/src/core.contract.test.ts
  - packages/core/src/__snapshots__/core.contract.test.ts.snap
  - packages/engine/src/index.ts
  - packages/engine/src/engine.int.test.ts
  - apps/mcp/src/server.ts
  - packages/comms/src/primitive.test.ts
  - cli/src/docs.ts
  - cli/src/main.test.ts
  - docs/public/*
  - intent/decisions/ADR-040-resolved-place-and-input-text.md
  - intent/INDEX.md
status: done
---

## Why

Issue #107 hides the place where a paid task resolved.
Issue #104 permits text that downstream services cannot accept, then suggests an ineffective retry.
Follow the defaults in #180: expose the resolved place, refuse out-of-range coordinates, and reject invalid text.

## What changed

Return the stored task's `resolved_location` on dispatch and replay.
Validate free-text request fields once in shared Zod schemas, including question, location, and idempotency keys.
Accept valid Unicode without changing it.
Reject coordinate strings before geocoding and validate resolved coordinate bounds.
Refresh the contract snapshot, OpenAPI document, and public agent reference.

## Verification

The initial REST regression accepted a NUL-containing question and returned 409 instead of 400.
Exercise dispatch and replay through REST and the MCP client against a disposable Postgres database.
Assert that bad characters and coordinates create no tasks and hold no funds.
Check that the CLI refuses invalid locations before sending requests.
Run the changed unit, contract, and integration test files, lint, typecheck, intent checks, and the Sentrux gate.
Run one ponytail review before opening the pull request.
