---
task: U1
files:
  - apps/web/landing/src/pages/index.astro
  - apps/web/landing/src/pages/404.astro
  - apps/web/worker/src/pages/404.astro
  - apps/web/landing/public/images/*.webp
  - apps/web/landing/wrangler.jsonc
  - apps/web/worker/wrangler.jsonc
  - apps/web/landing/e2e/not-found.spec.ts
---

## Why

Reduce image transfer sizes without changing the landing design for #112.
Provide styled missing-page responses with a home link on both static sites for #113.
Use responsive WebP images and Cloudflare's native 404-page handling.

## Verification

Build both static sites and inspect desktop and phone screenshots.
Measure phone LCP with the same network and CPU settings before and after.
Run the missing-page browser regression against both local asset servers.
Run lint, typecheck, related unit tests, and the Sentrux gate.
