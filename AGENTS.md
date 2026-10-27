# Eyes agent guide

## Repository

- `apps/mcp/`: MCP/API server, OAuth, webhooks, and operations pages.
- `apps/edge/`: Cloudflare Workers for forwarding, static sites, and monitoring.
- `apps/web/`: landing site, worker app, and dashboard.
- `apps/mobile/`: Expo iPhone app.
- `packages/`: shared core, database, engine, communications, payments, safety, verification, and UI.
- `cli/`: CLI and generated agent documentation.
- `scripts/`, `evals/`, and `e2e/`: project tools, evaluations, and end-to-end tests.
- `intent/`: design intent, its generated index, and architecture decisions.

## Local checks

Use Node.js 26 and pnpm 11.18.0.
Run `pnpm verify:fast` for lint, typecheck, unit, contract, safety, and intent checks.
Run integration tests only against a disposable Postgres database: `pnpm db:up`, `pnpm db:migrate`, then `pnpm test:integration`.
Run `pnpm test:e2e` for Playwright tests.
See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and CI details.

## Intent and decisions

For changes under `apps/`, `packages/`, `cli/`, `scripts/`, or `db/`, add or update an intent file.
Follow [CONTRIBUTING.md](CONTRIBUTING.md) for intent fields, dependency-only exceptions, and ADR requirements.
Add an ADR under `intent/decisions/` when changing a core contract or migration.
Keep migrations append-only, and run `pnpm intent:index` after intent changes.

## Pull requests

Use a conventional commit and pull request title.
Link the issue, describe the change, and report the checks you ran.
Do not commit secrets or production data.
