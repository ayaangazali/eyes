---
task: C7
title: Browser clients and OAuth resource binding
files:
  - apps/mcp/src/server.ts
  - apps/mcp/src/server.test.ts
  - apps/mcp/src/oauth.ts
  - apps/mcp/src/oauth.int.test.ts
  - docs/CONNECT.md
  - docs/features/chatgpt-claude-apps.md
  - intent/INDEX.md
status: done
---

## Why

Issues #120 and #121 describe blocked browser clients and OAuth conformance gaps.
This change follows the defaults in #180.
Any web origin can call the public API without credentials mode.
OAuth tokens must not work on another resource.

## What changed

Run public CORS before authentication and expose the authentication challenge and MCP session header.
Keep ops and worker routes outside that policy.
Seal the authorized resource into the code and access token with the existing authenticated encryption helper.
Reject a different token-exchange resource before consuming the code.
Authenticate the underlying key only when the token matches the requested MCP resource.
Keep direct API keys unchanged; existing connections need OAuth sign-in again to receive bound tokens.
No database migration is needed.
Add invalid_token challenges, permit the OAuth page font, and disable analytics injection with no-transform.
Keep third-party scripts blocked on pages that handle keys.
Disclose that photo requests targeting identifiable people are refused before dispatch.
Accept issue #121 items 1-4 as low risk until mcp-use fixes them, as directed in #180.

## Verification

Before the fix, 14 regression cases failed: preflight returned 401 or 405, CORS headers were absent, and resource binding was absent.
After the fix, the focused browser and resource cases pass.
Run the MCP server unit tests, OAuth HTTP/Postgres integration tests, contract tests, lint, typecheck, and intent check.
Use a real Chromium browser to check cross-origin API calls and the OAuth page font, then record screenshots outside the repository.
Run the Sentrux gate and one ponytail review before delivery.
