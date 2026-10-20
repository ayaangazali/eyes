# @eyes/verify

Checks a worker's photo submission before Eyes accepts it: location, freshness, and photo moderation.

## Exports

From `src/index.ts`:

- `verifySubmission`: the `VerifySubmission` function from `@eyes/core`. It returns:
  - `gps_ok`: the GPS accuracy is 100 m or better, and the worker was inside the task radius (with up to 50 m of slack for GPS error).
  - `fresh_ok`: the submission came before the deadline, and the photo is at most 5 minutes old.
  - `vision_ok`: the photo moderation result, or `null` when moderation failed and a person must review the photo.
  - `confidence` and `auto_approve`: `auto_approve` is true only when all three checks pass.
- `createClefVision(env)`: a `Vision` provider on Cloudflare Workers AI. It needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
  If clef fails and `ANTHROPIC_API_KEY` is set, it asks Claude.
- `createClaudeVision(env)`: a `Vision` provider on Claude. It needs `ANTHROPIC_API_KEY`.

Moderation only looks for gore and explicit sexual content.
Eyes does not judge if the photo answers the question; the agent does.

## Use in the repo

`apps/mcp/src/main.ts` gives `verifySubmission` to the engine.
With live vision, it uses `createClefVision` when the Cloudflare credentials are set, else `createClaudeVision`.
Without live vision, it uses the fake vision from `@eyes/core`.

## Tests

```sh
pnpm vitest run --project unit packages/verify
```

## See also

- [Architecture](../../docs/architecture.md)
- [Contributing](../../CONTRIBUTING.md)
