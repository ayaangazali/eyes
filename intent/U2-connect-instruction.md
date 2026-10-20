---
task: U2-connect-instruction
title: Add the instruction above the connect button
files: [apps/web/worker/src/join.ts, apps/web/worker/src/join.test.ts, apps/web/worker/e2e/join.spec.ts]
---

## Why

Add "Click below to connect" above the step-1 button, using the existing step text style.
Keep the button label, SMS destination, command body, and other steps unchanged.

## Verification

The browser regression failed before the change because the instruction was absent.
All 18 join browser checks passed at 390 and 1440 pixels after the change.
The regression checks that the instruction appears above the button.
All 31 join unit tests passed, including the shared, dedicated, and international SMS destinations.
