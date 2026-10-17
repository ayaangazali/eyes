# ADR-020: Workers get a private earnings link

Status: accepted (2026-10-17, contract change pre-approved by the orchestrator for T4.17). Adds to the frozen contract: the `WorkerEarnings` schema, route `worker_earnings: "GET /w/earnings/:token"`, `EyesService.workerEarnings(token)`, and a required `earnings_url` on the `Messaging.sendPaid` message.

## Context
Issue #33: a worker gets one "paid" text per task and nothing else. A worker chasing a missing payout has nowhere to see which tasks were paid, which are still owed, or why one is stuck (most often: payouts were never set up).

## Decision
- New HMAC link token `e:<worker_id>` in the ADR-009 shape, expiring 7 days after it is issued (the same lifetime as the `c:` payout setup link).
  - Why it expires: the page lists the places a worker went and when, which is a private person's location history. Texts get forwarded and phones get shared, and there is no per-link revocation (ADR-011). Unlike the `p:` owner link, which only the operator can reissue, a fresh `e:` link is one text away: every paid text and every HELP reply mints a new one, so the expiry costs the worker nothing.
  - The engine accepts only `e:` payloads for this method; `t:`, `o:`, `c:` and `p:` tokens for the same id are refused. Agent email MACs (`agentEmailAddress`) sign the raw string `e:<agent_id>` and expose 16 characters of it, while link tokens sign a base64url JSON body, so neither can stand in for the other.
- Delivery: the paid text ends with `Your earnings: <url>`, and the HELP reply ends with the same after its `More:` link. Both are replies to a worker who has already texted START, YES or HELP, so the cold iMessage rule (159 characters, no links) does not apply; the limit is 1600 characters per text (docs/vendor/inkbox.md). Task offers stay link-free.
- Read: `GET /w/earnings/:token` is rendered on the server in packages/payments, next to the owner console and the payout setup redirect. It reuses the same page shell and header, escapes every field through `hono/html`, and sends `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and the owner console's CSP.
- The page is read-only and never shows the payout setup link. Whoever opens a connect link attaches the Stripe account that receives the payouts, so a forwarded earnings link must not hand that out. Rows waiting for payout setup tell the worker to use the link we texted, or text START for a new one.
- Money comes from the ledger in integer cents and becomes USD only in the engine output (ADR-001):
  - Paid: the sum of the worker's `payout` rows.
  - Pending: the sum of the worker's `release` rows whose task has no `payout` row. This includes a task disputed after release, whose payout is held until review (007 allows only release once a bounty is released).
  - Per task: `paid` (a payout row exists), `pending` (released, and the worker has a Stripe account, so `retryPayouts` keeps trying), `waiting_for_payout_setup` (released, no account yet), or null (nothing released: claimed, submitted, needs_review, expired, refunded).
- The list is the worker's 50 most recently claimed tasks (`tasks.claimed_by`). Offers the worker did not claim never appear. Totals cover all tasks, not only those 50.
- `012_worker_earnings.sql` adds one function, `eyes_worker_earnings(uuid)`, with every subquery scoped to that worker id and EXECUTE revoked from public, anon and authenticated, like 002 to 010. No tables, columns or indexes.
- An invalid, expired or wrong-kind token is `offer_invalid` (404) with the message "This earnings link is invalid or has expired." and the fix "Text HELP to the Eyes number for a fresh link." No new error code.
- The route key starts with `worker_`, so cli/src/docs.ts already keeps it out of the agent docs, and the request log records `/w/earnings/<token>`, never the token.

## Alternatives rejected
- No expiry, like `p:`: a forwarded text would expose a person's movements until the link secret rotates.
- A worker-web page that fetches JSON: a second origin sees the token, and it adds a JSON route and a page for what one server-rendered response does.
- Composing the paid text in the engine through `sendText`: it would drop the Inkbox idempotency key `paid:<task>:<phone>` and leave `sendPaid` unused. The template stays in packages/comms and takes the URL as input.
- Reusing the `c:` token: it also opens payout setup, which the page must not do.

## Consequences
A forwarded earnings link shows that worker's places, task statuses and amounts for up to 7 days. A worker who texted STOP gets no HELP reply, so they need START before they can get a fresh link. The ADR-009 one-canonical-string rule holds for `e:` tokens as for the others.
