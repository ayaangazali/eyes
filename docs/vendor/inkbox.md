# Inkbox - vendor note

Fetched: 2026-10-16. Sources (all read):
- https://inkbox.ai/llms.txt (doc index; every doc page has a `.md` twin under https://inkbox.ai/docs/...)
- https://inkbox.ai/docs/capabilities/phone.md
- https://inkbox.ai/docs/capabilities/phone/10dlc.md
- https://inkbox.ai/docs/capabilities/imessage.md
- https://inkbox.ai/docs/capabilities/identities.md
- https://inkbox.ai/docs/get-started/quickstart.md
- https://inkbox.ai/docs/webhooks.md
- https://inkbox.ai/docs/signing-keys.md
- https://inkbox.ai/docs/api/phone/webhooks.md
- https://inkbox.ai/docs/api/phone/texts.md
- https://inkbox.ai/docs/api/imessage/webhooks.md
- https://inkbox.ai/docs/skills/typescript.md
- https://raw.githubusercontent.com/inkbox-ai/inkbox/main/skills/inkbox-ts/SKILL.md
- Web search (secondary only, see Open questions): YC page https://www.ycombinator.com/companies/inkbox

Note: the WebFetch tool summarizes pages with a small model, so payload samples below are field lists, not byte-exact JSON. Builders should log one real webhook and pin types to it.

## What Eyes uses it for
Inkbox is the dispatcher identity: one agent identity with one US local phone number. Eyes uses it to (1) text nearby workers a task offer with a capture link, (2) receive worker replies ("YES") via webhook, (3) send confirmations, payout and expiry texts. iMessage is an optional upgrade, not required. Vendor: Inkbox (YC S26), docs at https://inkbox.ai/docs, TS SDK `@inkbox/sdk`.

Inkbox also has email (mailboxes per identity), calls, Slack, A2A, tunnels, contacts, vault. Email overlaps Primitive; we ignore Inkbox email and keep Primitive for agent email (source: llms.txt).

## Auth & setup
- Package: `npm install @inkbox/sdk` (https://inkbox.ai/docs/get-started/quickstart.md). Node >= 22 per the skill page (https://inkbox.ai/docs/skills/typescript.md); a search snippet said >= 18, so use Node 22.
- Env var: `INKBOX_API_KEY` (name used in quickstart; the SDK constructor takes it explicitly, it is NOT auto-read per the SKILL.md which says constructor takes `apiKey`, `baseUrl?`, `timeoutMs?`).
- Where to get the key: Inkbox console, https://inkbox.ai/console (quickstart). Key types: admin-scoped vs agent-scoped (https://inkbox.ai/docs/api-keys.md, title only read in llms.txt). Use an admin key on the server; writing contact rules and SMS opt-ins needs admin.
- Additional env vars we should define: `INKBOX_AGENT_HANDLE` (our own, e.g. `eyes-dispatch`), `INKBOX_WEBHOOK_SIGNING_KEY` (the `whsec_...` plaintext returned once), `INKBOX_WEBHOOK_AUTH_TOKEN` (optional bearer we choose).
- No separate test/live key split is documented. Treat the account as live. No sandbox documented (see Open questions).

```ts
import { Inkbox } from "@inkbox/sdk";
const inkbox = new Inkbox({ apiKey: process.env.INKBOX_API_KEY! });
// source: quickstart.md
```

### Create identity + phone number (one call)
```ts
const identity = await inkbox.createIdentity("eyes-dispatch", {
  displayName: "Eyes",
  phoneNumber: { type: "local" },
  // imessageEnabled: true,   // optional, see iMessage
});
```
Source: https://inkbox.ai/docs/capabilities/identities.md and quickstart (option names inferred from usage examples; no formal type signature on the page).
- Handle is globally unique and immutable after creation.
- Max one phone number per identity. Provision later with `identity.provisionPhoneNumber({ type: "local" })`; pick a state via `inkbox.phoneNumbers.provision({ agentHandle: "eyes-dispatch", state: "CA" })` (phone.md). SF area code not documented as selectable, only state.
- Fetch later: `inkbox.getIdentity("eyes-dispatch")`; `identity.refresh()`.
- Creating an identity also creates a mailbox and tunnel (unavoidable, ignore them).
- Release: `identity.unlinkPhoneNumber()`.

### Provisioning time / SMS readiness
- A new local number takes ~10 to 15 minutes to attach to Inkbox's 10DLC campaign. Sends in that window return `409 sender_sms_pending`. Wait for the number's `sms_status` to be `ready` before sending (https://inkbox.ai/docs/capabilities/phone/10dlc.md, phone.md, texts.md). **Provision the number the day before the demo, not at demo time.**
- US numbers only today (secondary source; see Open questions).

## Exact SDK/API calls we need

### Send SMS (1:1)
```ts
const sent = await identity.sendText({
  to: "+15551234567",          // E.164
  text: "Eyes task $3: is the line at Blue Bottle on Mint St under 10 people? Reply YES to claim.",
  // idempotencyKey: "task_123_worker_456",
});
// sent.delivery_status === "queued" (accepted, not delivered)
```
Source: phone.md, skills/typescript.md. REST: `POST /numbers/{phone_number_id}/texts` (base `https://inkbox.ai/api/v1`, header `X-API-Key`) with body `{ to | conversation_id, text (<=1600 chars), media_urls (<=10) }`; reply in thread with `identity.sendText({ conversationId, text })`. 201 returns a text message object with `id`, `conversation_id`, `delivery_status: "queued"`. Idempotency: REST header `Idempotency-Key` with `Prefer: idempotency-replay`; SDK option `idempotencyKey` (phone.md). Use `taskId:workerId` as the key so dispatch retries never double-text.

Errors (texts.md): 400 number not active; 403 `recipient_not_opted_in` / `recipient_opted_out` / blocked by contact rule; 404; 409 `sender_sms_pending` or not eligible; 422 invalid body or `message_blocked_spam_filter`; 429 24h cap (honor `Retry-After`, headers `X-RateLimit-*`).

### List / read texts (polling fallback)
```ts
const texts = await identity.listTexts({ limit: 20, offset: 0, isRead: false });
// fields: t.id, t.direction, t.remotePhoneNumber, t.text, t.isRead
```
Source: SKILL.md. REST `GET /numbers/{phone_number_id}/texts?limit&offset&is_read&start_datetime&end_datetime` newest first, limit 1 to 200 (texts.md). Use this as polling fallback if webhooks fail.

### Send iMessage (optional)
```ts
const sent = await identity.sendIMessage({ to: "+15551234567", text: "..." });
console.log(sent.service, sent.status); // "imessage"|"sms"|"rcs", "queued"
await identity.sendIMessage({ conversationId: convoId, text: "Thanks, paid." });
const router = await inkbox.imessages.getTriageNumber(); // { number, connectCommand }
```
Source: imessage.md, SKILL.md.

### SMS opt-in (see gotchas; only works on our own 10DLC campaign)
```ts
// Python shown in docs; TS equivalent name not shown. REST/CLI exist.
inkbox.sms_opt_ins.opt_in("+15551234567")
```
Source: phone.md. Requires a customer-managed active 10DLC campaign, else `409 customer_campaign_required`.

### Create webhook subscription (identity-owned, for text events)
```ts
const sub = await inkbox.webhooks.subscriptions.create({
  agentIdentityId: identity.id,
  url: "https://<our-host>/webhooks/inkbox",
  eventTypes: ["text.received", "text.delivery_failed"],
  // authToken: process.env.INKBOX_WEBHOOK_AUTH_TOKEN,
});
if (sub.signingKey) saveSecret(sub.signingKey); // plaintext only on first subscription
```
Source: SKILL.md and webhooks.md. REST: `POST https://inkbox.ai/api/v1/webhooks/subscriptions` body `{agent_identity_id, url, event_types, auth_token?}`. The `authToken` field name in the TS SDK is inferred from the REST `auth_token`; verify.

### Signing key
```ts
const key = await identity.createSigningKey();        // plaintext returned ONCE
const st = await identity.getSigningKeyStatus();      // { configured, createdAt }
// or inkbox.signingKeys.createOrRotate("eyes-dispatch")
```
Source: SKILL.md. REST `POST /api/v1/identities/{agent_handle}/signing-key` returns `{signing_key, created_at}`; calling again rotates (invalidates old) (signing-key page). Do this once, store as `INKBOX_WEBHOOK_SIGNING_KEY`.

## Webhooks / inbound

Events (webhooks.md): text: `text.received`, `text.sent`, `text.delivered`, `text.delivery_failed`, `text.delivery_unconfirmed`. iMessage: `imessage.received`, `imessage.reaction_received`, `imessage.sent`, `imessage.delivered`, `imessage.delivery_failed`. Also `call.ended`.

Constraints: overlapping events on the same identity+URL across two subscriptions are rejected; PATCH replaces the whole event list; delivery order is NOT guaranteed (SKILL.md). Handle a `text.received` for a stale task idempotently.

### `text.received` payload (phone/webhooks.md; field list, not verbatim JSON)
Envelope: `event_type: "text.received"`, `timestamp`, `data` (a stable `id` of form `evt_...` is described on webhooks.md; confirm presence on text events).
`data.text_message`: `id`, `direction: "inbound"`, `local_phone_number`, `remote_phone_number` (the worker), `text` (body), `type` ("sms"|"mms"), `media`, `is_read`, `delivery_status` (null inbound), `origin`, `conversation_id`, `sender_phone_number`, `recipients` (null inbound), `created_at`, `updated_at`. Plus `data.contacts[]`, `data.agent_identities[]` (always present, maybe empty), `data.recipient_phone_number` (null inbound), optional `data.context`. Wire fields are snake_case.

Mapping a reply to a task: the payload has no reference to our outbound message beyond `conversation_id`. Persist `conversation_id` (returned by `sendText`) on the dispatch row, and also look up the worker by `remote_phone_number` for open offers. Rule: a bare "YES" from a worker with multiple open offers claims the most recent offer; include a short code in the SMS ("Reply YES A7") if multi-offer matters.

### `imessage.received` payload (imessage/webhooks.md)
`id` (`evt_...`, stable across retries = dedupe key), `event_type`, `timestamp` (ISO 8601), `data.message`: `conversation_id`, `direction`, `remote_number`, `sender_number` (null in 1:1), `content` (text), `is_group`, `participants`, `thread_id`, `reply_to_message_id`, `assignment_id`, `service`, `status: "received"`, `created_at`. `data.reaction` null for messages.

### Signature verification (phone/webhooks.md, SKILL.md)
Headers: `X-Inkbox-Request-ID`, `X-Inkbox-Timestamp` (unix seconds), `X-Inkbox-Signature` (`sha256=<hex>`). Algorithm: HMAC-SHA256 with the identity signing key over the string `{request_id}.{timestamp}.{raw_body}`; reject if timestamp skew > 300 s; constant-time compare. If subscription has `auth_token`, requests also carry `Authorization: Bearer <token>`.

```ts
import { verifyWebhook } from "@inkbox/sdk";
// Need RAW body (Buffer/string). In Next/Hono: const raw = await req.text();
const ok = verifyWebhook({ payload: raw, headers: Object.fromEntries(req.headers), secret: process.env.INKBOX_WEBHOOK_SIGNING_KEY! });
if (!ok) return new Response("bad sig", { status: 403 });
const evt = JSON.parse(raw); // parse only AFTER verify
```
Source: https://inkbox.ai/docs/webhooks.md (Express example with `express.raw({type:"*/*"})`). Header names in the SDK call are lowercased (`x-inkbox-*`); pass a plain object with lowercase keys. If hosted in a runtime where `verifyWebhook` is awkward, the manual algorithm above is fully specified.

### Retries
Deliveries are fire-and-forget HTTP POSTs; our response status is logged and does not affect processing; the event `id` is unchanged across retries, so retries exist, but no schedule/timeout is documented. Respond 2xx fast, do work async, dedupe on event `id` (insert into a processed-events table with unique id).

## Limits, test-mode quirks, gotchas
- **10DLC does NOT hard-block a new number**, but: default Inkbox campaign, ~10 to 15 min propagation (409 `sender_sms_pending`), then cap of **100 recipient sends per rolling 24 h per number** (group counts per recipient). Own campaign lifts cap but needs brand + campaign registration: brand "a few hours" to 1 to 2 business days, carrier review a few business days, $20/month (10dlc.md). **Do not attempt own campaign for the hackathon.**
- **US recipient opt-in is the real blocker.** Every US/US-territory recipient must text `START` to our Inkbox number before we can message them; otherwise `403 recipient_not_opted_in` (phone.md, SKILL.md). Worker onboarding must include "text START to +1XXX" (show our number in the signup page and verify via a received `START` text before marking the worker active). `STOP` blocks everywhere (`403 recipient_opted_out`). Programmatic opt-in only on own campaign. Non-US recipients don't need START.
- Message length: 1600 chars for SMS/MMS body (texts.md). Keep SMS under 160 GSM chars when possible; links in SMS are allowed (no stated restriction on SMS). `message_blocked_spam_filter` (422) exists: avoid ALL-CAPS/short-URL-shortener patterns; use our own domain link.
- iMessage restrictions: before a recipient replies, 1:1 messages must be <= 159 chars, **no links, no phone numbers, no media**, max 3 messages (422 codes `imessage_reply_required_for_links_or_media` etc.). So an iMessage task offer with a capture link is NOT allowed to a cold recipient. Shared-service iMessage also requires the human to text a connect command to the router first, and the connection expires after 14 idle days. A dedicated line can initiate conversations and is "by request"-ish, not guaranteed. Quote: "Dedicated lines also limit agent-initiated conversations to 10 new recipients per rolling hour and 40 per rolling 24 hours. Existing recipients and recipients who message the line first do not consume these first-contact slots." (https://inkbox.ai/docs/capabilities/imessage.md) Eyes never texts first (workers text START before any offer), so this cap does not apply to us (verified in PR #48). Inkbox tries iMessage first and may fall back to SMS; you cannot force transport (`service`, `was_downgraded` in response).
- Group MMS is beta; ignore.
- Media URLs on inbound MMS are presigned and expire in 1 h.
- Idempotency: always pass `idempotencyKey`.
- No sandbox/test mode or fake-phone simulator is documented. For tests: mock `identity.sendText` in unit tests; for demo, use team members' real phones that have texted START. You can simulate inbound by POSTing a self-signed payload to our own webhook (we hold the signing key, algorithm above).
- Webhook URL must be HTTPS and publicly reachable; Inkbox also offers tunnels (`@inkbox/sdk/tunnels/connect`) but we deploy on InsForge/Manufact, so use that URL directly.

## Contradictions with our plan
| Plan assumes | Docs say | Source |
|---|---|---|
| Eyes can text any nearby registered worker | US recipients must first text `START` to our number or sends 403 `recipient_not_opted_in` | https://inkbox.ai/docs/capabilities/phone.md |
| Number ready immediately after provisioning | ~10 to 15 min of `409 sender_sms_pending` | https://inkbox.ai/docs/capabilities/phone/10dlc.md |
| iMessage dispatch with a capture link | Cold 1:1 iMessage: <=159 chars, no links/phone numbers/media; shared service needs human to text a connect command first | https://inkbox.ai/docs/capabilities/imessage.md |
| Can choose iMessage vs SMS per send | Transport is chosen by Inkbox (iMessage first, SMS fallback); not selectable | https://inkbox.ai/docs/capabilities/imessage.md |
| Unlimited dispatch fan-out | 100 recipient sends / rolling 24 h per number on default campaign | https://inkbox.ai/docs/api/phone/texts.md |
| Sandbox/test mode available | None documented | (absence in all pages read) |
| Webhook payload carries our task reference | Inbound text has only conversation_id / remote number; we must map ourselves | https://inkbox.ai/docs/api/phone/webhooks.md |

## Open questions / unverified
- Hackathon credits, pricing, free tier, plan outbound caps: not found in docs; ask Inkbox at the YC event or contact ray@inkbox.ai (listed on YC page, secondary). Billing page `https://inkbox.ai/docs/api/billing` not read.
- Whether phone provisioning requires a paid plan or card on file.
- US-only number availability (from search snippet, not primary).
- Exact `text.received` JSON sample and whether it includes top-level event `id` and `timestamp` ISO vs unix (docs show ISO for iMessage; text page lists `timestamp`).
- TS SDK option name `authToken` on `webhooks.subscriptions.create`, and TS name for opt-in helpers (only Python shown).
- Retry schedule/timeout for webhook delivery.
- Whether a worker's `START` text itself arrives as `text.received` (likely, since it hits our number; Inkbox may also consume the keyword). Test early with one real phone.
- Whether sends to a recipient who never texted START could be unblocked by registering the worker as a Contact (docs: "contact communication permissions" page exists, not read).
- Exact `sms_status` field location (identity vs phone number object).
