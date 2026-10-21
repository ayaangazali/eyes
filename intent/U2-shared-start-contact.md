---
task: U2-shared-start-contact
title: Send shared-line START to the Eyes contact
files: [apps/web/worker/src/join.ts, apps/web/worker/src/join.test.ts, apps/web/worker/e2e/join.spec.ts]
---

## Why

The Inkbox router number is not the assigned Eyes number.
Inkbox sends that number in a contact card and does not expose it in shared-service API responses.
See https://inkbox.ai/docs/capabilities/imessage and https://inkbox.ai/docs/api/imessage/router.
Keep the connect link to the configured router.
In shared mode, replace the addressed START link with one instruction to use the Eyes contact that Inkbox sends.
Keep the numeric START link for dedicated-line mode.

## Verification

The shared-mode regression failed with the old addressed START link and passes with the contact instruction.
The unit tests also cover dedicated-line server numbers and the configured fallback.
Browser screenshots exercise the joined state at 1440 and 390 pixels.
