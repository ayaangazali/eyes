---
task: S13-agent-key-revocation
title: Verify per-agent API-key revocation and record deferred link revocation
files: [packages/engine/src/engine.int.test.ts, intent/decisions/ADR-019-owner-key-rotation.md]
---

## Why

Issue #28 requests per-agent revocation for API keys, capability email addresses, and owner links.
API-key replacement already exists under ADR-019.
Issue #180 has no owner replies and sets the default to defer capability email and owner-link revocation.
This change records that decision rather than adding the deferred token-generation contract.

## Verification

The integration regression uses the real server, engine, and disposable Postgres database.
It connects an MCP client before rotation and checks that its next tool call rejects the old key.
It also checks REST rejection, replacement-key access, another agent's access, and continued owner-link access.
Existing tests cover invalid owner tokens, key secrecy, and concurrent replacements.
No production behavior or UI changes.
