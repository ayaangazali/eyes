---
task: U2
files:
  - apps/web/worker/src/join.ts
  - apps/web/worker/src/join.test.ts
  - apps/web/worker/src/pages/index.astro
  - apps/web/worker/src/pages/design/catalog.astro
  - apps/web/worker/src/pages/design/moodboard.astro
  - apps/web/worker/src/design/pages/catalog.astro
  - apps/web/worker/src/design/pages/moodboard.astro
  - apps/web/worker/astro.config.mjs
  - apps/web/worker/e2e/join.spec.ts
  - apps/web/worker/README.md
---

## Why

Fix #114 by focusing the next-step heading and announcing join success through a persistent live region.
Focus the error notice after a server failure so keyboard users can retry.
Fix #131 by retaining the locate icon, formatting the displayed phone number, and explaining the connect message.
Follow the default in #180: expose the design pages only during development and do not add phone navigation.
Keep the existing design and SMS destinations.
The two design files move without content changes.

## Verification

The new keyboard browser regression fails on the original build because the next-step heading does not receive focus.
Run the join browser suite, including live-region, error-focus, icon-retry, and production-route checks.
Capture and inspect before/after screenshots at 1440px and 390px widths.
Run lint, typecheck, join unit tests, core contract tests, and the existing repeat-join integration case.
Run the Sentrux gate and refresh the intent index.
