# @eyes/mcp

The Eyes API server. One Node process serves the MCP tools, the REST API (`/v1`), webhooks, OAuth, the public agent docs from `docs/public/`, and the ops page at `/ops`. It also runs the background expiry and payout loops.

## Entry points

- `src/main.ts`: `start(env)` reads the `EYES_*` environment (see `.env.example`), picks fake or live providers, connects the database, and starts the HTTP server. Running the file directly boots the server.
- `src/server.ts`: `createServer()` builds the Hono app with every route; `liveProviders()` decides which providers are live.
- `src/http.ts`: `toNodeListener()` adapts the app to `node:http`.
- `src/widget.ts`: the MCP Apps confirmation card (`ui://eyes/confirmation-card.html`).
- `src/oauth.ts`, `src/ops-*.ts`, `src/short-links.ts`: OAuth, the ops page routes, and short links.

The server composes `@eyes/engine`, `@eyes/db`, `@eyes/comms`, `@eyes/payments`, `@eyes/safety`, `@eyes/verify` and `@eyes/web-dashboard`. The Cloudflare edge Worker in `apps/edge/api` forwards public traffic to it. The CLI integration test (`cli/src/ask.int.test.ts`) runs the CLI against this server.

## Run it

Export the variables in `.env.example` (fake providers, local Postgres), run `pnpm db:migrate`, then:

```sh
pnpm --filter @eyes/mcp dev
```

## Test it

```sh
pnpm exec vitest run --project unit apps/mcp
DATABASE_URL=postgres://postgres:eyes@127.0.0.1:54329/eyes pnpm exec vitest run --project integration apps/mcp
```

The integration tests need a disposable local Postgres; see [CONTRIBUTING.md](../../CONTRIBUTING.md).

Deploys are manual; see [docs/DEPLOY.md](../../docs/DEPLOY.md). For the request path and package map, see [docs/architecture.md](../../docs/architecture.md).
