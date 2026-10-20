---
task: C8-independent-expiry
files:
  - apps/edge/monitor/worker.js
  - apps/edge/monitor/worker.test.ts
  - apps/edge/monitor/worker.int.test.ts
  - docs/DEPLOY.md
  - docs/PLAN.md
  - STATUS.md
  - docs/SUBMISSION.md
---

# Refunds during API outages

## Why

Issue #31 leaves expiry refunds waiting when the API process is down.
Following the default in #180, the existing Cloudflare monitor cron calls `eyes_expire_overdue` once per minute.
The monitor already uses the InsForge base URL and admin API key for release checks.
This change reuses those values and the existing transactional RPC, without a new secret, migration, or public server route.
The RPC serializes overlapping sweeps and records each refund once.
Expiry failures do not block uptime alerts or release checks.
The cron waits for expiry to finish before it returns an alert failure.
The server keeps its existing sweep and email reply loop; this change adds only the independent expiry trigger.

## Verification

- Run the monitor unit tests for authenticated RPC requests during API outages, missing configuration, and failed database requests.
- Run the monitor integration tests with `DATABASE_URL=postgres://postgres:eyes@127.0.0.1:54329/eyes`.
- Hold the database sweep lock until both the cron and server sweep are waiting, then release it.
- Check one refund per expired task, the exact restored balance, and an unchanged future task after a repeated cron tick.
- Run lint, typecheck, contract tests, and the Sentrux gate.

The integration tests fail before the trigger exists because no cron sweep reaches the database lock.
The deployment guide describes the existing configuration and the required future Worker deployment.
This change does not deploy the monitor or change Cloudflare settings.
