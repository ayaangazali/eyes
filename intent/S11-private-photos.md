---
task: S11
title: Private photo bucket with signed URLs
agent: builder
files: [packages/core/src/providers.ts, packages/core/src/fakes.ts, packages/db/src/storage.ts, packages/db/src/storage.test.ts, packages/engine/src/index.ts, apps/mcp/src/server.ts, apps/mcp/src/ops-lists.ts, docs/DEPLOY.md, intent/decisions/ADR-048-private-photos-signed-urls.md, apps/mcp/src/server.test.ts, packages/engine/src/engine.int.test.ts]
spec_refs: [OWASP API1:2023]
status: done
---
## Why
A public bucket gave every photo a permanent public URL.
## What
See ADR-048: `signPhoto`/`readPhoto` on `Storage`, `GET /photos`, signing in `answerOf`, ops views and the vision input.
## Verification
`packages/db/src/storage.test.ts`: a signed link reads until expiry, fails after, fails when tampered.
