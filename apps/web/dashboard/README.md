# @eyes/web-dashboard

The operator views and the event log that feeds them. The API server (`apps/mcp`) imports this package and serves the ops page at `/ops`; this package also has a small local feed page of its own.

## Entry points

The package export is `src/server.ts`. It re-exports:

- `OPS_PAGE`: the ops page HTML (`src/ops.html`) with the shared `@eyes/ui` styles, icons and the built page script inlined. `apps/mcp/src/server.ts` serves it at `/ops`.
- `createEventLog`, `captureConsole`, `redact`, `summarize` (`src/ops.ts`): the in-memory event log, console capture, secret redaction and the feed summary. `apps/mcp` uses all four.
- `createClickHouseSink`, `clickHouseConfig`, `mirrorTriggerEvents`, `readClickHouseSeries` (`src/clickhouse.ts`): optional ClickHouse event storage, on when `CLICKHOUSE_URL` is set.
- `createIssueSink`, `occurrenceOf` (`src/issues.ts`): groups logged server errors into issues for the ops Errors tab and stores them in Postgres.
- `createDashboardServer`, `startFromEnv`, `readFeed`: the local feed page (`src/index.html`, `GET /` and `GET /feed`), loopback only.

The ops page script lives in `src/ops-view/*.ts`. `scripts/build-ops-view.ts` joins it into the committed `src/ops-view.gen.js`, because the page CSP allows one hashed inline script.

## Commands

```sh
pnpm --filter @eyes/web-dashboard build   # regenerate src/ops-view.gen.js after editing src/ops-view/
pnpm --filter @eyes/web-dashboard start   # local feed page on http://127.0.0.1:4400 (needs DATABASE_URL, or InsForge keys)
```

## Test it

```sh
pnpm exec vitest run --project unit apps/web/dashboard scripts/build-ops-view.test.ts
pnpm exec playwright test --project dashboard
DATABASE_URL=postgres://postgres:eyes@127.0.0.1:54329/eyes pnpm exec vitest run --project integration apps/web/dashboard
```

`build-ops-view.test.ts` fails when `src/ops-view.gen.js` is stale. The Playwright tests route every request in the test, so they need no server.

See [docs/architecture.md](../../../docs/architecture.md) and [CONTRIBUTING.md](../../../CONTRIBUTING.md).
