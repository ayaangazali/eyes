# @eyes/core

The shared contract of Eyes: schemas, error codes, provider interfaces, the service interface, and small helpers.

## Exports

From `src/index.ts`:

- `schemas.ts`: zod schemas and types for tasks, workers, agents, submissions, ledger entries, and the tool inputs and outputs (for example `AskEyesInput`, `Task`, `LedgerEntry`).
- `errors.ts`: `ERRORS`, `EyesError`, and `toErrorBody`. Each error code has a message and a fix.
- `providers.ts`: the provider interfaces `Messaging`, `Email`, `Payments`, `Storage`, `Vision`, `Geo`, and `Clock`.
- `service.ts`: the `EyesService` interface, `AppConfig`, `DbConfig`, `EngineDeps`, `RouteDeps`, and the safety and verification types.
- `fakes.ts`: in-memory providers for tests and for servers without live credentials (`fakeProviders()`, `fakeMessaging()`, and others).
- `util.ts`: money conversion, distance, signed tokens, agent email addresses, and map link parsing.

From `src/phone.ts`, as `@eyes/core/phone`: `toE164(input)`.

## Use in the repo

`packages/engine` implements `EyesService`.
The adapter packages (`comms`, `db`, `payments`, `safety`, `verify`) implement the provider and check types.
`apps/mcp` connects them through `EngineDeps` and `RouteDeps`.

## Tests

```sh
pnpm vitest run --project unit packages/core
pnpm vitest run --project contract packages/core
```

The contract test compares the error catalog and the tool schemas with the snapshot in `src/__snapshots__/`.

## See also

- [Architecture](../../docs/architecture.md)
- [Contributing](../../CONTRIBUTING.md)
