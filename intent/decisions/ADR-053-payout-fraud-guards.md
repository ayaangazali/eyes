# ADR-053: Payout fraud guards

Status: accepted. Builds on ADR-015 (an agent may own itself) and ADR-026 (disputes).

## Decision

- A new worker Stripe account is created with a daily payout schedule and `delay_days` 7, so Stripe pays the bank 7 days after each transfer.
- `Payments.setPayoutsPaused` sets the schedule to `manual` (paused) or back to the delayed daily schedule.
- `eyes_worker_payouts_held` is true when the worker is banned, on dispute hold, or has an open dispute ticket.
  The engine calls it after a dispute is opened, after ops rejects or confirms a dispute, and after ops lifts a dispute hold, then syncs the Stripe schedule. A Stripe failure is logged and does not fail the call.
- `agents.owner_email` stores the owner email given at signup (lower case).
  An answer from a worker with the same email is not auto-approved: it goes to `needs_review`. Owners have no phone field, so only email can match.
- Radar: top-ups use Stripe Checkout, which Radar scores by default. No code change.

## Rejected

- Pausing only on a ban: money already transferred would still reach the bank during review.
- Blocking the owner-as-worker answer: ops can still approve a real case.

## Consequences

Migration 052 adds one column and three functions. Existing agents have no owner email, so they are not matched. Workers created before this change keep their old schedule.
