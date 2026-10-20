---
task: C3
title: Stable paging for list_tasks
files:
  - packages/core/src/schemas.ts
  - packages/core/src/__snapshots__/core.contract.test.ts.snap
  - packages/engine/src/index.ts
  - packages/engine/src/engine.int.test.ts
  - packages/db/migrations/044_list_tasks_paging.sql
  - apps/mcp/src/server.ts
  - apps/mcp/src/server.test.ts
  - cli/src/main.ts
  - cli/src/docs.ts
  - cli/src/ask.int.test.ts
  - cli/src/main.test.ts
  - docs/public/**
  - intent/decisions/ADR-041-list-tasks-paging.md
  - intent/INDEX.md
status: done
---

## Why

Issue #119 reports that list_tasks cannot page beyond its newest 50 tasks.
The error-code changes already merged separately.
This change follows the paging default in issue #180.

## What changed

Add a before cursor and return next_cursor, or null for the last page.
Order by created_at and id so timestamp ties cannot lose tasks.
Resolve the cursor inside Postgres to retain timestamp precision and enforce agent ownership.
Expose the same behavior through MCP, REST, and eyes tasks --before.
Update the shared contract and generated public documentation.
Send the CLI JSON content type only with a request body.

## Verification

The regression first failed on the unstable ordering of 55 tasks with equal timestamps.
It now checks the first page, final page, empty continuation, agent isolation, and status filtering.
It also exercises the real engine through REST, an MCP client, and the CLI.
Run the engine integration tests, server and CLI unit tests, core contract tests, lint, typecheck, and intent checks.
Run the Sentrux comparison and one ponytail review before publication.
