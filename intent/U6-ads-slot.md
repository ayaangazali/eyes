---
task: U6
files:
  - apps/web/worker/src/api.ts
  - apps/web/worker/src/pages/me.astro
  - apps/web/worker/e2e/me.spec.ts
  - docs/features/ads.md
---

## Why

Issue #264 asks for a written ads design and an off-by-default ad slot, with ad money credited against the cost of a human check.
The design in `docs/features/ads.md` covers placement, ad source, disclosure, privacy impact (#115, #111) and the credit calculation.
The slot is one `Sponsored` card on the worker setup page, shown only when the build sets `VITE_ADS=true`.
No ad network, sponsor, live ad, pricing change or privacy policy change is part of this change.

## Verification

Build the worker app with and without `VITE_ADS=true` against a local mock API.
Capture desktop and phone screenshots of `/me` before and after.
Run the `/me` Playwright tests, which check that a default build shows no slot, plus lint, typecheck and the intent checker.
