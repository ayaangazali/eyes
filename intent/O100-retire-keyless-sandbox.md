---
task: O100
title: Retire the keyless sandbox
files:
  - .env.example
  - apps/mcp/README.md
  - apps/web/widget-task-card/README.md
  - apps/mcp/src/main.ts
  - apps/mcp/src/main.test.ts
  - apps/mcp/src/server.ts
  - apps/mcp/src/server.test.ts
  - apps/mcp/src/sandbox.ts
  - apps/mcp/src/sandbox.test.ts
  - apps/mcp/src/sandbox.int.test.ts
  - docs/DEPLOY.md
  - intent/O100-retire-keyless-sandbox.md
  - intent/INDEX.md
status: done
---

## Why

Issue #100 reports that the keyless sandbox database lacks the migrations required by the server.
The unanswered product question in #180 defaults to retiring the sandbox rather than maintaining another deployment.

## What changed

Remove the sandbox service, automatic account funding, simulated workers, and sandbox-only tests.
Remove the environment switch and sandbox descriptions from the server and its configuration example.
Clarify that the unused card prototype's sandbox field belongs only to its fixtures.
Keep the normal service, public signup, provider selection, OAuth, and authenticated MCP and REST behavior.
Remove the sandbox entry from the MCP README; preserve archived records as written.
Document the retirement and the deployment operator's separate duty to stop any remaining sandbox server.
The root README and generated public docs have no keyless sandbox links and remain unchanged.
No deployed service, DNS record, database, migration, or core contract changes.

## Verification

The regression sends unauthenticated MCP and REST requests with the retired flag set.
Before removal, both return HTTP 200 instead of HTTP 401.
After removal, both must return the unauthorized response without funding an account.
Run the MCP unit and integration tests, CLI integration test, contract tests, lint, typecheck, intent check, and Sentrux gate.
Render the home and status pages through the Hono app with repository Playwright Chromium.
Compare both pages against the original normal server output, with and without the retired flag.
