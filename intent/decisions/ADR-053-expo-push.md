# ADR-053: Expo push notifications

Status: accepted. Builds on ADR-028 (worker code), ADR-050 (dispute routes) and ADR-052 (owner link versions).

## Decision

- `POST /w/me/push {token}` (worker bearer code) and `POST /owner/:token/push {token}` store an Expo push token in `push_tokens`. A token has one owner, a worker or an agent, and moves to the newest one. 10 calls an hour per code.
- `packages/engine/src/push.ts` posts to `https://exp.host/--/api/v2/push/send`, no key. It runs after the text or API step and never fails it: errors are logged by name only.
- Pushes: a new nearby offer (worker), an owner dispute (worker), a decided review (worker and owner), a spend limit with `at_limit: ask` (owner). Texts do not change.
- A token that Expo answers with `DeviceNotRegistered` is deleted. Account deletion deletes the worker's tokens.

## Rejected

- Replacing texts with push: workers without the app would get no offers.
- A queue for later receipts: the send response already carries `DeviceNotRegistered`, and a miss costs one wasted call.

## Consequences

Migration 052 adds one table and four functions. Texts-off (STOP) does not stop push; the app owns that setting.
