---
task: G1-e2e
title: Gate G1 golden path end to end on fakes
agent: e2e-builder
pr: pending
files: [e2e/**, playwright.config.ts, package.json, pnpm-lock.yaml]
spec_refs: [§1 Flow, §5 Gate G1, §6, §13 steps 2-4]
vendor_refs: [docs/vendor/inkbox.md]
status: needs-follow-up
---
## Why
Gate G1 needs proof that the merged pieces work together, not just alone: an MCP agent asks, Inkbox-texted workers race to claim, the capture page takes a live photo, verification passes, the agent gets the answer and the worker is paid. `e2e/golden-path.spec.ts` runs that whole §1 flow against the real MCP server, Node adapter, engine, Postgres, Inkbox webhook route, verification and worker web build, with only providers faked.

## What
- `golden` project: four workers join over `POST /w/join` (three within 500 m of Blue Bottle, one in Oakland), each texts START through a signed `POST /webhooks/inkbox`, and the payee opens its `/w/connect` link (302 to the fake Connect account).
- The agent signs up over REST, connects `@modelcontextprotocol/client` to `/mcp` with its key, calls `quote_task` and `ask_eyes`. Asserts: offers went to exactly the three near workers, no offer text contains the question, YES from the payee wins, YES from the runner-up gets `already_claimed`.
- Chromium with a fake camera and GPS at the cafe opens the texted capture link, shoots, answers and submits; the page shows "Verified and paid" with all three checks passed.
- `await_answer` returns `paid` with the answer text, a photo URL, all checks true, distance under 150 m and cost 3.5; balance goes 20 to 16.5; one 300-cent transfer to the payee's account; the payee got the paid text.
- Second test: `ask_eyes` for "Photograph the house at 123 Oak St" must return `unsafe_task` with a `fix`.
- `playwright.config.ts`: `golden` gets the fake media and cafe geolocation (shared with `worker`) and a 120 s timeout; a second webServer builds the worker web into `dist/golden` with `VITE_EYES_API_URL=http://127.0.0.1:3399` and serves it on 4174.

## Decisions & alternatives rejected
- Safety: `@eyes/safety` on main is the T1.5 `not_implemented` stub. `beforeAll` probes `createAssessTask({})` once; on `not_implemented` it injects an allow verdict and the unsafe test skips with that reason. When T1.5 merges, the real layer is used and the unsafe test runs with no edit (checked locally by swapping in a rule-based stub: 2 passed).
- Fixed worker phones, no truncation: the spec never wipes a database it is pointed at. `eyes_join_worker` returns the existing row for a known phone, so reruns reuse the same four workers. `afterAll` cancels the task if it is still dispatched, so a failed run cannot leave an open offer that a later runner-up YES would claim.
- Second build in `apps/web/worker/dist/golden`: the `worker` project bakes `VITE_EYES_API_URL=http://127.0.0.1:4173/api` into `dist`, so a shared output dir would serve the wrong API. Playwright starts webServers in order, so the `worker` build (which empties `dist`) always finishes before the golden build. `dist` is gitignored.
- `await_answer` is called after the capture response, which returns only once the payout is recorded, so the status is deterministically `paid` (a call during capture could see `verified` first).
- Workspace code is imported by relative path (`../packages/engine/src/index.ts`) since the root has no workspace links; pnpm resolves symlinks to the same files, so `EyesError` is one class.

## Assumptions
- Inkbox signature as built by `packages/comms/src/inkbox.test.ts`: HMAC-SHA256 hex over `<request-id>.<timestamp>.<raw body>` in `x-inkbox-signature: sha256=<hex>`.
- CI's `e2e` job gives a fresh database (`DATABASE_URL`, `pnpm db:migrate`), so no workers near the cafe exist but these. Without `DATABASE_URL` the spec skips, like the `*.int.test.ts` files.

## Verification
- `DATABASE_URL=postgres://postgres:eyes@127.0.0.1:54329/eyes_g1 CI=1 pnpm test:e2e` (both projects, rebased on a037334), 3 runs in a row on one database plus 1 run on a freshly migrated one: 20 passed, 1 skipped (the unsafe test, stub reason) every run.
- Mutation: GPS check in `packages/verify` made to fail: the spec fails at "Verified and paid"; the next run on the same database passes again.
- `pnpm verify:fast`: pass.
- Verifier verdicts: pending.

## Known gaps
- The unsafe-task test is skipped until T1.5 merges.
- Root `package.json` gains the `@modelcontextprotocol/client` devDependency (same 2.3.1 as `apps/mcp`): files under `e2e/` resolve packages from the root only.
