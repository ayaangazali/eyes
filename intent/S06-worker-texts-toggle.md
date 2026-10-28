---
task: S06
title: Texts on/off for the app (POST /w/me/texts)
files: [packages/core/src/schemas.ts, packages/core/src/service.ts, packages/engine/src/index.ts, packages/engine/src/engine.int.test.ts, apps/mcp/src/server.ts, apps/mcp/src/server.test.ts, apps/web/worker/src/me.test.ts]
spec_refs: [intent/decisions/ADR-028-worker-setup-page.md]
vendor_refs: []
status: in_progress
---
## Why
The Eyes app needs a switch for task texts. A worker should not have to text STOP or START from the phone.

## What changed
- `POST /w/me/texts {on: boolean}` with the same `e:` bearer code as `/w/me`; `no-store`; shares the 5 an hour per code limit with the email routes. A bad body is 400, a bad code 401.
- `on=false` runs the STOP path and `on=true` the START path of `handleWorkerReply`, so the reply text, claim release and location cleanup match a texted STOP or START. A banned worker stays off.
- `GET /w/me` and this route return `texts_on`, the same value as `opted_in`.
- No migration.

## Verification
- `server.test.ts`: both directions, bad body, missing code.
- Engine integration test: STOP then START, `texts_on` in the setup, bad code refused.
