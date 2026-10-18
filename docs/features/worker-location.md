# Worker location

A worker's spot used to be wherever they joined, forever. Now it stays current: a HERE link, an iOS Shortcut, the iPhone app and every submitted photo each update it. Eyes only offers tasks to workers whose location is fresh, so offers go to people who are actually nearby.

## How it works

- Each worker has one stored fix (lat, lng, time, accuracy, source). New fixes overwrite it; no history is kept.
- Dispatch and re-offer skip workers whose fix is older than `EYES_LOCATION_MAX_AGE_H` (default 24 hours).
- Texting HERE, LOCATION or I'M HERE returns a 30-minute HERE link. SHORTCUT returns a personal code and the Shortcut install link.
- The iPhone app (`apps/mobile`, Expo) sends the phone's location in the background, about every 5 minutes or 300 m, to `POST /w/location`.
- Limits per worker: at most one fix every 30 s and 1500 per day. STOP deletes the fix and revokes the code.
- iMessage "Share My Location" can't reach Eyes (it arrives as a blank character), so Eyes replies with a HERE link.

## How to try it

Text the Eyes number:

```
HERE
```

Open the link you get back, and allow location access.

## Where in the code

- [`intent/decisions/ADR-024-worker-location.md`](../../intent/decisions/ADR-024-worker-location.md): the decision and limits
- [`apps/mobile/src/background.ts`](../../apps/mobile/src/background.ts): background location in the iPhone app
- [`apps/mcp/src/http.ts`](../../apps/mcp/src/http.ts): the `/w/location` and `/v1/worker/location` routes
- [`packages/core/src/service.ts`](../../packages/core/src/service.ts): `updateWorkerLocation`
- [`docs/research/worker-location.md`](../research/worker-location.md): why iMessage locations don't arrive
