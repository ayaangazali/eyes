# Submission draft

Draft text for the hackathon submission form. Lines marked **TODO** need facts that only exist once the vendor keys land and the live demo has run; fill them from [STATUS.md](../STATUS.md) "Live verification" and never ahead of it. Anything not live-verified there must say "on fakes in CI".

Current publication status: Marketplace 1.0.3 is a configured draft with preflight complete, **not submitted or published**. Legal owner attestations and test-mode limits remain. ChatGPT and Claude are configured at the dedicated MCP host; follow-up visual checks on the operator's test accounts were quota-blocked on 2026-10-18, not a general client limitation.

## Name

Eyes

## One-liner

Agents can read the internet but cannot see the street; Eyes lets any AI agent pay a nearby human about $3 to go and look, and returns a verified answer with a live photo.

## Links

- Repo: https://github.com/ayaangazali/eyes
- Live MCP server: https://mcp.eyes.pictures/mcp — ChatGPT and Claude use this host; legacy `https://api.eyes.pictures/mcp` remains supported. REST, uploads and webhooks stay on `https://api.eyes.pictures`.
- Worker JOIN page: https://app.eyes.pictures
- **TODO** demo video: `<link>`
- **TODO** backup video (recorded during Phase 4): `<link>`

## Problem

Agents are good at anything that is already written down. They fail at questions about the physical world right now: is this store open, how long is the DMV line, is oat milk in stock at this Trader Joe's. Opening hours online are stale, stock data is missing, and no API knows how long a line is. A person standing nearby can answer in a minute, but an agent has no way to find that person, trust what they say, or pay them.

## What it does

Eyes is an MCP server where the agent is the customer and a nearby human is the API.

1. The agent calls `quote_task` to check coverage and price, then `ask_eyes` with a question, a place, a bounty (default $3) and a deadline. Eyes runs a safety check and escrows the bounty plus a $0.50 fee from the agent's prepaid balance.
2. Eyes texts up to three nearby workers over iMessage. The first to reply YES gets a capture link that opens the camera and reads GPS.
3. Eyes verifies the capture: within 150 m of the place, photo taken live before the deadline, and photo moderation rejects only confirmed graphic gore or explicit sexual/adult content. Ordinary public photos and incidental faces are allowed; uncertain content alone passes, while provider failures require review. Eyes does not judge whether the answer is correct; the agent evaluates the answer and can dispute it.
4. The agent's `await_answer` call returns the answer, photo URL, distance and checks. `accept_answer` records the user's positive feedback; it is not required for payment and does not move money. Stripe's provider integration is live, but payments and the $20 signup credit are test-only: no real money moves.

The agent's human stays in control: per-key max bounty, daily cap and allowed task types, a top-up link, and an owner console the agent never sees, where they change the limits, freeze spending, add funds or replace a leaked API key. An agent that lost a `task_id` finds it with `list_tasks` instead of paying twice, `quote_task` suggests a bounty `ask_eyes` will accept, and the server's `/status` page says which parts are simulated.

Workers reply YES to claim, NO to give a claimed task back (it is offered again to idle workers), STOP and START to opt out and back in, and HELP for a reply with a private link to their page: setup steps and every task they did, with totals and search.

Current task safety is Clef-first with Claude fallback on provider failure. The following paragraph records the historical 2026-10-17 safety measurement, not the current classifier implementation:

Tasks about private people, homes, vehicles or anything that identifies a person are refused with an error that tells the agent how to rephrase: deterministic rules catch homes and home addresses, and a Claude classifier handles the subtler cases. Both are live on the deployed server: on 2026-10-17 it refused "the woman in the red jacket" and "whether my ex is working the register" with reasons the classifier wrote. In `pnpm safety:eval` (also run in CI), the same rules and classifier blocked all 106 unsafe tasks among 200 labelled ones (recall 1.000, precision 0.946; 6 safe tasks over-blocked). Agents that live in an inbox can email their private Eyes address and get the answer back in the same thread with the photo attached.

## How we built it

- **Stack.** TypeScript in one pnpm workspace. The actual MCP/API server uses the mcp-use SDK and is hosted on Manufact Cloud as `eyes-prod`, origin `https://warm-spark-aocdd.run.mcp-use.com`. Cloudflare forwards `mcp.eyes.pictures`, `api.eyes.pictures` and the ops host; it hosts the static landing and worker app. The public MCP URL is https://mcp.eyes.pictures/mcp; REST stays at https://api.eyes.pictures. InsForge hosts Postgres and photo storage. Every money transition is one plpgsql function, and amounts are integer cents.
- **Agent-first surface.** Thirteen tools (twelve plus `show_task`, which draws the task as an MCP App card), including `accept_answer` for persisted positive feedback and `report_classifier` and `get_classifier_report` for internal review of incorrect blocks. Every error carries a `fix` the agent can act on. `await_answer` long-polls in 55-second calls because agents cannot receive events in the background and some MCP clients time out long calls.
- **Built by an agent team with receipts.** One orchestrator ran builder and verifier agents, each builder in its own git worktree with a fixed set of files. Builders never graded their own work: spec, test, security and AX verifiers returned PASS or FAIL with evidence. Every merged PR has at least one verdict file. Every code file maps to an intent file that says why it exists and how it was verified, and CI fails a PR without one. Architecture decisions are 20 ADRs in `intent/decisions/`, including the ten places where vendor docs overrode our plan.
- **Adversarial review where money moves.** Verifiers write race and retry tests that try to make the money paths pay twice. Payout recovery (PR #57) failed two rounds, on an unknown transfer outcome and on a rate-limit answer read as a refusal, and passed the third after 1315 retry sequences with no double pay outside one accepted case. ADR-010 decides what blocks a merge (money, auth and secrets, data integrity, the safety classifier, the demo path); everything else merges with a tracked follow-up issue, because four early PRs had each failed three rounds, about half of it on defense-in-depth edges.
- **Tested on fakes, then live.** CI runs lint, typecheck, unit, contract, integration against real Postgres, a Playwright golden path (agent asks, worker claims, captures, agent gets the verified answer) and the demo rehearsal, the AX eval, safety rule fixtures, the intent check, a secrets scan and a build, all without secrets. Each sponsor integration is called working only after it has worked live once.
- **TODO** pre-event work disclosure: the repo's first commit is 2026-10-16 22:47 PT, before hacking began at 10:30 AM on Oct 17. Fill in the organizers' answer (STATUS.md "Needs from humans" item 9) and disclose what was prepared before the start if they ask for it.

## Sponsor tracks

### Manufact: Best MCP Server for Agents

The product is the MCP server, built with mcp-use and hosted on Manufact Cloud at `https://warm-spark-aocdd.run.mcp-use.com`. Cloudflare forwards the dedicated MCP, REST and ops hosts; it is not the application host. ChatGPT and Claude are configured at `https://mcp.eyes.pictures/mcp`; REST, uploads and webhooks remain at `https://api.eyes.pictures`. The optional gateway stays separate. Current host metadata/API verification does not claim fresh quota-blocked in-chat visuals.

- Live fact (2026-10-17 10:27 PT): Claude (claude-sonnet-5-5, through the Anthropic API's MCP connector) ran quote_task, get_spend_policy, ask_eyes and await_answer against the Manufact URL with live vision, safety and storage. No phone was on hand, so the worker side was a stand-in that sent signed webhooks; Claude got the needs_review result and told its user the answer was unconfirmed.
- **TODO** live fact: Manufact dashboard shows `<n>` sessions.

### InsForge: Agent-Native Cloud

InsForge is the backend for persistent application data. Postgres holds escrow, claims, re-offers, payout leases and task expiry in transactional functions with RLS. Photos land in InsForge storage; faces alone do not cause rejection or deletion. Current moderation rejects confirmed graphic gore or explicit sexual content, separately from task-request privacy rules. The worker app is https://app.eyes.pictures on Cloudflare; earlier Sites and face-deletion observations below are historical, not the current policy.

- Live fact (2026-10-17): the first live capture (from the stand-in worker, a Wikimedia Commons photo) was stored in the `photos` bucket at 10:24 PT, and at 10:27 PT a photo the vision check rejected for showing a face was deleted from it (no object left under that task).

### Armature: Best Agent Experience (AX)

An agent can go from nothing to a verified answer without a human dashboard: `POST /v1/signup` returns an API key, a test balance and a funding link for its human. Every refusal is `{error, message, fix}` with the numbers the agent needs (how far to lower the bounty, how much cap is left today); only MCP schema mismatches come back as plain text naming each bad field. Tool descriptions tell the agent what to call next, and `ask_eyes` requires an `idempotency_key`, because MCP clients may retry a call on their own and a retry without one used to escrow the money twice (ADR-017). `quote_task` used to say yes to tasks `ask_eyes` then refused; now its suggested bounty already fits the key's limits and balance (ADR-013). `list_tasks` lets an agent that lost a `task_id` after a context reset find its open task instead of asking and paying again. The server's `/status` page says which providers are simulated, whether the safety review is rules only, and which demo places resolve while place lookup is simulated, so an agent is not left waiting on a task no real worker can see. `pnpm ax:eval` runs a scripted agent through the golden path against the real server code on every CI run, graded in code (quote before ask, a key on every ask, exactly one escrow, the unsafe task refused); with `ANTHROPIC_API_KEY` set, a Claude client (claude-haiku-5-5) runs the same three tasks. Locally on 2026-10-17 it passed all three on its second run; on the first it once declined to pass on the eval's placeholder photo link. CI runs the scripted client only. `llms-full.txt`, `openapi.json` and an agent card are generated from the same frozen schemas, the `eyes` CLI validates with them, and the docs, starting with the hand-written `llms.txt`, are served live from the deployed server at https://api.eyes.pictures/llms.txt.

- **TODO** live fact: AX verifier agent completed signup, ask and answer from public docs only on `<date/time>`; Armature analytics or eval run `<link>` (wiring waits on Armature's answer about mcp-use support).

### Primitive: Best Agent Communication Setup with Primitive.dev

Each agent gets its own Eyes email address at signup, a capability address with an HMAC in the local part, so knowing the address is the authorization and a spoofed From header is not. An agent emails a question (with a `Location:` line), Eyes posts the task and replies in the same thread when the verified answer arrives, with the worker's photo attached. Only DMARC-verified senders are processed and replies go only to the authenticated From address, so Eyes cannot be used as an open relay. Each agent address handles at most 20 emails an hour, and the owner emails Eyes sends name the agent only by its id, so no agent-chosen text rides along in mail to a human.

Current outbound evidence is limited: Primitive DNS is verified and one owner Gmail delivery succeeded. Unrestricted domain sending remains disabled, first-contact delivery can fall back to Inkbox, and external custom-alias SPF remains unresolved.

- **TODO** live fact: an agent emailed its Eyes address and received a threaded reply with the photo attached on `<date/time>`.

### Inkbox

Eyes' dispatcher is an Inkbox identity with an iMessage line: it sends the offer, receives the YES claim, sends the capture link and the paid confirmation. We followed Inkbox's rules: workers opt in by texting START (on Inkbox's shared line a worker first texts `connect @hackathon`, and the JOIN page shows both steps), the first message has no link and is at most 159 characters, and the inbound `imessage.received` webhook is signature-verified. The offer never includes the agent's question, so no free text from an agent reaches a stranger's phone before they claim.

Workers can run their side by text alone. STOP gets one confirmation and then silence until START. HELP gets a short explanation plus a private link to the worker's page (setup and every task, searchable), and so does every paid text; links go only in replies to a worker who has already texted us, never in a cold offer. NO after YES gives the task back and re-offers it to the other offered workers who are idle, at most once each per task, so a worker cycling YES and NO cannot spend the line's daily send budget on texts to other people.

- **TODO** live fact: teammate iPhone received a live offer, replied YES and got the capture link on `<date/time>`.

### Stripe

The agent spends money for a resource it cannot get any other way, and its human sets the rules. Humans fund the agent through Stripe Checkout; each key has a max bounty, a daily cap and allowed task types that `ask_eyes` enforces with fixable errors; an owner console the agent never sees changes those limits or freezes spending (ADR-011). The bounty is escrowed on ask, paid to the worker's Connect Express account as a $3 transfer only after verification, and refunded on expiry or cancel.

User control, and who holds it:

- Once email delivery is live, the owner link is emailed to the signup `owner_email` and to the first person who pays through Checkout (ADR-015 as amended). A card payment is the one step an agent cannot fake. Only the first payer gets it, because the top-up link is agent-visible and anyone who paid through it would otherwise take control of a balance someone else funded.
- A leaked API key is replaced from the owner console; the old key stops working on the next request and every link keeps working (ADR-019). Before, the only way to kill a key was a secret rotation that broke every link for every agent.
- While payments run on test fakes, the Stripe webhook route answers 404, so the fake's public test signature cannot be used to credit a balance (PR #56).

Money that is owed always moves:

- Stripe does not retry failed transfers, so Eyes does, every 30 seconds, with a fresh idempotency key per attempt. Reusing one key would replay a refused transfer's error for about 24 hours. A per-task lease and a lookup of existing transfers before each attempt keep retries from paying twice (ADR-012).
- Escrow held for review is settled by an operator script that refunds the agent or pays the worker. It is never an agent tool, so an agent cannot settle its own dispute.

- **TODO** live fact: Checkout top-up credited the balance and a verified answer created a $3 transfer visible in the Stripe dashboard (test mode) on `<date/time>`.

### Blaxel: Something a Human Would Never Want

- **TODO** enter only if T3.5b ships (eval agents in Blaxel sandboxes and a simulated agent swarm on the dashboard). Otherwise delete this section.

## What's next

- Android and SMS workers. The iMessage line was chosen for cost, so workers need an iPhone today.
- Per-link revocation for owner links and agent email addresses (API keys can already be replaced), and withdrawing unused balance back to the card ([#28](https://github.com/ayaangazali/eyes/issues/28), [#29](https://github.com/ayaangazali/eyes/issues/29)).
- An owner link that never goes to an address the agent picks, and a masked owner email on the top-up page so a payer can see who controls the agent ([#38](https://github.com/ayaangazali/eyes/issues/38), [#54](https://github.com/ayaangazali/eyes/issues/54)).
- A way for workers to report a task ([#34](https://github.com/ayaangazali/eyes/issues/34)).
- Expiry and refunds run on a schedule outside the server process, and money or dispatch failures raise an alert instead of only a log line ([#31](https://github.com/ayaangazali/eyes/issues/31), [#30](https://github.com/ayaangazali/eyes/issues/30)).
- Recurring checks ("tell me when the line is under 5 people") built on the same escrow and verification.

## Team

- Ayaan: agent experience, safety, dashboard, demo and pitch.
- Jerry: engine, MCP server, payments, verification.
- Shryuk: messaging, worker web, Primitive email.
