---
task: S7 - Keep location codes out of short links (#126)
files:
  - apps/mcp/src/short-links.ts
  - apps/mcp/src/short-links.test.ts
  - packages/engine/src/engine.int.test.ts
  - scripts/adhoc-release.ts
---

## Why

Follow the default in issue #180: send links with `#c=` unchanged so their codes never enter `short_links`.
Apply this rule in the shared shortener for text, capture, and payment messages.
Continue to shorten other links, including payout and capture links.
Remove the release script's unused shortener, which only handled install links with a code.

Existing rows remain unchanged and can still contain codes.
Operations must decide how to clean up rows created before this fix; this change adds no migration.
Longer links increase worker message lengths and can increase SMS segments.

## Verification

The unit regression covers install, app, automation, setup, and login links through all three message methods.
The engine regression checks a START message through the live wrappers with a real local database.
Its code links must still work, its payout link must stay short, and its worker must have no stored `#c=` target.
Both regressions fail before the fix.
Run short-link and release unit tests, engine integration tests, contract tests, lint, typecheck, intent checks, and Sentrux.
