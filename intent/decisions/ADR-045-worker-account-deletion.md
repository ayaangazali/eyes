# ADR-045: Workers delete their own account

Status: accepted

## Decision

`DELETE /w/me` takes the worker's `e:` code, as `GET /w/me` does, and returns `{ "deleted": true }`.
The engine first pays every verified task that is due to the worker's Stripe account.
Then `eyes_delete_worker` locks the worker row, the same lock that `eyes_claim` takes.
It refuses with `invalid_input` and the `task_id` while a task is claimed, submitted, held for review or disputed.

The worker row stays as a tombstone, because tasks, answers, tickets and later payouts reference it.
The function does the STOP steps first: it opts the worker out and deletes the location fix, location codes, devices and login codes.
Then it deletes connect codes and short links, and it clears the name, number, email and location counters.
The phone becomes `deleted:<id>`, so the number can join again as a new account.
A banned worker keeps the phone, so the ban still blocks the number.
Ledger rows keep their amounts and lose `worker_id`.
`workers.deleted_at` marks the tombstone, and every `e:` code of a tombstone is refused.

## Consequences

Money that is not paid at deletion stays owed on the tombstone.
A worker without payout setup can still use an earlier payout setup link, and `retryPayouts` pays an account that has Stripe.
A later payout ledger row references the tombstone again, which holds no personal data.
Submitted photos, answers and capture positions stay with the agents' tasks.
Review ticket text stays with the ticket.
Deletion cannot be undone.
