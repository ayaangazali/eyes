# @eyes/safety

The task safety check. It decides if Eyes can send a task to a worker, and it gives a reason and a fix when it blocks a task.

## How it works

1. `src/rules.ts` checks the question and the place label with fixed patterns. A rule match always blocks.
2. If no rule matches, an AI classifier checks the question:
   Cloudflare Workers AI (clef) when `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set, else Claude when `ANTHROPIC_API_KEY` is set.
   If clef fails and `ANTHROPIC_API_KEY` is set, Claude decides.
3. If the classifier fails, the check fails closed and returns `UNAVAILABLE`.
   With no classifier credentials, only the rules run.

Clef blocks a category only at or above a confidence threshold: `EYES_CLASSIFIER_BLOCK_MIN`, from 0.5 to 1, default 0.95.

## Exports

From `src/index.ts`:

- `createAssessTask(env, blockMin?)`: returns an `AssessTask` function from `@eyes/core`. `blockMin` can supply the threshold at run time.
- `UNAVAILABLE`: the verdict when the classifier cannot answer.

## Use in the repo

`apps/mcp/src/main.ts` gives `createAssessTask(env, settings.blockMin)` to the engine as `assessTask`, wrapped in `instrumentAssess` for logging.
The ops settings supply `blockMin`.
`pnpm safety:eval` runs the full check against `evals/safety/fixtures.json`.

## Tests

```sh
pnpm vitest run --project unit packages/safety
pnpm test:safety
```

`pnpm test:safety` runs the rule tests (`*.rules.test.ts`) against the same fixtures.

## See also

- [Architecture](../../docs/architecture.md)
- [Contributing](../../CONTRIBUTING.md)
