# @eyes/db

The database layer: Postgres migrations, the RPC transport that calls Postgres functions, and photo storage on InsForge.

## Contents

- `migrations/`: numbered SQL files for the Postgres schema and the PL/pgSQL functions that hold the business logic.
- `clickhouse/`: SQL for the ClickHouse event tables. `scripts/clickhouse-migrate.ts` applies it.
- `src/migrate.ts`: `migrate(url)` applies the pending migrations in filename order and records them in `schema_migrations`.
- `src/rpc.ts`: `createRpc(db)` returns an `Rpc` function that calls a Postgres function by name.
  It uses direct Postgres for `{ kind: "postgres" }` and InsForge HTTP RPC for `{ kind: "insforge" }`.
  It turns `eyes:<code>` database errors into `EyesError`.
- `src/storage.ts`: `createInsforgeStorage(env)` is the `Storage` provider for photos. It needs `INSFORGE_BASE_URL` and `INSFORGE_API_KEY`.

`src/index.ts` exports `migrate`, `createRpc`, `Rpc`, `RpcArgs`, and `createInsforgeStorage`.

## Use in the repo

`packages/engine` calls the database functions through `createRpc`.
`apps/mcp` and `apps/web/dashboard` use `Rpc` for their own queries, and `apps/mcp` makes the photo storage.

## Tests

```sh
pnpm vitest run --project unit packages/db
DATABASE_URL=postgres://postgres:eyes@127.0.0.1:54329/eyes pnpm vitest run --project integration packages/db
```

The integration tests need a local Postgres.

## See also

- [Architecture](../../docs/architecture.md)
- [Contributing](../../CONTRIBUTING.md)
