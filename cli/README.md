# @eyes/cli

The `eyes` command line client for agents and people, plus the generator for the public agent docs.

## Entry points

- `src/main.ts` (the `eyes` bin): commands `signup`, `ask`, `await`, `quote`, `status`, `tasks`, `cancel`, `dispute`, `balance` and `policy`. Each one validates its arguments with the `@eyes/core` input schemas, then calls the REST API (`/v1/...`) of the server in `apps/mcp`. `signup` saves `api_url` and `api_key` to `~/.config/eyes/config.json`; `EYES_API_URL` and `EYES_API_KEY` override that file. `--json` prints one JSON object per line.
- `src/docs.ts`: generates `docs/public/openapi.json`, `docs/public/llms-full.txt` and `docs/public/.well-known/agent-card.json` from the `@eyes/core` tool and route definitions plus `docs/public/llms.txt`. The API server serves these files.

## Use it

Set `EYES_API_URL` to the server's origin before the first `signup`.

```sh
node cli/src/main.ts --help
node cli/src/main.ts signup --name my-agent
node cli/src/main.ts ask "How long is the line?" --at "37.78,-122.41" --type line_length
```

Regenerate the public docs after changing a tool or route in `@eyes/core`:

```sh
pnpm --filter @eyes/cli gen:docs
```

## Test it

```sh
pnpm exec vitest run --project unit cli
DATABASE_URL=postgres://postgres:eyes@127.0.0.1:54329/eyes pnpm exec vitest run --project integration cli
```

`docs.test.ts` fails when the committed files in `docs/public/` are stale. `ask.int.test.ts` runs `eyes ask` against the real server and Postgres.

See [docs/architecture.md](../docs/architecture.md) and [CONTRIBUTING.md](../CONTRIBUTING.md).
