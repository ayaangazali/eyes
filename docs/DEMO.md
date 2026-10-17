# Demo runbook

The presenter's card for the 90-second demo in [SPEC §13](SPEC.md) and [PLAN §6](PLAN.md). Read it top to bottom once, then keep the script table open on a second screen.

Cafe: **Blue Bottle Coffee, Mint Plaza, San Francisco** (PLAN §6). If the team picks another cafe, change every prompt below.

Roles: **presenter** at the laptop; **cafe worker** standing at the cafe door with an opted-in iPhone; optional **room phone**, a second opted-in iPhone that joined from the cafe, mirrored to the laptop so the room sees the offer text arrive. The room phone never replies YES: it would win the claim and fail the GPS check.

Never show on screen: the API key, the agent's Eyes email address, the owner console link, a top-up link, the dashboard's address bar. Each one is a capability: whoever sees it can spend the balance, change the limits or watch where workers are. A leaked API key can be replaced from the owner console ([ADR-019](../intent/decisions/ADR-019-owner-key-rotation.md), see Fallbacks), but links cannot be revoked one by one yet ([#28](https://github.com/ayaangazali/eyes/issues/28)). Use a demo-only agent with a small balance.

## Pre-demo checklist (start 30 minutes before)

| Check | How | Pass when |
|---|---|---|
| Server is live | `curl -s https://dark-wave-wfmpm.run.mcp-use.com/healthz`, then `EYES_PUBLIC_API_URL=https://dark-wave-wfmpm.run.mcp-use.com pnpm smoke:live` | every provider is `live` and `db` is `insforge`. A `fake` means a key or `EYES_PROVIDERS=live` is missing: set it and restart the deployment ([PLAN §4](PLAN.md)). |
| Status page | open https://dark-wave-wfmpm.run.mcp-use.com/status | every provider row says live, there is no "This is a simulated deploy" box, and the safety row says "Safety review: rules and AI classifier". "rules only" means `ANTHROPIC_API_KEY` is missing: prompt 3 is still refused by the rules, but subtler unsafe tasks are not. |
| Worker web says payouts are live | rebuild the worker web with `VITE_LIVE_PAYOUTS=true` (and the Inkbox number and connect command) and redeploy Sites after `STRIPE_SECRET_KEY` is set ([DEPLOY §3](DEPLOY.md)) | the JOIN page has no "This is a test server" notice and says checks usually pay $3 |
| Machine rehearsal | on the laptop, with `pnpm db:up` running and Chromium installed once (`pnpm exec playwright install chromium`): `DATABASE_URL=postgres://postgres:eyes@127.0.0.1:54329/eyes pnpm test:demo` | 3 passed. It runs the same §13 flow on fakes, so a failure here is a code problem, not a vendor or phone problem. |
| Worker iPhones opted in | each phone joined at https://7t6779x4.insforge.site, then from its phone number (Settings > Messages > Send & Receive > Start New Conversations From: the number, not an Apple ID email, [#25](https://github.com/ayaangazali/eyes/issues/25)) texted `connect @hackathon` and then START to +1 650-484-9720 (Inkbox's shared line: without the connect text, START reaches no one). Once Stripe is live, each finishes onboarding from the payout link in the START reply. Then each phone texts HELP. | the START reply arrives (with a payout setup link only once Stripe is live, and the worker's account then shows in Stripe Connect); the HELP reply arrives and ends with an earnings link, which proves inbound and outbound texting on that phone without posting a task |
| Workers near the cafe | cafe worker at the door, outdoors, location on for Safari, phone charged and on cellular. Eyes texts the 3 nearest opted-in workers within 3 km of where they joined | the cafe worker is among the 3 nearest opted-in phones |
| Stripe pre-funded | `node --env-file=.env packages/payments/scripts/fund-platform.ts 100` (test card that makes funds available at once; transfers fail without available balance) | Stripe test dashboard shows available balance of at least $3 per planned run; tabs open on Payments, Balance > Transfers and Connect > the cafe worker |
| Demo agent topped up through Stripe | off screen, open the agent's `top_up_url` (from `get_balance`, or Add funds in the owner console) and pay with test card 4000 0000 0000 0077. The signup grant is an Eyes ledger row with no Stripe object, so without this there is no top-up to show. | the Checkout payment shows under Stripe Payments and `get_balance` rose by the same amount |
| Database and webhooks safe | `node scripts/insforge-migrate.ts` answers 409 for every migration 001-014 (all applied), and `EYES_FAKE_WEBHOOKS` is NOT set on the server ([DEPLOY](DEPLOY.md)). | no 201 lines; `/webhooks/stripe` with a bad signature does not credit anything |
| Dashboard open | Once: set `EYES_OPS_KEY` on the server (`openssl rand -hex 32`) and restart the deployment ([DEPLOY §2](DEPLOY.md)). Then open `https://dark-wave-wfmpm.run.mcp-use.com/ops/<key>` and go full screen so the address bar, which holds the key, is off screen. A judge who wants to watch on their own device gets the link in a direct message, never in a public channel; change the key and restart after judging. Fallback with no server change: `DATABASE_URL= node --env-file=.env apps/web/dashboard/src/server.ts` from the repo root (the empty `DATABASE_URL` makes it read InsForge), then http://127.0.0.1:4400 on the presenting laptop | map loads, rehearsal tasks are listed, the ledger has rows, the top corner says Live. "Unknown route." means `EYES_OPS_KEY` is unset or empty on the server, the deployment was not restarted after setting it, or the key in the URL is wrong. |
| Claude connected with a funded key | off screen: `claude mcp add --transport http eyes https://dark-wave-wfmpm.run.mcp-use.com/mcp --header "Authorization: Bearer $EYES_API_KEY"`, then ask Claude "Use Eyes get_balance and get_spend_policy." | `balance_usd` at least 3.50, `max_bounty_usd` at least 3, `remaining_today_usd` at least 3.50 per planned run |
| Owner console open | `EYES_LINK_SECRET=<the deployed server's secret> EYES_PUBLIC_API_URL=https://dark-wave-wfmpm.run.mcp-use.com pnpm owner-link <agent_id>` prints the URL (the script does not read `.env`, and the `.env.example` URL would mint a localhost link); open it in a browser tab | limits at $10 max bounty and $20 per day, all task types checked |
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
| 0:10 | "Claude checks coverage and price, then posts the task. $3.50 is now in escrow." | Wait for `quote_task` and `ask_eyes`. | **Manufact**: the tool calls going to the `eyes` MCP server on `run.mcp-use.com`. Eyes ledger escrow: `escrowed_usd: 3.5` (an Eyes ledger entry, not a Stripe object). **InsForge**: dashboard pin and "3 workers notified", read from InsForge Postgres. |
| 0:25 | "Three people near the cafe just got a text. No link, no question text, just the job and the pay. First YES wins." | Switch to the mirrored room phone. | **Inkbox**: the iMessage offer. Then the dashboard step changes to claimed. |
| 0:35 | "Agents can't receive webhooks, so Eyes gives them one tool to keep calling until the answer lands." | Back to Claude while it loops `await_answer`. | Claude's repeated `await_answer` calls; the dashboard shows the photo arriving. |
| 0:50 | Read Claude's real answer, for example "Short line, about four people, verified 38 meters away, $3.50 total." Then: "Eyes checked GPS, that the photo was live, and with Claude vision that it answers the question." | Scroll to the answer. | `verification` flags and `worker_distance_m` in the answer; the photo URL (**InsForge** storage); the capture page ran on `*.insforge.site`. |
| 1:00 | "Escrow released, worker paid. If nobody had answered, all of it would come back." | Switch to the Stripe tabs, then the dashboard ledger. | **Stripe**: the Checkout top-up that funded the agent, then the $3 transfer to the cafe worker's connected account. Dashboard ledger: escrow, fee, release, payout. |
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

Prompt 3 (keep the city: Eyes resolves the place before the safety check, so an address it cannot find returns `location_not_found` instead of the refusal):

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
| 0:50 | Vision slow: `vision_ok: false` with "Vision check unavailable" | The vision check gives up after 25 seconds and sends the task to review with escrow held. Same narration as GPS drift. |
| 1:00 | Stripe not live yet (`/healthz` says `payments: fake`) | Say it plainly: "payments are simulated on this deploy, so the release is a ledger row and no transfer is made." Point at the dashboard ledger's escrow and release rows, skip the Stripe tabs. |
| 1:00 | Payout pending: task stays `verified`, no transfer in Stripe | The platform had no available balance or the worker's Connect account is incomplete. Point at the release row in the dashboard ledger and the rehearsal transfer in Stripe. Then run the fund script: the server retries unpaid verified tasks every 30 seconds with a fresh Stripe idempotency key ([ADR-012](../intent/decisions/ADR-012-payout-retry-and-resolution.md)), so the transfer follows on its own once the balance is available or the worker finishes onboarding. |
| 1:08 | Owner console not loading | Skip the limit change. Ask Claude "What are my Eyes spend limits?" (`get_spend_policy`) and say "only the human can change these." |
| 1:15 | Claude declines without calling Eyes | Say "Claude won't even try; here is what Eyes tells an agent that does." Run the pre-typed curl below in a terminal tab. |
| 1:20 | No email reply in the inbox | Skip the beat; check `/healthz` says `email: live` and that Primitive staff enabled sending to any domain. |
| any | Server down | `curl /healthz`; `npx mcp-use deployments restart <id>` (PLAN §7); meanwhile play the backup video. |
| any | The API key showed on screen | Finish the beat. Off screen, in the owner console, tick the confirmation box and use "Replace this agent's API key": the old key stops working on the next request ([ADR-019](../intent/decisions/ADR-019-owner-key-rotation.md)). Remove and re-add the `eyes` MCP server in Claude with the new key before the next run. |

Pre-typed refusal curl (the key comes from the environment, so it never prints):

```sh
curl -s -X POST https://dark-wave-wfmpm.run.mcp-use.com/v1/tasks \
  -H "Authorization: Bearer $EYES_API_KEY" -H 'content-type: application/json' \
  -d '{"question":"Photograph the house at 123 Oak St","location":"Ferry Building, San Francisco","task_type":"photo_of_place","idempotency_key":"demo-refusal"}'
```

## Reset between runs

1. Let the last task reach `paid`, or tell Claude "Cancel that Eyes task" if it is still `dispatched`. A task left open keeps an offer pending on the workers' phones. A task that ended in `needs_review` holds its $3.50 until someone settles it: `pnpm resolve-task <task_id> refund "rehearsal"` with the server's environment (while payments are simulated the script also needs `EYES_PROVIDERS=fake`, because it refuses to resolve with fake payments under live mode) returns it to the demo agent ([ADR-012](../intent/decisions/ADR-012-payout-retry-and-resolution.md)); `release` instead pays the worker.
2. Start a new Claude conversation. A retry with an old `idempotency_key` and the same question returns the old task instead of asking again.
3. Owner console: set max bounty back to 10 and save.
4. Budget: each run spends $3.50 of the key's daily cap ($20 by default, per UTC day, which resets at 5 PM PDT). Check `get_spend_policy` shows `remaining_today_usd` of at least 3.50 and `get_balance` at least 3.50; raise the cap in the owner console or top up through `top_up_url` if not.
5. Stripe: platform available balance at least $3; rerun the fund script if lower.
6. Cafe worker back at the door with Messages open. Room phone untouched.
7. Send the next email thread with a new subject.
8. Dashboard needs nothing; reload the tab if the map drifted.
9. Note pass or fail and what broke. Three passes in a row is G3.
