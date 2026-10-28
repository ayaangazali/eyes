---
task: S04
title: Worker and owner dispute routes
files: [packages/db/migrations/049_dispute_routes.sql, packages/core/src/__snapshots__/core.contract.test.ts.snap, docs/public/llms-full.txt, docs/public/openapi.json, packages/core/src/schemas.ts, packages/core/src/service.ts, packages/engine/src/index.ts, packages/engine/src/engine.int.test.ts, apps/mcp/src/server.ts, apps/mcp/src/server.test.ts, apps/web/worker/src/me.test.ts]
spec_refs: [intent/decisions/ADR-050-dispute-routes.md, intent/decisions/ADR-026-disputes.md]
vendor_refs: []
status: in_review
---
## Why
The app lets an owner dispute a result and a worker contest an owner's dispute. Both sides must see the state.

## What changed
- `POST /owner/:token/tasks/:task_id/dispute` and `POST /w/me/tasks/:task_id/dispute`, `{reason}` of 5 to 1000 characters, `no-store`, 10 an hour per token.
- Owner: wrong owner 404, second dispute 409, bad link 401. Worker: other worker's task 404, none open or already contested 409.
- `dispute` (`open`, `in_review`, `stands`, `upheld`, or null) on `list_tasks`, owner `tasks.json` and `/w/me/tasks` items.
- Migration 049: `tickets.appeal`, `eyes_worker_dispute`, `eyes_dispute_states`.

## Verification
- `server.test.ts`: both routes, bad reason, bad token, throttle.
- Engine integration test: both actors, wrong owner, double dispute, state in both lists through open, in_review and stands.
