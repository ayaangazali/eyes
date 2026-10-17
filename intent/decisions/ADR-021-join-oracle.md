# ADR-021: The join response does not identify the worker

Status: accepted (2026-10-17, contract change pre-approved by the orchestrator for T4.21). Removes `worker_id` from the frozen `JoinWorkerOutput`.

## Context
Second security sweep of main at c333235, minor #2: `POST /w/join` is unauthenticated. `eyes_join_worker` (002) inserts with `on conflict (phone) do nothing` and, when nothing was inserted, returns the existing row, and `joinWorker` echoed its `id`. So a caller who posts any phone number gets that phone's internal worker id, the same one on every call, and the only guard is the per-address throttle, which an `X-Forwarded-For` spoof gets around (first sweep #2). The id cannot forge `c:`/`e:`/`o:` links, which need `EYES_LINK_SECRET`, but it ties a phone number to the id that appears in the ops feed and in Stripe account metadata.

## Decision
- `JoinWorkerOutput` drops `worker_id`. Every valid join now gets the same body: `opt_in_instructions`, `inkbox_number` and `connect_url: null`. A phone that already joined and a new phone get identical responses.
- Why drop it rather than return a random id for known phones: nothing reads it. The worker web reads only `inkbox_number` (apps/web/worker/src/join.ts), and the only other readers were tests. A random id would be a field that sometimes names no worker, and the engine could not tell an insert from a conflict without a migration, because the function returns a row either way.
- A re-join stays a no-op. 002 never updated name or location on a repeat join (engine int test "never lets a repeat join rewrite an existing worker"), and it must not start: the route is unauthenticated, so an update would let anyone rename any worker, or move them away from the tasks they get, by knowing their phone number. That no-op was never the oracle; the echoed id was.
- The throttle is unchanged: 5 joins per hour per address.
- No migration. `eyes_join_worker` still returns the row to the engine, which ignores it, so the row never leaves the process.

## Alternatives rejected
- A random `worker_id` for a phone that already exists: a made-up value in a contract field, and it needs 015 to change the SQL function.
- Migration 015 to return nothing on conflict: not needed once the response does not depend on the row.
- Keeping the id behind a token: nothing at join time could carry one; the worker has not texted START yet.

## Consequences
- Timing (measured by the PR #70 verifier): a phone that already joined answers about 1.5 ms FASTER than a fresh one (p50 0.89 ms vs 2.36 ms on loopback), because a fresh join commits an INSERT and flushes WAL. The body oracle is closed; this timing side channel remains and is tracked in https://github.com/ayaangazali/eyes/issues/71.
