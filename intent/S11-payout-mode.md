---
task: S11-payout-mode
files:
  - apps/mcp/src/main.ts
  - apps/mcp/src/main.test.ts
  - apps/mcp/src/server.ts
  - apps/mcp/src/server.test.ts
  - apps/web/worker/src/pages/index.astro
  - apps/web/worker/src/layouts/Layout.astro
  - apps/web/worker/src/me.ts
  - apps/web/worker/src/me.test.ts
  - apps/web/worker/e2e/join.spec.ts
  - scripts/resolve-task.ts
---

## Why

Issue #101 reports real payout promises while Stripe uses test keys.
Follow the default in issue #180: say no real money yet and hide payout setup in test mode.
The existing provider decision now distinguishes Stripe test and live keys.
Server startup and the resolution command use that decision for `live_payouts`.
Test payments still use Stripe and its signature checks, not fake payments.
Worker setup gives the payout mode priority over an existing Stripe account.
The shared worker layout labels test tasks before any page content and removes payout promises from link previews.
The health response keeps provider availability separate from payment mode, so test keys cannot trigger a false outage alert.
Test-key payout onboarding is off by design; existing test accounts can still receive test transfers, never real money.
The static worker site keeps its existing `VITE_LIVE_PAYOUTS` flag; deployment must rebuild it with `false` during test payments.
No Stripe settings, secrets, production data, or deployment change in this task.

## Verification

The new regressions failed before the fix for both test-key prefixes and existing test accounts.
The same eight regression cases pass after the fix, including live-key and fake-provider controls.
Check status and health responses, payment webhook guards, worker setup, join, and capture behavior.
Scoped unit checks passed (381 tests), contract checks passed (12 tests), and integration checks passed (96 tests).
Lint, typecheck, intent, and Sentrux checks passed.
All worker pages, join success, the API home, and status were captured and inspected at desktop and phone widths (56 screenshots).
Nine worker routes showed the test notice and safe preview text with JavaScript disabled.
Keep the pull request as a draft until screenshot approval.

Main integration preserves the shared START instructions and test-mode notice.
The payout checklist now creates the payout row only for live payments.
The integration checks passed: 510 affected tests, nine database scenarios, and 61 checklist tests after cleanup.
The worker browser suite passed 71 cases; all 19 capture cases passed after using the required test origin.
Sentrux passes after staging the resolved merge files; unresolved index stages caused duplicate function counts.
