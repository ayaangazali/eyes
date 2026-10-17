# ADR-012: Payout retry and operator resolution

Status: accepted (2026-10-17, orchestrator). Adds to the frozen contract: `EyesService.retryPayouts` and `EyesService.resolveTask`.

## Context
- A failed transfer to an onboarded worker texts "it will be retried", but the only retry was `markWorkerOnboarded`, which runs when Stripe sends a new `account.updated`. A verified task could stay unpaid forever. The Stripe note says Stripe does not retry failed transfers itself, so our payout job must (docs/vendor/stripe.md).
- `needs_review` and `disputed` hold the agent's escrow, and nothing could move it: no refund to the agent, no release to the worker. The MCP instructions already promise that "a human review pays the worker or refunds you".

## Decision
- `retryPayouts(): Promise<{ paid }>` pays up to 25 `verified` tasks whose worker has a `stripe_account_id`, oldest first (`eyes_payouts_due`, which `markWorkerOnboarded` also reads, filtered to its account). It reuses `payOut`, so the Stripe idempotency key stays `payout:<task_id>`, the payout ledger row is unique per task, and only the call whose `eyes_record_payout` moves the task from `verified` to `paid` sends the paid text. It runs on the same interval as `expireOverdue`. It holds no lock across the Stripe call; a concurrent webhook payout sends the same key and records nothing twice.
- `payoutWorker` retrieves the connected account and throws before `transfers.create` unless `capabilities.transfers` is `active`. `stripe_account_id` is set when the worker opens the payout link, before onboarding finishes. Without this check, a retry during onboarding would let Stripe store a capability error under `payout:<task_id>` and replay it after onboarding completes.
- Texts to the worker after verification (paid, payout setup link) are skipped when the worker has opted out. When one fails, only the task id is logged: a text never fails a capture, a payout or a retry batch, because the money has already moved.
- `resolveTask(task_id, "refund" | "release", note)` is operator-only: it is called from `scripts/resolve-task.ts` and is never an MCP tool or REST route. `eyes_resolve_task` locks the task row and accepts only `needs_review` or `disputed`.
  - refund: allowed only while the escrow is still held (no `release` row). Inserts a `refund` row for bounty plus fee, credits the agent, status `refunded`.
  - release: inserts `release` and `fee` rows if they are missing, then status `verified` (or `paid` when a `payout` row already exists, so a worker paid before the dispute is not paid twice). The engine then runs the normal settle path: transfer, payout row and paid text, or the payout setup link when the worker has no Stripe account (then `retryPayouts` or onboarding pays later).
  - The note is appended to `tasks.dispute_reason` as `resolved <decision>: <note>`.
  - Any other status, or a refund after the bounty was released, raises `invalid_input` with the reason in `issues` and the current `status`; an unknown task raises `task_not_found`.
  - The script refuses to run unless payments and messaging are both live, or `EYES_PROVIDERS=fake` is set, so a release can never record a fake transfer against a real database.
- A second resolve of the same task fails on the status check under the row lock. Behind that, `ledger_once_per_task` rejects a second `refund` or a second `release`.
- `007_resolve.sql` adds the two functions with EXECUTE revoked from public, anon and authenticated, and no tables or columns.

## Alternatives rejected
- A fresh Stripe idempotency key per retry: a transfer that reached Stripe but was not recorded would be paid twice. Avoiding that needs the payments adapter to look up transfers by `transfer_group` before creating one.
- Refunding a disputed task after its bounty was released: the ledger has no type that reverses a `release` or `fee`, so the escrow total would go negative, and a refund could land while a transfer for the same task is in flight. Refund is therefore only possible while the escrow is held, so an agent refund and a worker payout can never both happen for one task.
- A new `resolution_note` column or an audit table: the task card allows no schema change, and `dispute_reason` already holds operator-facing text that no agent tool returns.
- An MCP or REST route for resolution: an agent could then settle its own disputes.

## Consequences
- Stripe stores a failed transfer's error under its idempotency key and replays it for at least 24 hours (https://docs.stripe.com/api/idempotent_requests). A transfer that Stripe executed and rejected, such as one blocked by an insufficient platform balance, keeps failing on retry until Stripe prunes the key. The capability check keeps the common case, a worker still onboarding, out of this. Errors where Stripe never started the request (network, rate limit, a concurrent request with the same key) succeed on the next retry.
- Oldest first with a batch of 25: if 25 or more tasks are stuck on accounts that never finish onboarding, newer payouts wait behind them. Each costs one account GET per run.
- A dispute filed after automatic verification can only end in release; reversing an automatic approval needs a reversal ledger type.
- Every payout costs one extra Stripe GET.

## Addendum: fresh key per attempt, payout lease, rotating batch (T4.9, 2026-10-17)

Status: proposed by T4.9 (#46, #52). Supersedes "the Stripe idempotency key stays `payout:<task_id>`", "it holds no lock across the Stripe call", "oldest first" and the first rejected alternative above. No change to `packages/core` signatures. It adds one convention to `Payments.payoutWorker`: an error carrying `outcome_unknown: true` means the transfer POST may have run. Fix round 1 (verdict T4.9-PR57) added that convention and the explicit Stripe client bounds.

### Context
- #46: Stripe saves the result of a POST once the endpoint starts executing, errors included, and replays it for the same key for at least 24 hours (https://docs.stripe.com/api/idempotent_requests, https://docs.stripe.com/error-low-level.md). A transfer refused for low platform balance under `payout:<task_id>` therefore keeps failing for a day after the balance is topped up.
- A new key per attempt is only safe if no two attempts on one task overlap. Otherwise two attempts can both find no transfer and both create one under different keys.
- The engine talks to Postgres one RPC at a time, and on InsForge each RPC is one HTTP request and one transaction. A row lock cannot be held across the Stripe calls, so the lock has to be a lease stored in a row.
- #52: `eyes_payouts_due` returned the oldest 25 tasks every run. 25 tasks on accounts that never finish onboarding blocked every newer payout.

### Decision
- Per-task payout lease, `009_payout_retry.sql`:
  - `eyes_payout_begin(task_id)` locks the task row (`for update`), requires `verified`, and writes a fresh key `payout:<task_id>:<database clock in microseconds>` into the stripe_ref of the task's `release` ledger row. It returns that row only if no other attempt holds the lease. A lease counts as held while it is younger than 15 minutes. Otherwise it returns nothing and the caller skips the task.
  - `payOut` passes that key to `payoutWorker`, records the payout, and calls `eyes_payout_end(task_id, key)`, which clears stripe_ref only if it still holds that key. It does this after a success, and after any failure whose outcome is known: a capability error, a failed lookup, a transfer refused with 400, 402 or 404 (and not a `StripeRateLimitError`), or a failure to record.
  - Every other `transfers.create` failure counts as outcome unknown, and `payOut` does not end the lease. That includes 401, 403, 409, 429, 5xx, network failures, timeouts and non-Stripe errors. The lease then runs out its 15 minutes, so no other attempt can start while Stripe may still run or reconcile that POST. The next attempt's lookup finds the transfer if it was made. `payoutWorker` signals this by throwing the error with `outcome_unknown: true`.
  - The classifier only sees the last of up to 3 tries made under one key. Stripe saves a 400, 402 or 404 under the key and replays it to any earlier try of the same key, so such an answer also covers the earlier tries. A 429 (or 401 or 403) is returned before Stripe's idempotency check and says nothing about an earlier try that may still be running.
  - A wrong "unknown" only delays a payout by 15 minutes, while a wrong "definite" pays twice. The verifiers found both gaps: S2b, where a POST ran 4 s after all 3 tries failed, and S8/S8c, where try 1 timed out and ran later while the retry got 429.
  - Attempts on one task therefore run one after another, whether they come from the retry tick, the onboarding webhook, a capture or an operator release, and on any number of server instances.
  - The lease uses the database clock, not the caller's `p_now`. A caller with a clock 15 minutes ahead would otherwise treat a live lease as expired. The verifier race file's late-clock instance caught exactly this.
- Lookup before create: `payoutWorker` lists transfers with `transfer_group=task_<id>`, `limit=1`, after the capability check. If one exists it returns that transfer id and sends no POST. Because attempts never overlap, an attempt that created a transfer but died before recording it has finished by the time the next attempt looks.
- Key scheme:
  - A retry after a refusal is a new attempt with a new key, so Stripe runs it fresh.
  - A network retry inside one attempt reuses the key. `createStripePayments` builds the client with `{ timeout: 80_000, maxNetworkRetries: 2 }`, and stripe-node resends the same `Idempotency-Key` header on those retries (`RequestSender` keeps the headers).
  - Two attempts can only get the same key if they start in the same microsecond. Then Stripe replays the earlier result for the same task and amount, which can waste an attempt but cannot pay twice.
- Rotating batch: `eyes_payouts_due(account, limit, after)` orders by `(created_at, id)` and starts after the task id `after`. `retryPayouts` keeps that cursor in memory: it moves to the last task of a full batch and goes back to the start after a short one. With N due tasks, every due task is tried at least once every ceil(N / 25) runs. `markWorkerOnboarded` passes no cursor and no limit.
- Capture page: a worker who texted STOP and has no payout account is not texted the setup link, so the page shows `connectUrl(worker.id)` itself.
- 009 adds and replaces functions only (no tables, columns or constraints). The 2-argument `eyes_payouts_due` is dropped. EXECUTE on all three functions is revoked from public, anon and authenticated.

### Alternatives rejected
- Holding a row lock or advisory lock across the Stripe calls: on InsForge every RPC is its own transaction.
- Minting a new key only after Stripe replays a saved error (`Idempotent-Replayed: true`): this needs no lease, but the payments adapter would have to report that header to the engine (a `Payments` contract change), and every refusal would cost an extra POST.
- Skipping accounts known to be inactive for a backoff window: there is no column that records an inactive account or the last failed attempt. A per-instance skip list still starves once more tasks are stuck than fit in the window.
- Ordering the rotation by task id alone: it works, but it drops the oldest-first order, so the first batch after a restart would be arbitrary instead of the longest-waiting tasks.
- A new `payout_attempts` table or `last_attempt_at` column: no schema changes in this task.

### Consequences
- The lease is a safety bound, not only a liveness bound. It assumes the Stripe part of an attempt ends within 15 minutes. The client is built with an 80 s timeout and 2 retries, and the retry backoff is at most 0.5 s, then 1 s, so each call takes at most 3 × 80 s + 1.5 s = 241.5 s. The GET account, GET list and POST transfer together take at most 12.1 minutes. Only a process stalled for longer than that (for example, a suspended VM) could outlive the lease. That is the verifier's synthetic S6, which ages the lease by hand.
- A process that dies holding the lease delays that task's payout by up to 15 minutes. A transfer POST with an unknown outcome delays it by 15 minutes on purpose.
- Remaining double-pay windows:
  - Stripe runs a POST more than 15 minutes after the client gave up on it.
  - Stripe incident recovery creates a transfer more than 15 minutes after a 500.
  - In both cases `ledger_once_per_task` still allows one payout row, so the extra transfer shows in the Stripe dashboard to reconcile. The Stripe docs say list endpoints are read-after-write consistent (search is not), which the lookup relies on.
- A successful lookup can return a transfer an operator has since reversed in Stripe. The task is then recorded as paid.
- `release.stripe_ref` is non-null only while an attempt runs, or for up to 15 minutes after a POST with an unknown outcome. Nothing else reads it.
- Accounts that never finish onboarding are still checked (one GET each) every time the cursor passes them. With 25 or fewer such tasks that is every 30 s run. A per-instance backoff is a possible follow-up; it was left out to keep this change small.
- Every payout attempt costs one more Stripe GET (the list).
