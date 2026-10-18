# Ops dashboard

`/ops` is the operator console for Eyes. It shows tasks, money, the review queue, worker support tickets, a persisted event log and a live map of workers. Only people on the operator allowlist can sign in, with a one-time code sent to their phone or email.

## How it works
- Sign-in at `/ops/login`: an allowlisted phone or email gets a 6-digit code (hashed at rest, valid 10 minutes, 5 attempts, rate limited per identifier and per IP).
- A correct code sets a 12-hour `__Host-eyes_ops` session cookie (HttpOnly, Secure, SameSite=Strict); POST actions also check same-origin.
- Operators manage the allowlist at `/ops/allowlist`; entries are shown masked (last 4 digits of a phone, `***@domain` for email).
- The dashboard shows health, tasks and money for the last 24 h, trends, a "Needs a decision" queue, support tickets, recent tasks, ledger, server warnings, the event log and a worker map (positions rounded) at `/ops/live`.
- Requests, task changes, ledger rows, messages, webhooks, verdicts, payouts and logins are written as redacted rows to an `events` table.
- A worker texting HELP within 48 h of an answer held for review opens a `manual_review` ticket; operators resolve it from the dashboard, and money still moves only through `resolveTask`.

## How to try it
Open https://api.eyes.pictures/ops/login and enter an allowlisted phone or email. Without a spot on the allowlist you get the same "code is on its way" message and no access.

## Where in the code
- [`apps/mcp/src/ops-auth.ts`](../../apps/mcp/src/ops-auth.ts): login codes, session cookie, allowlist
- [`apps/mcp/src/server.ts`](../../apps/mcp/src/server.ts): `/ops/feed`, `/ops/events`, `/ops/tickets`, task resolve routes
- [`apps/web/dashboard/src/ops.html`](../../apps/web/dashboard/src/ops.html): dashboard page
- [`apps/web/dashboard/src/ops-view/`](../../apps/web/dashboard/src/ops-view/): the page's script (`format.ts` helpers, `page.ts` rendering and actions), inlined into the page by `server.ts`
- [`apps/web/dashboard/src/ops.ts`](../../apps/web/dashboard/src/ops.ts): dashboard data shaping
- [`intent/decisions/ADR-023-ops-access-events-tickets.md`](../../intent/decisions/ADR-023-ops-access-events-tickets.md): the decision record
