# ADR-023: Ops dashboard behind an operator allowlist, a persisted event log, and worker support tickets

Status: proposed (2026-10-17, T6.4). Adds to the frozen contract: `EyesService.resolveTicket` in `packages/core/src/service.ts`, and migration `015_events_and_tickets.sql` (tables `events`, `tickets`, `ops_allowlist`, `ops_codes` and their functions).

## Context
The ops dashboard was a secret URL (`/ops/<EYES_OPS_KEY>`): anyone holding the link could see worker positions, and there was no record of who looked. Operators had no history of what the server did beyond the process log on one machine, and a worker whose answer was held in `needs_review` had no way to ask for a review except waiting.

## Decision
- `/ops` requires a session cookie (`__Host-eyes_ops`, HttpOnly, Secure, SameSite=Strict, 12 h, HMAC with `EYES_LINK_SECRET`) that only an allowlisted phone or email can get, with a 6-digit code (hashed at rest, 10 min, 5 attempts, rate limited per identifier and per client IP). POST actions also check `Origin` against `EYES_PUBLIC_API_URL`. `EYES_OPS_KEY` stays as an optional break-glass link that signs the browser in.
- Every request, MCP/REST service call, task status change, ledger row, outbound text/email, webhook, safety and vision verdict, payout attempt, login attempt, allowlist change and console warning/error becomes a redacted row in `events`. Task, ledger and ticket rows are written by triggers so no code path can skip them; the rest are batched by the server every 2 s, with an in-memory ring of the last 500 as the fallback when the database is unreachable. Redaction is regex-based (keys, tokens, phones, emails, URL credentials).
- A worker texting HELP within 48 h of an answer held in `needs_review` opens a `manual_review` ticket (one open per task); later free text from that worker is appended. `resolveTicket` closes it and texts the worker. Money still moves only through `resolveTask`, the same call `scripts/resolve-task.ts` makes: the ops route calls `resolveTask` first for Release/Refund, then `resolveTicket`.

## Consequences
- `events` grows without pruning (marked `ponytail:` in the migration).
- Tickets keep the worker's message text and the operator's note with no end date, like other task records; the privacy pages say so.
