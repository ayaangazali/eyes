# ADR-026: Disputes: confirm fraud (refund, reverse, ban) or reject

Status: accepted (2026-10-17, operator). Follows ADR-025: the photo check no longer judges answers, so a wrong or fake answer reaches a person through `dispute_answer`.

## Context
`dispute_answer` set the task to `disputed` and held an unpaid payout, but nothing told ops, a payout already sent stayed with the worker, and a worker who faked answers could keep taking tasks.

## Decision
- `dispute_answer` (MCP tool / REST, also the owner console) opens a support ticket of kind `dispute` with the agent's reason. One open ticket per (task, kind): a second dispute appends to the reason; HELP tickets (`manual_review`) never touch it.
- `POST /ops/tickets/:id/confirm_fraud` `{ note }` (ops session + same Origin): `eyes_confirm_fraud` locks the ticket row, so a second click returns `already_resolved: true` and moves no money. Once: the agent gets bounty + fee back (ledger `fraud_refund` when the bounty was already released, else `refund`, so escrow never goes negative), the task becomes `refunded`, the worker is banned (`banned`, opted out, location and location codes deleted). Then the API reverses the worker's Stripe transfer with idempotency key `reverse-<task_id>`; when Stripe refuses (usually `balance_insufficient`) the payout amount is recorded as `reversal_owed_cents` on the ticket.
- `POST /ops/tickets/:id/reject_dispute` `{ note }`: the ticket closes as `rejected` once and the task is released to the worker through the existing `resolveTask` path (paid tasks stay paid).
- A banned worker gets no offers; START replies "This number can't take Eyes tasks." and `eyes_set_worker_opt_in` refuses to opt a banned phone back in.
- `get_task` returns `dispute: { status: open | upheld | rejected, refunded_usd }` (null without a dispute).

## Alternatives rejected
- Reversing the transfer inside the SQL function: Stripe is an HTTP call; the money moves in the DB once, the reversal is idempotent by key, and a failure is recorded instead of rolling back the refund.
- Banning by deleting the worker row: loses the ledger and payout history; the phone could sign up again.
- Clawing back from the worker's next payouts: no next payouts for a banned worker; owed amounts are visible on the ticket for manual collection.

## Consequences
The agent is always made whole on confirmed fraud, even when the reversal fails (Eyes absorbs `reversal_owed_cents`). Ceiling: a banned person can rejoin with a different phone number.
