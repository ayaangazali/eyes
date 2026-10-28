---
task: S09
title: Bot sign-up defense (Turnstile and per-phone join limit)
files: [apps/mcp/src/server.ts, apps/mcp/src/server.test.ts, apps/web/worker/src/join.ts, apps/web/worker/src/api.ts, apps/web/worker/src/pages/index.astro]
spec_refs: [intent/decisions/ADR-028-worker-setup-page.md]
vendor_refs: []
status: in_progress
---
## Why
Bots can join workers in bulk. OWASP API6:2023 asks for human detection on sign-up.

## What changed
- `POST /w/join` from the web origin needs the header `x-turnstile-token`. The server checks it with Cloudflare siteverify using `TURNSTILE_SECRET_KEY`. A missing, failed or unconfigured check is 400 `invalid_input`.
- The app join has no widget and no web Origin, so it skips the check.
- All joins get a limit of 3 an hour per phone (429), next to the 5 an hour per IP.
- The join page shows the widget when `VITE_TURNSTILE_SITE_KEY` is set. No keys are committed. A worker still gets tasks only after texting START.
- No migration.

## Verification
- `server.test.ts`: phone limit, web join without token, with a failing token.
