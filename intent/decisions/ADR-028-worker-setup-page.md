# ADR-028: The worker setup page reads its state with the earnings token

Status: accepted (2026-10-17). Changes the frozen contract in `packages/core`: adds `EyesService.workerSetup` and `EyesService.workerInstallLink`, the `WorkerSetup` schema, and `HTTP_ROUTES.worker_me` and `HTTP_ROUTES.worker_me_install`.

## Current implementation (2026-10-18)

This accepted decision and its original contract remain historical. [PR #164](https://github.com/ayaangazali/eyes/pull/164) and [T6.62 on main](https://github.com/ayaangazali/eyes/blob/main/intent/T6.62-worker-setup-state.md) supersede the latest-GPS/no-migration setup model: migration 038 persists `app_connected` and `email_skipped`; `WorkerSetup.app.connected` governs app completion independently of the latest GPS source or freshness. Skipping optional email records acknowledgement, not email delivery or verification.

## Context
A worker's setup is scattered across texts. START sends the payout setup link and the app link, a stale spot gets a HERE link, INSTALL and APP resend the app, and HELP sends the earnings link. No one place tells a worker whether they are opted in, whether their spot is fresh, whether the app is sending fixes, whether payouts are set up, and what happened to their recent tasks.

## Decision
- `GET /w/me` returns `WorkerSetup`: `opted_in`; the spot's time and freshness against `location_max_age_h` (a fix, or the sign-up location until the first fix, the same rule as START); `app.last_at` (the current fix's time when its `location_source` is `app`, else null) and `app.sending` (that fix is fresh); payout setup, with the connect link only while payouts are live and not set up; the HERE and earnings links; and the 5 newest claimed tasks with the earnings page's payout labels.
- The page's code is the existing `e:<worker_id>` token (ADR-020, 7-day expiry). The page link is `<worker_web_url>/me#c=<code>`. The page reads the code from the fragment and sends it only as `Authorization: Bearer <code>`. The API never reads a code from the URL. A missing, invalid, expired or wrong-kind code, or an unknown worker, gets 401 `unauthorized` with "This link is invalid or has expired." and "Text HELP to the Eyes number for a fresh link."
- `POST /w/me/install` mints a location code (the same as START and APP) and returns `{ install_url }`: `<worker_web_url>/install#c=<code>`, or `<worker_web_url>/app#c=<code>` when `EYES_TESTFLIGHT_URL` is set. An opted-out worker gets the same 401, because location codes work only for opted-in workers.
- HELP ends with `Your setup: <url>` in place of the earnings link. START appends ` Your setup: <url>` to the existing welcome. The paid text keeps its earnings link.
- Both routes send `Cache-Control: no-store` and use the existing `/w/*` CORS rule, which allows only the worker web origin.
- No migration: `eyes_worker` gives the opt-in, spot and `location_source`; `eyes_worker_earnings` gives the payout setup and the claims, newest first.

## Alternatives rejected
- Code in the query string (`/w/me?c=<code>`): CDNs, proxies and request logs record query strings, and the code opens the worker's spot and recent tasks for 7 days.
- Mint the install code on GET: every page view would add a code. A worker keeps at most 5 codes, so a few views would rotate out the code that a working device uses.

## Consequences
A forwarded /me link shows the worker's spot time, payout state and recent tasks for up to 7 days, the same exposure as the earnings link (ADR-020). The setup page and the earnings page share one payout label rule in the engine. Ceiling: each GET makes two RPC calls, and the earnings query reads up to 50 claims to show 5.
