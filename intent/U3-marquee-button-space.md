---
task: U3-marquee-button-space
title: Reserve space for the marquee pause button
files: [apps/web/landing/src/pages/index.astro, apps/web/landing/e2e/accessibility.spec.ts]
---

## Why

The phone screenshot for issue #129 showed moving text beneath the round pause button.
Clip the text before the button and fade its last 32 pixels into the yellow band.
Keep a 12-pixel gap between the text window and the button in both themes.
Keep the existing band height, 44-pixel button, hover pause, keyboard control, and reduced-motion behavior.
Remove the reserved space and mask when reduced motion hides the button.

## Verification

The browser regression failed before the fix: the text window reached x=390 while the phone button started at x=326.
The regression passes with the clipped window at x=314, including desktop and reduced motion.
All four marquee browser tests pass.
Captured and inspected two animation frames at 1440 and 390 pixels in both themes.
Run the full landing browser suite, lint, typecheck, landing motion unit tests, and intent checks.
