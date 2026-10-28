---
task: S02
title: Owner JSON API
files:
  - packages/core/src/service.ts
  - packages/engine/src/index.ts
  - packages/engine/src/engine.int.test.ts
  - packages/payments/src/index.ts
  - packages/payments/src/index.test.ts
  - intent/decisions/ADR-044-owner-json-api.md
  - intent/INDEX.md
status: done
---

## Why

The Eyes app needs the owner console as JSON. The HTML console is the only owner surface today.

## What changed

Add four JSON routes under the owner link: state.json, tasks.json, policy.json and rotate-key.json.
Each calls the same service method as the HTML twin, so validation and limits do not drift.
Add `ownerTasks` to the service: one page of the token's own tasks with the ADR-041 cursor.
Answer an unknown token with 401 and send Cache-Control no-store.
HTML routes do not change.

## Verification

Route tests cover each route, 401 for a bad token, and 400 for bad input.
The engine integration test shows that one owner token cannot read another owner's tasks.
Run `pnpm verify:fast`; the integration test needs a disposable Postgres.
