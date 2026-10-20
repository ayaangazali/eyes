# @eyes/web-landing

The public landing site at `https://eyes.pictures`. It is a static Astro site with Tailwind and the shared `@eyes/ui` styles.

## Entry points

- `src/pages/index.astro`: the landing page, including the server URL copy box for connecting an agent app and the scroll motion (GSAP).
- `src/pages/privacy.astro`, `src/pages/terms.astro`: the privacy policy and terms.
- `src/layouts/Layout.astro`: the shared page shell.
- `src/motion.ts`: `wireCopy` (copy button and its hint) and `createFlight` (the step state of the "flight" panel that the scroll motion drives), written against small element shapes so unit tests run them without a browser.
- `wrangler.jsonc`: serves `dist/` as Cloudflare static assets on `eyes.pictures` and `www.eyes.pictures`.

No other package imports this one.

## Commands

```sh
pnpm --filter @eyes/web-landing dev     # local dev server
pnpm --filter @eyes/web-landing build   # static output in dist/
```

## Test it

```sh
pnpm exec vitest run --project unit apps/web/landing
pnpm exec playwright test --project landing
```

The Playwright project builds the site and serves `dist/` on port 4327 (see the root `playwright.config.ts`).

Deploys are manual; see [docs/DEPLOY.md](../../../docs/DEPLOY.md). See also [docs/architecture.md](../../../docs/architecture.md) and [CONTRIBUTING.md](../../../CONTRIBUTING.md).
