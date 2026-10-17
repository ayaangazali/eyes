# Submission draft

Draft text for the hackathon submission form. Lines marked **TODO** need facts that only exist once the vendor keys land and the live demo has run; fill them from [STATUS.md](../STATUS.md) "Live verification" and never ahead of it. Anything not live-verified there must say "on fakes in CI".

## Name

Eyes

## One-liner

Agents can read the internet but cannot see the street; Eyes lets any AI agent pay a nearby human about $3 to go and look, and returns a verified answer with a live photo.

## Links

- Repo: https://github.com/ayaangazali/eyes
- MCP server: https://dark-wave-wfmpm.run.mcp-use.com/mcp
- Worker JOIN page: https://7t6779x4.insforge.site
- **TODO** demo video: `<link>`
- **TODO** backup video (recorded during Phase 4): `<link>`

## Problem

Agents are good at anything that is already written down. They fail at questions about the physical world right now: is this store open, how long is the DMV line, is oat milk in stock at this Trader Joe's. Opening hours online are stale, stock data is missing, and no API knows how long a line is. A person standing nearby can answer in a minute, but an agent has no way to find that person, trust what they say, or pay them.

## What it does

Eyes is an MCP server where the agent is the customer and a nearby human is the API.

1. The agent calls `quote_task` to check coverage and price, then `ask_eyes` with a question, a place, a bounty (default $3) and a deadline. Eyes runs a safety check and escrows the bounty plus a $0.50 fee from the agent's prepaid balance.
2. Eyes texts up to three nearby workers over iMessage. The first to reply YES gets a capture link that opens the camera and reads GPS.
3. Eyes verifies the capture: within 150 m of the place, photo taken live before the deadline, and a vision model confirms the photo answers the question and shows no prominent faces.
4. The agent's `await_answer` call returns the answer, photo URL, distance, checks and a confidence score. The worker is paid $3 through Stripe Connect. If nobody answers, or the agent cancels before a claim, the full amount is refunded.

The agent's human stays in control: per-key max bounty, daily cap and allowed task types, a top-up link, and an owner console the agent never sees. Tasks about private people, homes, vehicles or anything that identifies a person are refused with an error that tells the agent how to rephrase: deterministic rules catch homes and home addresses, and a Claude classifier handles the subtler cases once `ANTHROPIC_API_KEY` is set (the deployed server runs the rules only today). Agents that live in an inbox can email their private Eyes address and get the answer back in the same thread with the photo attached.

## How we built it

- **Stack.** TypeScript on Node 24 in one pnpm workspace. The MCP server uses the mcp-use SDK and runs on Manufact Cloud from the repo Dockerfile. InsForge hosts Postgres, photo storage and the worker pages. Every money transition (escrow, release, refund, payout, fee) is one plpgsql function, so it is one transaction, and all amounts are integer cents.
- **Agent-first surface.** Nine tools whose descriptions are written for an LLM reader, each with an example and a "Next:" line. Every error carries a `fix` the agent can act on. `await_answer` long-polls in 55-second calls because agents cannot receive events in the background and some MCP clients time out long calls.
- **Built by an agent team with receipts.** One orchestrator ran builder and verifier agents, each builder in its own git worktree with a fixed set of files. Builders never graded their own work: spec, test, security and AX verifiers returned PASS or FAIL with evidence, and their verdicts are in `intent/verdicts/`. Every code file maps to an intent file that says why it exists and how it was verified, and CI fails a PR without one. Architecture decisions, including the ten places where vendor docs overrode our plan, are ADRs in `intent/decisions/`.
- **Tested on fakes, then live.** CI runs lint, typecheck, unit, contract, integration against real Postgres, a Playwright golden path (agent asks, worker claims, captures, agent gets the verified answer), safety rule fixtures, the intent check, a secrets scan and a build, all without secrets. Each sponsor integration is called working only after it has worked live once.
- **TODO** pre-event work disclosure: the repo's first commit is 2026-10-16 22:47 PT, before hacking began at 10:30 AM on Oct 17. Fill in the organizers' answer (STATUS.md "Needs from humans" item 9) and disclose what was prepared before the start if they ask for it.

## Sponsor tracks

### Manufact: Best MCP Server for Agents

The whole product is the MCP server: agents are the only customer, and the tool surface is the interface. It is built on mcp-use 2.10 with bearer auth, tool annotations, progress notifications during `await_answer`, and a REST mirror of the same capabilities, deployed on Manufact Cloud at `dark-wave-wfmpm.run.mcp-use.com`. We verified that the Manufact gateway forwards non-MCP paths, so webhooks, the worker API and the agent docs are served from the same deployment.

- **TODO** live fact: Claude ran quote_task, ask_eyes and await_answer against the Manufact URL with live providers on `<date/time>`; Manufact dashboard shows `<n>` sessions.

### InsForge: Agent-Native Cloud

InsForge is the backend for everything stateful. Postgres holds the escrow ledger, the race-safe first-YES claim and task expiry as plpgsql functions called over InsForge RPC, with RLS on every table; the photos land in an InsForge storage bucket; and the JOIN and capture pages are hosted on InsForge Sites. This is live-verified for the database and Sites: signup, balance and spend policy on the deployed server are served from InsForge Postgres, and the worker pages are live at `7t6779x4.insforge.site`.

- **TODO** live fact: first live capture stored in the `photos` bucket on `<date/time>`.

### Armature: Best Agent Experience (AX)

An agent can go from nothing to a verified answer without a human dashboard: `POST /v1/signup` returns an API key, a test balance and a funding link for its human. Every refusal is `{error, message, fix}` with the numbers the agent needs (how far to lower the bounty, how much cap is left today); only MCP schema mismatches come back as plain text naming each bad field. Tool descriptions tell the agent what to call next, and `ask_eyes` requires an `idempotency_key`, so every retry is safe. `llms-full.txt`, `openapi.json` and an agent card are generated from the same frozen schemas, the `eyes` CLI validates with them, and the docs, starting with the hand-written `llms.txt`, are served live from the deployed server at https://dark-wave-wfmpm.run.mcp-use.com/llms.txt.

- **TODO** live fact: AX verifier agent completed signup, ask and answer from public docs only on `<date/time>`; Armature analytics or eval run `<link>` (wiring waits on Armature's answer about mcp-use support).

### Primitive: Best Agent Communication Setup with Primitive.dev

Each agent gets its own Eyes email address at signup, a capability address with an HMAC in the local part, so knowing the address is the authorization and a spoofed From header is not. An agent emails a question (with a `Location:` line), Eyes posts the task and replies in the same thread when the verified answer arrives, with the worker's photo attached. Only DMARC-verified senders are processed and replies go only to the authenticated From address, so Eyes cannot be used as an open relay.

- **TODO** live fact: an agent emailed its Eyes address and received a threaded reply with the photo attached on `<date/time>`.

### Inkbox

Eyes' dispatcher is an Inkbox identity with an iMessage line: it sends the offer, receives the YES claim, sends the capture link and the paid confirmation. We followed Inkbox's rules: workers opt in by texting START, the first message has no link and is at most 159 characters, and the inbound `imessage.received` webhook is signature-verified. The offer never includes the agent's question, so no free text from an agent reaches a stranger's phone before they claim.

- **TODO** live fact: teammate iPhone received a live offer, replied YES and got the capture link on `<date/time>`.

### Stripe

The agent spends money for a resource it cannot get any other way, and its human sets the rules. Humans fund the agent through Stripe Checkout; each key has a max bounty, a daily cap and allowed task types that `ask_eyes` enforces with fixable errors; an owner console the agent never sees changes those limits or freezes spending (ADR-011). The bounty is escrowed on ask, paid to the worker's Connect Express account as a $3 transfer only after verification, and refunded on expiry or cancel.

- **TODO** live fact: Checkout top-up credited the balance and a verified answer created a $3 transfer visible in the Stripe dashboard (test mode) on `<date/time>`.

### Blaxel: Something a Human Would Never Want

- **TODO** enter only if T3.5b ships (eval agents in Blaxel sandboxes and a simulated agent swarm on the dashboard). Otherwise delete this section.

## What's next

- Android and SMS workers. The iMessage line was chosen for cost, so workers need an iPhone today.
- Per-key and per-link revocation, and withdrawing unused balance back to the card ([#28](https://github.com/ayaangazali/eyes/issues/28), [#29](https://github.com/ayaangazali/eyes/issues/29)).
- A worker earnings page and a way for workers to report a task ([#33](https://github.com/ayaangazali/eyes/issues/33), [#34](https://github.com/ayaangazali/eyes/issues/34)).
- Expiry and refunds run on a schedule outside the server process ([#31](https://github.com/ayaangazali/eyes/issues/31)).
- Recurring checks ("tell me when the line is under 5 people") built on the same escrow and verification.

## Team

- Ayaan: agent experience, safety, dashboard, demo and pitch.
- Jerry: engine, MCP server, payments, verification.
- Shryuk: messaging, worker web, Primitive email.
