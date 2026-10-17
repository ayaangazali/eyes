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
