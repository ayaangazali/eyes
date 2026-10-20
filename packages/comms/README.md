# @eyes/comms

Messaging and email adapters. Eyes sends text messages through Inkbox and email through Inkbox or Primitive.
The package also receives inbound webhooks from both providers.

## Exports

From `src/index.ts`:

- `createInkboxMessaging(env)`: a `Messaging` provider that sends text messages to workers.
- `createInkboxEmail(env)` and `createPrimitiveEmail(env, firstContact?)`: `Email` providers.
- `withWorkerEmail(messaging, email, domain)`: wraps a `Messaging` provider so that sends to an email address go out as email.
- `inkboxRoutes(deps, env)` and `primitiveRoutes(deps, env)`: Hono apps for the inbound webhooks.
- Message text and parsing helpers: `offerText`, `captureLinkText`, `alreadyClaimedText`, `paidText`, `parseReplyIntent`, `parseTaskEmail`, `workerReplyText`.

The provider interfaces (`Messaging`, `Email`) come from `@eyes/core`.

## Use in the repo

`apps/mcp/src/main.ts` makes the providers from environment variables (`INKBOX_*`, `PRIMITIVE_*`).
`apps/mcp/src/server.ts` mounts the routes at `/webhooks/inkbox` and `/webhooks/primitive`.

`scripts/send-test.ts` sends one test text: `node packages/comms/scripts/send-test.ts <E.164 phone> [text]`.
It sends a real message, so it needs `INKBOX_API_KEY` and `INKBOX_AGENT_HANDLE`.

## Tests

```sh
pnpm vitest run --project unit packages/comms
```

The tests mock the provider SDKs and `fetch`, so they do not call the providers.

## See also

- [Architecture](../../docs/architecture.md)
- [Contributing](../../CONTRIBUTING.md)
