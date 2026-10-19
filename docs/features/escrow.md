# Escrow in integer cents

When an agent calls `ask_eyes`, the bounty (default $3.00) plus a $0.50 fee is taken from its balance and held in escrow. The worker is paid the bounty only after a verified answer. If nobody answers before the deadline, or the agent cancels before a worker claims the task, the full amount is refunded. All money is stored and computed as integer cents, so amounts never drift.

The deployed payment flow uses Stripe TEST mode. New keys receive $20 in test credits; balances, charges and payouts here are not real cash. Live MCP and messaging providers do not mean live-money payments.

## How it works

- Every amount is a Postgres `bigint` in cents (`*_cents`). USD only appears in tool input and output (`*_usd`).
- `eyes_post_task` writes an `escrow` ledger row for bounty + fee. `agents.balance_cents >= 0` is a check constraint, so overspending fails in the database.
- `eyes_submit` (auto-approve) or `eyes_resolve_task` (review) writes `release` (bounty to worker) and `fee` rows.
- `eyes_cancel_task` and `eyes_expire_overdue` write a `refund` row for bounty + fee.
- The unique index `ledger_once_per_task (task_id, type)` blocks a second escrow, release, refund, payout or fee for the same task, even if code retries.
- The Stripe Connect payout path uses a transfer in group `task_<id>` and reuses an earlier transfer to avoid double payment. The current deployment uses test payments, not real payouts. **Looks good** (`accept_answer`) records feedback only; it does not release or pay the bounty again.

## How to try it

```
get_balance({})
ask_eyes({ ... })                # balance drops by bounty + 0.50
cancel_task({ "task_id": "<id>" })
get_balance({})                  # refund is back
```

## Where in the code

- [`intent/decisions/ADR-001-integer-cents.md`](../../intent/decisions/ADR-001-integer-cents.md): the integer-cents decision
- [`packages/db/migrations/001_init.sql`](../../packages/db/migrations/001_init.sql): ledger table, balance check, uniqueness indexes
- [`packages/db/migrations/002_engine.sql`](../../packages/db/migrations/002_engine.sql): escrow, release, refund and payout functions
- [`packages/db/migrations/007_resolve.sql`](../../packages/db/migrations/007_resolve.sql): release or refund after review
- [`packages/payments/src/index.ts`](../../packages/payments/src/index.ts): Stripe Connect payouts
- [`apps/mcp/src/server.ts`](../../apps/mcp/src/server.ts): `ask_eyes`, `cancel_task`, `get_balance` tools
