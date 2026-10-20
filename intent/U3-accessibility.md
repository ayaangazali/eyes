---
task: U3-accessibility
title: Fix contrast, keyboard access, tap targets, and marquee pause
files: [packages/ui/src/tokens.css, packages/ui/src/components.css, packages/ui/src/page.ts, apps/web/landing/src/pages/index.astro, apps/web/landing/src/layouts/Layout.astro, apps/web/landing/e2e/accessibility.spec.ts]
---

## Why

Issue #129 identifies unreadable status colors, unreachable code samples, small navigation targets, and a marquee without a pause control.
Keep the existing surfaces and type sizes.
Change only the failing status text colors and use the shared 44-pixel tap token.
Let keyboard users focus, identify, and horizontally scroll each code sample without widening the page.
Pause the marquee when its controls have keyboard focus or its pause toggle is active.
Keep the existing reduced-motion rule, which prevents the animation from starting.

## Verification

The browser regression failed before the fix at 4.04:1 light success contrast, 3.81:1 dark danger contrast, and a 27-pixel header target.
All six browser checks pass after the fix, including keyboard scrolling, persistent pause, mouse resume, and reduced motion.
Capture and inspect the changed areas at 1440 and 390 pixels in both themes, with the header visible.
Measure the status colors against their composed backgrounds: all named pairs now exceed 4.5:1.
Run lint, typecheck, the shared-page and landing-motion unit tests, API server tests, contract tests, and relevant API integration tests.
The PR includes the measurements and before/after screenshots.
