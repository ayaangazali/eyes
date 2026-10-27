---
task: S3
title: Redeem OAuth codes once and guard ticket task binding
files:
  - apps/mcp/src/oauth.ts
  - apps/mcp/src/server.ts
  - apps/mcp/src/server.test.ts
  - apps/mcp/src/oauth.int.test.ts
  - apps/mcp/src/ops-review.int.test.ts
  - packages/db/migrations/039_oauth_code_redemptions.sql
  - docs/CONNECT.md
  - docs/features/chatgpt-claude-apps.md
---

## Why

Issue #108 permits repeated exchanges of an OAuth authorization code during its five-minute lifetime.
The exchange must have one winner, including concurrent requests on different server processes.
Issue #123 already checks the ticket and task together before release or refund.
A database-backed mismatch test must preserve that protection.

## What

Record a SHA-256 hash of each redeemed code with one conflict-safe insert.
Reject repeated redemption with `invalid_grant` and fail closed when storage fails.
Enable row-level security and restrict the new RPC to the existing server role.
Keep client, redirect and PKCE checks before redemption.
Add release and refund mismatch coverage without changing the existing ticket handler.
See [ADR-043](decisions/ADR-043-single-use-oauth-codes.md).

## Verification

Before the fix, sequential replay returned HTTP 200 and both concurrent exchanges returned HTTP 200.
After the fix, eight PostgreSQL integration checks and 140 server unit tests passed.
The checks cover replay, alternate base64 encoding, concurrent exchanges, failed validation, storage failure and database role restrictions.
Ticket mismatch checks preserve both tasks, the open ticket and the ledger for release and refund.
A standalone Node smoke used two HTTP servers and an isolated PostgreSQL database.
Concurrent exchanges returned HTTP 200 and 400; later replay returned HTTP 400 `invalid_grant`.
Sentrux passed at 6510 against the 6518 baseline.
Lint, typecheck and intent checks passed.
Unit, contract and safety suites passed 1943 tests across 66 files.
The full PostgreSQL integration suite passed 213 tests across 20 files.
Changed-source coverage passed 285 tests with two workers, 60-second tests and 120-second hooks for the loaded host.
Both changed source files exceed the 95% per-file coverage gate.
