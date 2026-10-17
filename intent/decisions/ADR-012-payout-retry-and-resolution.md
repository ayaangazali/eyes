# ADR-012: Payout retry and operator resolution

Status: accepted (2026-10-17, orchestrator). Adds to the frozen contract: `EyesService.retryPayouts` and `EyesService.resolveTask`.

## Context
- A failed transfer to an onboarded worker texts "it will be retried", but the only retry was `markWorkerOnboarded`, which runs when Stripe sends a new `account.updated`. A verified task could stay unpaid forever. The Stripe note says Stripe does not retry failed transfers itself, so our payout job must (docs/vendor/stripe.md).
- `needs_review` and `disputed` hold the agent's escrow, and nothing could move it: no refund to the agent, no release to the worker. The MCP instructions already promise that "a human review pays the worker or refunds you".

## Decision
- `retryPayouts(): Promise<{ paid }>` pays up to 25 `verified` tasks whose worker has a `stripe_account_id`, oldest first (`eyes_payouts_due`). It reuses `payOut`, so the Stripe idempotency key stays `payout:<task_id>`, the payout ledger row is unique per task, and only the call whose `eyes_record_payout` moves the task from `verified` to `paid` sends the paid text. It runs on the same interval as `expireOverdue`. It holds no lock across the Stripe call; a concurrent webhook payout sends the same key and records nothing twice.
- `resolveTask(task_id, "refund" | "release", note)` is operator-only: it is called from `scripts/resolve-task.ts` and is never an MCP tool or REST route. `eyes_resolve_task` locks the task row and accepts only `needs_review` or `disputed`.
  - refund: allowed only while the escrow is still held (no `release` row). Inserts a `refund` row for bounty plus fee, credits the agent, status `refunded`.
  - release: inserts `release` and `fee` rows if they are missing, then status `verified` (or `paid` when a `payout` row already exists, so a worker paid before the dispute is not paid twice). The engine then runs the normal settle path: transfer, payout row and paid text, or the payout setup link when the worker has no Stripe account (then `retryPayouts` or onboarding pays later).
  - The note is appended to `tasks.dispute_reason` as `resolved <decision>: <note>`.
  - Any other status, or a refund after the bounty was released, raises `invalid_input` with the reason in `issues` and the current `status`; an unknown task raises `task_not_found`.
- A second resolve of the same task fails on the status check under the row lock. Behind that, `ledger_once_per_task` rejects a second `refund` or a second `release`.
- `007_resolve.sql` adds the two functions with EXECUTE revoked from public, anon and authenticated, and no tables or columns.

## Alternatives rejected
- A fresh Stripe idempotency key per retry: a transfer that reached Stripe but was not recorded would be paid twice. Avoiding that needs the payments adapter to look up transfers by `transfer_group` before creating one.
- Refunding a disputed task after its bounty was released: the ledger has no type that reverses a `release` or `fee`, so the escrow total would go negative, and a refund could land while a transfer for the same task is in flight. Refund is therefore only possible while the escrow is held, so an agent refund and a worker payout can never both happen for one task.
- A new `resolution_note` column or an audit table: the task card allows no schema change, and `dispute_reason` already holds operator-facing text that no agent tool returns.
- An MCP or REST route for resolution: an agent could then settle its own disputes.

## Consequences
- Stripe stores a failed transfer's error under its idempotency key and replays it for at least 24 hours (https://docs.stripe.com/api/idempotent_requests). A transfer that Stripe executed and rejected, such as one blocked by an insufficient platform balance, keeps failing on retry until Stripe prunes the key. Errors where Stripe never started the request (network, rate limit, a concurrent request with the same key) succeed on the next retry.
- Oldest first with a batch of 25: if 25 or more tasks are stuck on accounts that never finish onboarding, newer payouts wait behind them.
- A dispute filed after automatic verification can only end in release; reversing an automatic approval needs a reversal ledger type.
- `apps/mcp/src/main.ts` must call `service.retryPayouts()` inside its expiry interval.
