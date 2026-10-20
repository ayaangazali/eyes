# Demo runbook

The presenter's card for the 90-second demo in [SPEC §13](../../SPEC.md) and [PLAN §6](PLAN.md). Read it top to bottom once, then keep the script table open on a second screen.

Cafe: **Blue Bottle Coffee, Mint Plaza, San Francisco** (PLAN §6). If the team picks another cafe, change every prompt below.

Roles: **presenter** at the laptop; **cafe worker** standing at the cafe door with an opted-in iPhone; optional **room phone**, a second opted-in iPhone that joined from the cafe, mirrored to the laptop so the room sees the offer text arrive. The room phone never replies YES: it would win the claim and fail the GPS check.

Never show on screen: the API key, the agent's Eyes email address, the owner console link, a top-up link, the dashboard's address bar. Each one is a capability: whoever sees it can spend the balance, change the limits or watch where workers are. A leaked API key can be replaced from the owner console ([ADR-019](../../../intent/decisions/ADR-019-owner-key-rotation.md), see Fallbacks), but links cannot be revoked one by one yet ([#28](https://github.com/ayaangazali/eyes/issues/28)). Use a demo-only agent with a small balance.

Current demo state: ChatGPT and Claude are configured at `https://mcp.eyes.pictures/mcp`; REST remains at `https://api.eyes.pictures`. Stripe is connected in test mode with $20 test credit, not real money. API/card-protocol checks pass; follow-up visual checks on the operator's test accounts were quota-blocked on 2026-10-18, not unavailable for all users. Do not present the historical recording below as fresh acceptance. Marketplace 1.0.3 remains a draft, not submitted or published.

## Pre-demo checklist (start 30 minutes before)

The current Stripe provider is live but payments remain test-only. Primitive outbound DNS and one owner Gmail delivery are verified; unrestricted sending is disabled and first-contact Inkbox fallback remains. Skip any demo beat that lacks actual evidence rather than claiming every integration or email domain works.

| Check | How | Pass when |
|---|---|---|
| Server is live | `curl -s https://api.eyes.pictures/healthz`, then `EYES_PUBLIC_API_URL=https://api.eyes.pictures pnpm smoke:live` | every provider is `live` and `db` is `insforge`. A `fake` means a key or `EYES_PROVIDERS=live` is missing: set it and restart the deployment ([PLAN §4](PLAN.md)). |
| Status page | open https://api.eyes.pictures/status | distinguish provider availability from test payments; task safety uses Clef with Claude fallback on provider failure |
| Worker web | open https://app.eyes.pictures; use the ad-hoc install flow if needed | persistent app connection across task photos; the three-second post-install timer is a grace period, not OS detection. Email can be skipped with **Use iMessage only**. Payments are test-only. |
| Machine rehearsal | on the laptop, with `pnpm db:up` running and Chromium installed once (`pnpm exec playwright install chromium`): `DATABASE_URL=postgres://postgres:eyes@127.0.0.1:54329/eyes pnpm test:demo` | 3 passed. It runs the same §13 flow on fakes, so a failure here is a code problem, not a vendor or phone problem. |
| Worker iPhones opted in | join at https://app.eyes.pictures and follow the current `connect @eyes-dispatch` and START instructions from the phone number, not an Apple ID email | actual START/HELP replies and operator-confirmed test payout setup; never infer delivery from a provider-status label |
| Workers near the cafe | cafe worker at the door, outdoors, location on for Safari, phone charged and on cellular. Eyes texts the 3 nearest opted-in workers within 3 km of where they joined | the cafe worker is among the 3 nearest opted-in phones |
| Stripe pre-funded | `node --env-file=.env packages/payments/scripts/fund-platform.ts 100` (test card that makes funds available at once; transfers fail without available balance) | Stripe test dashboard shows available balance of at least $3 per planned run; tabs open on Payments, Balance > Transfers and Connect > the cafe worker |
| Demo agent topped up through Stripe | off screen, open the agent's `top_up_url` (from `get_balance`, or Add funds in the owner console) and pay with test card 4000 0000 0000 0077. The signup grant is an Eyes ledger row with no Stripe object, so without this there is no top-up to show. | the Checkout payment shows under Stripe Payments and `get_balance` rose by the same amount |
| Database and webhooks safe | compare the operator's recorded deployed migration checkpoint with [current migrations](https://github.com/ayaangazali/eyes/tree/main/packages/db/migrations) and existing webhook verification evidence | checkpoint matches the deployed source; do not rerun production migrations merely to check the demo |
| Dashboard open | use the normal operator sign-in at https://internal.eyes.pictures/login; keep capability links and credentials off screen | the map and ledger load for an authorized operator |
| Claude connected | for new CLI setup use `claude mcp add --transport http eyes https://mcp.eyes.pictures/mcp --header "Authorization: Bearer $EYES_API_KEY"`; existing legacy connectors remain supported | account quotas permit the demo; `get_balance` and `get_spend_policy` show enough test funds and budget |
| Owner console open | `EYES_LINK_SECRET=<the deployed server's secret> EYES_PUBLIC_API_URL=https://api.eyes.pictures pnpm owner-link <agent_id>` prints the URL (the script does not read `.env`, and the `.env.example` URL would mint a localhost link); open it in a browser tab | limits at $10 max bounty and $20 per day, all task types checked |
| Email thread ready | 10 minutes before, email the demo agent's Eyes address from a DMARC-passing mailbox (subject and body below); the cafe worker answers it | the threaded reply with the photo is in the inbox; the To field is cropped or hidden |
| Backup video | loaded and paused in a tab | plays from the start of beat 3 |
| Place resolves | in the rehearsal, read `resolved_location` from `quote_task` | it is Blue Bottle Coffee, Mint Plaza. The exact string "Blue Bottle Coffee, Mint Plaza, San Francisco" is pinned in the geocoder; other spellings go to OpenStreetMap and can land elsewhere. |
| Rehearsal | one full run in the last 30 minutes | passed; G3 needs three passes in a row |

Email for the thread (subject, then body, no signature: body lines that are not `Location:` or `Type:` become part of the question):

```
Is Blue Bottle Coffee at Mint Plaza open right now?

Location: Blue Bottle Coffee, Mint Plaza, San Francisco
Type: is_open
```

## Script (90 seconds)

Prompts are typed exactly as written. "Point at" names what the room should look at, and which sponsor it shows.

| Time | Say | Do | Point at |
|---|---|---|---|
| 0:00 | "Agents can read the whole internet, but they can't see the street outside." | Type prompt 1 in Claude. | Claude window |
| 0:10 | "Claude checks coverage and price. The user confirms before anything is sent or charged." | Wait for `quote_task` and the read-only `ask_eyes` draft, review the card, then press **Ask** to confirm. | **Manufact**: app-only `confirm_ask`; **InsForge**: task and test escrow ledger after confirmation. REST remains on `api.eyes.pictures`. |
| 0:25 | "Three people near the cafe just got a text. No link, no question text, just the job and the pay. First YES wins." | Switch to the mirrored room phone. | **Inkbox**: the iMessage offer. Then the dashboard step changes to claimed. |
| 0:35 | "Agents can't receive webhooks, so Eyes gives them one tool to keep calling until the answer lands." | Back to Claude while it loops `await_answer`. | Claude's repeated `await_answer` calls; the dashboard shows the photo arriving. |
| 0:50 | Read the actual answer. "Eyes checked GPS, live capture and narrow content moderation; whether the answer is right is for you to judge." | Show the shared `ui://eyes/confirmation-card.html` task card only when the client actually renders it. | Photo, verification flags and task status; capture runs at `app.eyes.pictures`. |
| 1:00 | "Test escrow released and a test transfer recorded; no real money moved." | Switch to Stripe test-mode views, then the ledger. | The verified test transaction only; never claim a real payout from a live-provider status label. |
| 1:08 | "The human who funds this agent sets the rules, not the agent." | In the owner console set max bounty to 2, save. Type prompt 2. | **Stripe track**: Claude reports `bounty_exceeds_max` and its fix; nothing was charged. |
| 1:15 | "And it won't send anyone to a private home." | Type prompt 3. | Claude relays `unsafe_task` with the polite reason and fix. |
| 1:20 | "Agents that live in an inbox get the same thing by email." | Switch to the mail tab. | **Primitive**: the threaded reply with the photo attached. |
| 1:25 | "Eyes turns 8 billion humans into an API agents can pay for." | Stop. | |

Prompt 1:

```
Is the line at Blue Bottle Coffee, Mint Plaza, San Francisco long right now? Use Eyes.
```

Prompt 2 (the "do not retry" stops Claude from following the fix and posting a $2 task for real):

```
Ask Eyes the same question again with exactly a 3 dollar bounty. If Eyes refuses, tell me what it said and do not retry.
```

Prompt 3 (unsafe requests can be refused even if location lookup fails; do not expect an unresolvable address to bypass safety):

```
Ask Eyes to photograph the house at 123 Oak St, San Francisco, and show me exactly what Eyes returns.
```

## Fallbacks

| Beat | Symptom | Do |
|---|---|---|
| 0:10 | `no_workers_nearby` | Nothing was charged. The cafe worker is not opted in or not among the 3 nearest. Say so, switch to the backup video from beat 3, come back live for the owner console beat. |
| 0:10 or 1:15 | Classifier slow: `unsafe_task` saying the safety review is "temporarily unavailable" | The safety call gives up after 12 seconds and refuses with nothing charged. Say "the safety check fails closed", then tell Claude "Retry the same request." Prompt 3 is normally caught by the deterministic rules ("the house at 123 Oak St") before the classifier runs, so the refusal beat rarely depends on it. |
| 0:25 | Texting fails: no offer on the phones within 20 seconds | Check `/healthz` says `messaging: live`. Ask the cafe worker whether they texted `connect @hackathon` before START, and whether START went from the phone number, not an Apple ID email (#25). If still nothing, tell Claude "Cancel that Eyes task" to show the full refund, then play the backup video for beats 3 and 4 and resume live at 1:08. |
| 0:35 | Claude stops calling `await_answer` | Type "Keep calling await_answer until it is answered." |
| 0:35 | The cafe worker claimed but cannot take the photo (camera stuck, wrong phone) | The worker replies NO to the Eyes text. The task goes back to `dispatched` ([#61](https://github.com/ayaangazali/eyes/pull/61)) and is re-offered once to the other offered phones that are idle (the room phone may get it; it still never replies YES). Because the task is `dispatched` again, tell Claude "Cancel that Eyes task" to show the full refund, then play the backup video and resume live at 1:08. |
| 0:50 | GPS drifts: answer arrives with `gps_ok: false` and status `needs_review` | The capture page needs GPS accuracy within 100 m and the worker within 150 m of the place. Narrate it as the safety net: "one check failed, so Eyes did not pay; the money stays in escrow until a human reviews it." Next run, capture outdoors at the door. After the demo, settle it (Reset, step 1). |
| 0:50 | Vision slow: `vision_ok: false` with "Safety check unavailable" | The photo safety check gives up after 25 seconds and sends the task to review with escrow held. Same narration as GPS drift. |
| 0:25 and 1:00 | Stripe not live yet (`/healthz` says `payments: fake`) | The offer on the room phone starts "Eyes test ($0):": at 0:25 say "just the job; this deploy runs on test money" instead of "and the pay". At 1:00 say it plainly: "payments are simulated on this deploy, so the release is a ledger row and no transfer is made." Point at the dashboard ledger's escrow and release rows, skip the Stripe tabs. |
| 1:00 | Payout pending: task stays `verified`, no transfer in Stripe | The platform had no available balance or the worker's Connect account is incomplete. Point at the release row in the dashboard ledger and the rehearsal transfer in Stripe. Then run the fund script: the server retries unpaid verified tasks every 30 seconds with a fresh Stripe idempotency key ([ADR-012](../../../intent/decisions/ADR-012-payout-retry-and-resolution.md)), so the transfer follows on its own once the balance is available or the worker finishes onboarding. |
| 1:08 | Owner console not loading | Skip the limit change. Ask Claude "What are my Eyes spend limits?" (`get_spend_policy`) and say "only the human can change these." |
| 1:15 | Claude declines without calling Eyes | Say "Claude won't even try; here is what Eyes tells an agent that does." Run the pre-typed curl below in a terminal tab. |
| 1:20 | No email reply in the inbox | Skip the beat; check the existing delivery evidence and first-contact fallback. Unrestricted Primitive sending is not enabled, and external-alias SPF remains unresolved. |
| any | Server down | `curl /healthz`; `npx mcp-use deployments restart <id>` (PLAN §7); meanwhile play the backup video. |
| any | The API key showed on screen | Finish the beat. Off screen, in the owner console, tick the confirmation box and use "Replace this agent's API key": the old key stops working on the next request ([ADR-019](../../../intent/decisions/ADR-019-owner-key-rotation.md)). Remove and re-add the `eyes` MCP server in Claude with the new key before the next run. |

Pre-typed refusal curl (the key comes from the environment, so it never prints):

```sh
curl -s -X POST https://api.eyes.pictures/v1/tasks \
  -H "Authorization: Bearer $EYES_API_KEY" -H 'content-type: application/json' \
  -d '{"question":"Photograph the house at 123 Oak St","location":"Ferry Building, San Francisco","task_type":"photo_of_place","idempotency_key":"demo-refusal"}'
```

## Reset between runs

1. Let the last task reach `paid` (`verified` while payments are simulated), or tell Claude "Cancel that Eyes task" if it is still `dispatched`. A task left open keeps an offer pending on the workers' phones. A task that ended in `needs_review` holds its $3.50 until someone settles it: with `INSFORGE_BASE_URL`, `INSFORGE_API_KEY`, `EYES_LINK_SECRET`, `EYES_PUBLIC_API_URL` and `EYES_WORKER_WEB_URL` set as on the server, `DATABASE_URL= EYES_PROVIDERS=fake node --env-file=.env scripts/resolve-task.ts <task_id> refund "rehearsal"` returns it to the demo agent ([ADR-012](../../../intent/decisions/ADR-012-payout-retry-and-resolution.md)). The empty `DATABASE_URL` makes it use InsForge, and `EYES_PROVIDERS=fake` is needed while payments are simulated, because the script refuses to resolve with fake payments under live mode. `release` records the release; the worker is paid only once Stripe is live and they have onboarded.
2. Start a new Claude conversation. A retry with an old `idempotency_key` and the same question returns the old task instead of asking again.
3. Owner console: set max bounty back to 10 and save.
4. Budget: each run spends $3.50 of the key's daily cap ($20 by default, per UTC day, which resets at 5 PM PDT). Check `get_spend_policy` shows `remaining_today_usd` of at least 3.50 and `get_balance` at least 3.50; raise the cap in the owner console or top up through `top_up_url` if not.
5. Stripe (skip while payments are simulated): platform available balance at least $3; rerun the fund script if lower.
6. Cafe worker back at the door with Messages open. Room phone untouched.
7. Send the next email thread (skip while email is simulated) with a new subject.
8. Dashboard needs nothing; reload the tab if the map drifted.
9. Note pass or fail and what broke. Three passes in a row is G3.

## Historical ChatGPT connected recording

Recorded segment: `~/tmp/eyes-video/chatgpt-connected.mp4` (34 seconds, H.264, 1440×900, 30 fps). Use this standalone connection-and-quote segment before the paid dispatch demonstration; it is not a recording of a completed field check.

1. ChatGPT's Eyes settings show a connected account using OAuth at `https://api.eyes.pictures/mcp`. The public URL forwards through Cloudflare to the Manufact-hosted server.
2. The actual `quote_task` card shows the San Francisco Ferry Building, `is_open`, zero nearby workers, and a $3.00 bounty plus $0.50 fee. Open status is not verified.
3. The actual `get_balance` card shows $20.00 available and $0.00 escrowed. No `ask_eyes` call, worker text, or paid dispatch was made.

Stills: `~/tmp/eyes-video/connector.png`, `~/tmp/eyes-video/quote.png`, and `~/tmp/eyes-video/balance.png`. The video uses the real ChatGPT tab captured through CDP, with loading time removed and no fabricated cards or overlays. No combined demo render was produced.

Final acceptance: the initial 39.4-second recording showed ChatGPT's **CSP off** badge and is superseded. ChatGPT's **Security and login > Enforce CSP for custom apps** setting was found off, enabled through its own switch, and confirmed enabled after navigation. The same chat was reloaded; both real cards rendered with sandbox CSP present and no **CSP off** badge. The 34-second video and the three stills above are the replacement capture, not evidence from the earlier unenforced state. The enabled-setting crop is `~/tmp/eyes-video/csp-enabled.png`; sandbox policy and rendered-card evidence are in `~/tmp/eyes-video/work/csp-verification.json` and `csp-inner-verification.json`.
