---
task: C2
title: Clear error codes for safety outages and HTTP failures
files:
  - packages/core/src/errors.ts
  - packages/core/src/service.ts
  - packages/core/src/core.contract.test.ts
  - packages/core/src/__snapshots__/core.contract.test.ts.snap
  - packages/safety/src/index.ts
  - packages/safety/src/index.test.ts
  - packages/engine/src/index.ts
  - packages/engine/src/engine.int.test.ts
  - apps/mcp/src/http.ts
  - apps/mcp/src/http.test.ts
  - apps/mcp/src/server.ts
  - apps/mcp/src/server.test.ts
  - docs/public/*
  - intent/decisions/ADR-038-clear-error-codes.md
  - intent/INDEX.md
status: done
---

## Why

Issues #118 and #119 report errors that tell agents to make the wrong change.
A safety-service outage needs a retry, not a rewritten question.
Unknown routes, unsupported methods, and oversized bodies need codes that match their HTTP statuses.
Issue #180 supplies the defaults for this contract change.

## What changed

Add four public error codes and an explicit unavailable flag for safety verdicts.
Keep unavailable safety checks fail-closed without charging or dispatching.
Keep the existing location-error precedence and category-confidence threshold.
Return supported methods in `Allow` for 405 responses.
Keep the body-size limits and distinguish ordinary requests from photo uploads.
Correct cancellation guidance for tasks that already ended.
Leave list_tasks paging for C3.

## Verification

The regressions first observed `invalid_input` for HTTP routing and size failures, and HTTP 422 for a safety outage.
Run the server, HTTP adapter, and safety unit tests, the core contract tests, and the engine integration tests.
The engine test uses the real service through REST and an MCP client and checks that no task or charge exists.
The adapter tests use real sockets for both REST and MCP body limits.
Run lint, typecheck, the intent check, and the Sentrux gate.
Run one ponytail review before opening the pull request.
