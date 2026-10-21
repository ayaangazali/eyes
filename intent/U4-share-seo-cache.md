---
task: U4
files:
  - apps/web/landing/src/layouts/Layout.astro
  - apps/web/worker/src/layouts/Layout.astro
  - apps/web/landing/public/_headers
  - apps/web/worker/public/_headers
  - apps/web/landing/public/robots.txt
  - apps/web/worker/public/robots.txt
  - apps/web/landing/public/sitemap.xml
  - apps/web/landing/public/site.webmanifest
  - apps/web/worker/public/site.webmanifest
  - apps/web/landing/public/apple-touch-icon.png
  - apps/web/landing/public/images/share.jpg
  - apps/web/landing/e2e/metadata.spec.ts
---

## Why

Close #130 with absolute JPEG share images, canonical URLs, descriptions, crawler policies, touch icons, and web manifests.
Use the default in #180: worker pages stay noindex and robots.txt blocks crawlers.
Only the public landing pages belong in the sitemap.
The www-to-apex redirect remains a Cloudflare configuration action outside this repository.
The API favicon routes already exist; keep them unchanged.
Cache content-hashed Astro assets for one year and other static responses for one minute.
Replace the inherited cache header on hashed assets without changing security headers.
Keep unversioned images revalidatable, since their URLs do not contain content hashes.
Reuse the existing storefront and favicon artwork for the JPEG and PNG assets.
Keep landing layout changes inside the head to avoid the accessibility work's body changes.
Cloudflare applies the immutable rule to missing hashed paths too; a cached asset 404 can persist until its cache expires.
The required worker robots block can prevent share previews from bots that obey robots.txt.

## Verification

Build both Astro sites and serve their output with local Wrangler asset servers.
Run `LANDING_URL=http://127.0.0.1:14327 WORKER_URL=http://127.0.0.1:14328 pnpm exec playwright test --config apps/web/landing/playwright.config.mjs apps/web/landing/e2e/metadata.spec.ts`.
This browser regression is a manual check; CI does not start these two Wrangler servers.
The regression fails before the fix on missing canonical links and sitemap.
Check metadata on all public pages, image and icon HTTP responses, sitemap entries, crawler policies, and effective cache and security headers.
Render the share image and a card preview with the repository's Playwright Chromium.
Run lint, typecheck, related unit tests, contract tests, integration tests, and Sentrux.
