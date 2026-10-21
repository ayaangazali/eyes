# @eyes/web-worker

The worker web app at `https://app.eyes.pictures`. Workers join, sign in, take task photos and set up location sharing here. It is a static Astro site; every page calls the API server (`apps/mcp`) from the browser.

## Entry points

Each page in `src/pages/` has its logic in a matching `src/*.ts` module, which unit tests cover:

| Page | Module | What it does |
|---|---|---|
| `index.astro` | `join.ts` | Join Eyes. |
| `login.astro`, `me.astro` | `email.ts`, `me.ts` | Sign in, then the worker's setup and task list. |
| `capture.astro` | `capture.ts` | Answer a task with a photo (`/capture.html?t=...`, the link the server texts workers). |
| `here.astro`, `automation.astro` | `here.ts`, `automation.ts` | Send the current location once, or set up automatic sending. |
| `install.astro`, `app.astro` | `install.ts`, `app-link.ts` | Install the iPhone app (`apps/mobile`) and open it with a connect code. |

`src/api.ts` is the shared API client.
Build-time `VITE_*` variables set the API URL, Inkbox number, connect text, live payouts, and install links.
The join flow focuses the next-step heading and announces success; server errors receive focus for a retry.
Phone labels use a readable North American format, while SMS links keep the original number.
`src/design/pages/` holds the UI catalog and mood board.
The development server exposes them at `/design/catalog` and `/design/moodboard`; production builds exclude these pages.
`build.format: "file"` in `astro.config.mjs` keeps the `.html` URLs that texts already contain.

## Commands

```sh
pnpm --filter @eyes/web-worker dev     # local dev server
pnpm --filter @eyes/web-worker build   # static output in dist/
```

## Test it

```sh
pnpm exec vitest run --project unit apps/web/worker
pnpm exec playwright test --project worker
```

The Playwright project builds the app twice with test `VITE_*` values and serves both builds (see the root `playwright.config.ts`).

Deploys are manual; see [docs/DEPLOY.md](../../../docs/DEPLOY.md). See also [docs/architecture.md](../../../docs/architecture.md) and [CONTRIBUTING.md](../../../CONTRIBUTING.md).
