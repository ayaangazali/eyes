# ADR-037: Worker location stays current through HERE links, the Shortcut and captures

Status: proposed (2026-10-17, T6.6). Adds to the frozen contract: `EyesService.updateWorkerLocation` and `WorkerLocationInput` in `packages/core`, the reply intents `here`, `shortcut` and `location_share` in `REPLY_INTENTS`, `AppConfig.location_max_age_h`, `location_ping`, `shortcut_url`, `location_min_interval_s` and `location_daily_max`, and migration `017_worker_location.sql` (workers location columns, `worker_pings`, new `eyes_nearby_workers` and `eyes_reoffer` signatures, and the location, token and ping functions).

Migration `017_worker_location.sql` still names this record as ADR-024. Applied migrations are append-only, so that historical reference remains unchanged.

## Context
A worker's location was the point they gave when they joined, forever. Someone who joined at home and works downtown got offers for home and none for downtown, and a worker who moved away kept getting offers they could not take. Inkbox delivers an iMessage "Share My Location" as the single character U+FFFD with no media, so the coordinates never reach us (docs/research/worker-location.md).

## Decision
- One fix per worker (`lat`, `lng`, `location_at`, `location_accuracy_m`, `location_source`), overwritten in place; no history. Dispatch and re-offer skip workers whose fix is older than `EYES_LOCATION_MAX_AGE_H` (default 24); rows from before 017 count their join time as the fix time.
- `POST /w/location` (alias `/v1/worker/location`, which the Shortcut has baked in) takes `Authorization: Bearer` with either a 30-minute signed HERE token (`l:<worker>`) or a long-lived per-worker token (32 random bytes, stored as sha256, rotated on every SHORTCUT text). Limits per worker (`EYES_LOCATION_MIN_INTERVAL_S`, default one fix per 30 s; `EYES_LOCATION_DAILY_MAX`, default 1500 per rolling day, so a shift Shortcut can send one a minute all day) are checked in the same SQL UPDATE that stores the fix. A stored fix counts as fresh for dispatch at once.
- Texts: HERE / LOCATION / I'M HERE get a HERE link; an iMessage that is exactly U+FFFD, or empty with no media, gets "iMessage locations don't reach us" plus the link; START after a stale fix includes the link; SHORTCUT gets the worker's code and the install link. A submitted capture also updates the fix.
- STOP deletes the fix (lat/lng become nullable) and revokes the token.
- Ping flow behind `EYES_LOCATION_PING` (off by default): when fewer than `dispatch_max_workers` are fresh nearby, text up to 5 nearest stale ones `Eyes ping <nonce>` (not pinged in the last hour), then offer the task to newly fresh workers 30 s later.

## Consequences
- The 30 s re-offer is an in-process timer: a restart in that window loses it (`ponytail:` note in the engine).
- Every ping spends one of Inkbox's 100 iMessages a day per line; 5 per dispatch and once an hour per worker cap it.
- Coordinates are never logged; the event log records the call and its source only.
