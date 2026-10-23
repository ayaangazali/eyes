---
task: U5
files:
  - apps/web/landing/src/pages/privacy.astro
  - apps/web/landing/src/pages/index.astro
  - apps/web/worker/src/pages/index.astro
  - apps/web/worker/src/pages/install.astro
  - apps/web/worker/src/pages/privacy.astro
  - apps/web/worker/public/_redirects
  - apps/web/landing/e2e/metadata.spec.ts
  - apps/web/worker/e2e/join.spec.ts
  - docs/features/email-channel.md
---

## Why

Address the code-only scope in #246 using the approved defaults in #180.
Keep one policy at https://eyes.pictures/privacy with the worker policy's device-ID facts and existing Cloudflare Web Analytics disclosure.
Use native Cloudflare static-asset 301 redirects for old worker privacy links.
Remove the duplicate policy and point existing links to the canonical policy.
Keep the design and unrelated policy text unchanged.

No verified private data-request address was found in the public issues or recorded contact details.
Keep #115 open for that owner requirement and do not describe public issues as a private channel.
Keep #111 open for its remaining Cloudflare host exclusions.
This change does not alter analytics settings or deploy anything.
The extra documentation file prevents a broken source link after removing the worker policy.

## Verification

Build both static sites and serve them with local Wrangler asset servers.
Check the canonical policy, permanent redirects for `/privacy`, `/privacy/`, and `/privacy.html`, and the join-page link.
Capture desktop and phone screenshots before and after the change.
Run focused metadata checks, lint, typecheck, the intent checker, one ponytail-review round, and the Sentrux regression gate.
