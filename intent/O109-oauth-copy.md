---
task: O109
files:
  - apps/mcp/src/oauth.ts
---

# Remove the unsupported OAuth promise

## Why

The OAuth sign-in page promises that users can change limits or revoke a key at any time.
The key creation flow does not provide those controls.
Remove that sentence, following the default in issue #180 for issue #109.
Keep both authorization forms and all OAuth behavior unchanged.

## Verification

Render the authorization page through the Hono app and check that the unsupported promise is absent.
The temporary regression check fails before the change and passes after it.
Capture the rendered page with Playwright Chromium at desktop and phone widths before and after the change.
Run lint, typecheck, the server unit tests, the contract tests, and the OAuth integration tests.
