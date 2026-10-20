---
task: U2-joined-buttons
title: Separate joined actions from instructions
files: [apps/web/worker/src/join.ts, apps/web/worker/src/join.test.ts, apps/web/worker/src/pages/index.astro, apps/web/worker/e2e/join.spec.ts]
---

## Why

The long SMS label wrapped inside a yellow pill and looked like a message bubble.
Use the existing primary button with a short label and show its destination below it.
Give shared-mode START its own numbered instruction, with no link to the router.
Keep a single START button for dedicated lines and remove the repeated helper text.
No shared button styles or backend contracts change.

## Verification

Three regression cases failed before the change; all 31 join unit tests pass after it.
The cases cover the shared router, the dedicated fallback, and an international destination.
Browser captures at 390 and 1440 pixels show a single-line, 44-pixel button and separate numbered instructions.
A held pointer changes the button color and applies the existing 0.97 press scale.
The browser regression checks the button height, separate destination, and noninteractive START step.
Lint, typecheck, 15 core contract tests, four worker-setup integration tests, and 14 browser tests pass.
The dedicated-line browser smoke check passes at both widths.
Sentrux stays at 6491 and reports no degradation against the tracked 6494 baseline.
