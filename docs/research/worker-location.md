# Worker location from iPhone (research, 2026-10-17)

## 1. What Inkbox / Sendblue do today

- **Inkbox drops Apple location shares.** Fetched again at 21:5x UTC: messages `133fee94…` (one-time pin) and `2138619b…` (live share) still have `content: "\ufffd"`, `media: null`, `messageType: "message"`, and `updatedAt == createdAt`. Nothing arrived later. The thread holds only that one message. The Inkbox docs (imessage, messages, webhooks, changelog) never mention location.
- **Sendblue does decode them.** Its inbound webhook has `message_type: "location"` plus `location {latitude, longitude, accuracy, altitude, timestamp, duration}`. Sendblue also has `POST /api/request-location` (sends a native Find My request card), `GET /api/location/{number}`, and an SSE `…/watch` for live shares. Limit: **only on dedicated Sendblue lines** with iMessage. Source: https://docs.sendblue.com/api-v2/location-sharing
- So the coordinates do exist one hop upstream. Inkbox does not map that field. We cannot reach Sendblue directly, because it is Inkbox's account.
- **Inkbox support (A2A task `87116558-6ca8-442a-acc1-6bba421bfdc5`, 2026-10-17, completed): not supported.** Its reply, summarized:
  - `message_type` is only `"message"` or `"carousel"`. There is no location field, and no request-location, read, or watch endpoint, dedicated lines included.
  - It confirmed both IDs were received but cannot see message bodies.
  - It **escalated the content loss to the Inkbox team** (investigation only, no ETA, no commitment).
  - Its advice for now: ask workers to send a Maps link or coordinates as text, and do not treat U+FFFD as a location signal.
  - The temporary agent-scoped key `eyes-a2a-support` (`<revoked key, redacted>`) was used only for this call and then revoked.

## 2. Recommended workaround: iOS Shortcut "Eyes: I'm here" + Message automation

Why: Shortcuts can read GPS and POST it without opening a web page. Apple's list of automations that "can be run automatically" (Ask Before Running off) includes **Time of Day, Arrive, Leave, Wi-Fi, Message, Charger, App**. The only exception is "Before I Commute". Source: https://support.apple.com/guide/shortcuts/apd602971e63/ios

The key trigger is **Message**. When Eyes texts a ping, the worker's phone reports its location by itself with no tap. The worker sets this up once.

### Shortcut actions (built by `worker-location-shortcut-gen.py`)
1. Text: `<worker code>`. This is an import question: "Paste the Eyes code from your text message".
2. Get Current Location
3. Get Contents of URL: `POST https://api.eyes.pictures/v1/worker/location`. Header `Authorization: Bearer <Text>`. JSON body `{lat: Current Location.Latitude, lng: Current Location.Longitude, source: "shortcut", input: Shortcut Input}`
4. Show Notification "Location sent"

Files:
- `eyes-im-here.shortcut` is signed with `shortcuts sign --mode anyone`. The output is an AEA1 archive, which iOS accepts. Unsigned files are rejected on iOS 15+. Signing needs macOS plus iCloud sign-in. It took about 2 s, and one attempt failed with a transient `NSURLErrorDomain 500`, so retry on failure.
- The URL is fixed to `https://api.eyes.pictures/v1/worker/location`. ops-dashboard-2 serves `POST /w/location` as the canonical route and keeps `/v1/worker/location` as an alias with identical behavior. Installed shortcuts cannot be updated, so that alias must stay. To switch to the canonical route: `python3 worker-location-shortcut-gen.py out.shortcut https://api.eyes.pictures/w/location && shortcuts sign --mode anyone -i out.shortcut -o eyes-im-here.shortcut`.
- **Not yet tested on an iPhone.** The plist was hand-built from the known WF* schema.

### Distribution (pick one)
- **A. One shared install link (simplest).** Open the signed file on a Mac or iPhone, then Share → Copy iCloud Link. A human has to do this once; there is no API for it. Eyes texts the worker their code first and then the iCloud link. The import question asks for the code when the worker adds the shortcut.
- **B. One file per worker, code baked in.** At signup, the server runs `gen.py out URL TOKEN` and `shortcuts sign --mode anyone`, then sends a link to the file. This needs a macOS signer host. Downloading a file in Safari takes more taps than an iCloud link.

### What the worker does (about 2 minutes, once)
1. Tap the install link → **Add Shortcut** → paste the Eyes code.
2. Run "Eyes: I'm here" once by hand. Choose **Allow** for location, and **Always Allow** when it asks to connect to the Eyes domain. If this step is skipped, the automation will wait on those prompts later [INFERENCE: standard Shortcuts privacy prompts].
3. Shortcuts → Automation → **+** → **Message** → Sender: the Eyes number, Message Contains: `Eyes ping` → **Run Immediately** → choose "Eyes: I'm here".
4. Optional: add **Time of Day** automations, for example 9:00, 12:00, 15:00 and 18:00, each set to Run Immediately. Time of Day repeats daily/weekly/monthly, not hourly, so you need one automation per time slot.

### Dispatch flow
- When a task is created, take workers whose last fix is fresh (under about 2 h) and within 3 km, as now.
- If too few qualify, send `Eyes ping <nonce>` to workers whose fix is stale, wait about 30 s for POSTs, then re-rank.
- **Budget:** Inkbox allows at most 100 iMessages per identity per rolling 24 h. Each ping uses one, so ping only a small set of candidates (for example the last-known nearest 5). Do not broadcast.

### Current method: automations (T6.15)

The loop shortcut below is retired. Workers text AUTO (or SHORTCUT) for a code and follow `automation.html` on the worker web: iOS 26 Personal Automations with Run Immediately, built inline (Get Current Location, then Get Contents of URL): Time of Day 9:00 daily, Message from Eyes containing "Eyes ping" (body adds `input` = Shortcut Input), optional Charger disconnected. Time of Day repeats at most daily on iOS and macOS 26; the 24 h freshness window makes that enough, and pings (`EYES_LOCATION_PING=true`) cover the rest. The Mac uses the same automations in macOS 26 Shortcuts (Time of Day 9, 12, 15, 18, 21; Message "Eyes ping"; Wi-Fi join). An iOS app may post with source `app` (migration 020).

### Eyes: on shift (loop shortcut). Status: verified on macOS (local logger), not yet run on iPhone

Files: `eyes-on-shift.shortcut` (signed, prod URL `https://api.eyes.pictures/w/location`), generator `worker-location-on-shift-gen.py` (unsigned plist, then `shortcuts sign --mode anyone`; retry on transient errors). `eyes-im-here.shortcut` stays as the one-shot version. The library name comes from the file name on import, so rename the file to `Eyes: on shift.shortcut` before sharing it.

Flow, 9 actions, no menu and no variables:
1. Text: import question "Paste the Eyes code from your text message" (token)
2. Repeat 240 times (4 h):
3.   Get Current Location (default accuracy; the action has no accuracy setting)
4.   Current Date → Format Date, ISO 8601
5.   Get Contents of URL: POST, `Authorization: Bearer <token>`, body `{lat, lng, source:"shortcut", captured_at}`
6.   Wait 60 seconds
7. Show Notification "Eyes shift ended"

The worker stops the run early from the Shortcuts banner when the shift ends. Server limits (1 fix per 30 s, 1500/day) fit a 60 s loop for the full 4 h.

Known gaps:
- **No 401 detection.** The response is ignored. With a bad or revoked code, the server rejects every POST and the worker sees nothing. Fix: text SHORTCUT to Eyes for a new code and reinstall.
- **Accuracy.** `accuracy_m` is not sent. Shortcuts does not let the action pick an accuracy level.
- **Not run on iPhone.** Only tested on macOS (see test status below).

iOS limits (a running shortcut is not a background service):
- A running shortcut generally continues only while Shortcuts stays active. Locking the phone or switching apps may suspend or end the loop, including during Wait 60 s.
- No automation trigger fires every minute. Time of Day runs at set times only.
- Recommended: start the shift by running "Eyes: on shift" from a Lock Screen or Home Screen widget, or from the Action button. For passive updates, keep the Message "Eyes ping" automation for the one-shot shortcut.

Test status (macOS 26.2, 2026-10-17):
- Test variant (same generator, Repeat 3, Wait 60 s, POST to `http://127.0.0.1:8789/w/location`, Node logger `/tmp/eyes-on-shift-test/server.js`, token `x`) imported via the Add Shortcut sheet and ran with `shortcuts run`. Exit 0 after 3 min 8 s.
- Logger received 3 POSTs at 22:21:22, 22:22:22 and 22:23:22 UTC (60 s apart), each with `Authorization: Bearer x`, `application/json`, body `{"lng":…,"lat":…,"source":"shortcut","captured_at":"2026-10-17T15:21:20-07:00"}` (lat/lng as numbers).
- Earlier versions failed: a Set Variable count read back empty, and an If on the response body failed with `ConditionalAction` code 0. Both were removed.


## 3. Endpoint contract (owned by ops-dashboard-2; final as of 2026-10-17)

`POST https://api.eyes.pictures/w/location` (canonical). `POST /v1/worker/location` is an alias.
- **Auth:** `Authorization: Bearer <token>` header only. The token is a per-worker location token: 32 random bytes, base64url, stored as a sha256 hash. It is issued when the worker texts `SHORTCUT` and revoked on STOP. The short-lived HERE-link token is also accepted.
- **Body:** `{lat: number|string, lng: number|string, accuracy_m?: number|string, source: "shortcut"|"here_link"|"capture"|"findmy", input?: string ≤500, captured_at?: ISO8601}`. Unknown fields are ignored. `application/json` and `text/plain` with a JSON body are both accepted.
  - Accept numeric strings, and a comma decimal separator because of the iPhone's locale.
  - Reject values out of range, and reject `0,0`.
  - When `input` contains `Eyes ping <nonce>`, record that ping as answered.
- **Responses:** `204` stored. `400` bad coordinates. `401` bad token. `429` when more than 1 per 30 s or more than 1500 per day per worker; the latest fix is still stored if it is the first in that window.
- **Storage:** overwrite `last_lat`, `last_lng`, `last_accuracy_m`, `last_location_at`, `last_location_source`. Keep the latest fix only, with no history. Never log coordinates.
- **Privacy:** the signup text says location is used only to offer nearby tasks. Ignore fixes older than 24 h when dispatching. On STOP, delete the fix and revoke the token.

## 4. Fallbacks
- **HERE link** (every phone): a one-tap page that runs `navigator.geolocation.getCurrentPosition` and POSTs to the same endpoint with `source:"here_link"`. It needs a tap and a permission prompt, and it updates once per tap.
- **"Available for the next hour" page / PWA:** `watchPosition` keeps sending while the page is in the foreground with the screen on. iOS suspends it when the page is backgrounded or the phone locks, and home-screen PWAs get no background geolocation. Good for a short shift, not for passive tracking.
- **Long term:** if Inkbox passes Sendblue location data through, "Share My Location" in iMessage would work with zero setup. A dedicated line with request-location would let Eyes ask for location natively.

## 5. Sendblue: the real path for live location

Live "Share My Location" goes through Find My. Sendblue is the only provider found that decodes it and exposes it through an API: the webhook `message_type:"location"`, plus `POST /api/request-location`, `GET /api/location[/{number}]` and the SSE `GET /api/location/{number}/watch`. All of these require a **dedicated line**.

**Price and signup** (https://sendblue.com/pricing, https://docs.sendblue.com/getting-started/):
- Free sandbox: $0, no credit card. Shared number, full API, but only verified contacts: each recipient is added with `sendblue add-contact` and texts the number once. Location sharing is not available on it (dedicated lines only).
- AI Agent plan: **$100 per line per month**. Dedicated number, up to 1,000 inbound contacts/day, unlimited messages, webhooks. Signup at https://dashboard.sendblue.com/company-signup. Full outbound messaging (Eyes texting workers first) is listed only under Enterprise (custom price). Ask sales whether AI Agent covers our outbound offers.
- Steps: `npx -y @sendblue/cli setup --phone +1… --company eyes` (or the email + code flow), then `sendblue show-keys` (`SB-API-KEY-ID`, `SB-API-SECRET-KEY`), then buy or upgrade to a dedicated line in the dashboard, then set the `receive` webhook URL.

**What changes in Eyes**
1. `packages/comms/src/sendblue.ts`: `createSendblueMessaging(env)` implements the same `Messaging` interface as `createInkboxMessaging` (offer, capture link, already-claimed, paid texts reuse the existing `*Text()` helpers). Env: `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`. The provider is chosen by env.
2. `sendblueRoutes(deps, env)`: the receive webhook. Text replies go through the existing `parseReplyIntent`. `message_type:"location"` writes the fix with `source:"findmy"` through the same store as `/w/location`.
3. On join, after the worker's first reply, call `POST /api/request-location`. The worker accepts the native card and picks **Share Indefinitely**.
4. At dispatch: one `GET /api/location?from_number=…` returns every sharing contact's latest fix (`state`, `timestamp`, `expiresAt`). Refresh opted-in workers from it, then apply the existing 3 km rule. Workers in `not_shared` fall back to the Shortcut ping or the HERE link. SSE watch is not needed.
5. Tests mirror `inkbox.test.ts`: webhook parsing (text, location, unknown), plus location read mapping.

**Effort:** about 1 day of code and tests (items 1 to 5; `inkbox.ts` is the template). Account setup and line provisioning are separate: about 1 hour self-serve, or a few days if outbound requires an Enterprise sales call.

**Worker steps:** reply to the Eyes join text, tap **Share My Location** on the request card, choose **Share Indefinitely**. That is the whole setup. The worker can stop at any time in Find My → People.

**Privacy:** an indefinite share gives Eyes a continuous Find My fix (Sendblue caches it) until the worker stops sharing. Eyes must read it only at dispatch time, store only the latest fix, explain this at signup, and delete the fix on STOP. Sendblue sees all message content and locations as a processor, so it needs a DPA.
