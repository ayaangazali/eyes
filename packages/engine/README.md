# @eyes/engine

The business logic of Eyes. It implements the `EyesService` interface from `@eyes/core`: agents, tasks, workers, payments, disputes, and expiry.

## Exports

From `src/index.ts`:

- `createEyesService(deps, notice?)`: returns an `EyesService`.
  `deps` is an `EngineDeps` (database config, providers, `assessTask`, `verifySubmission`, app config).
  `notice` receives info events, such as an email that a provider refused.
- `recipientGateDenial(err)`: reads the gate names from an email provider refusal.
- `Notice`: the type of the `notice` callback.

The engine calls the Postgres functions in `packages/db/migrations/` through `createRpc` from `@eyes/db`.
It sends messages and moves money only through the providers in `deps`, so tests can use the fakes from `@eyes/core`.

## Use in the repo

`apps/mcp/src/main.ts` makes the service and runs `expireOverdue` and `retryPayouts` on a timer.
`apps/mcp/src/sandbox.ts` makes a second service for sandbox mode.
Integration tests in `apps/mcp`, `apps/web/dashboard`, and `cli` also use it.

## Tests

All engine tests are integration tests and need a local Postgres:

```sh
DATABASE_URL=postgres://postgres:eyes@127.0.0.1:54329/eyes pnpm vitest run --project integration packages/engine
```

## See also

- [Architecture](../../docs/architecture.md)
- [Contributing](../../CONTRIBUTING.md)
