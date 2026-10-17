# ADR-018: Signup says an owner email was sent only when email delivery is live

Status: accepted (2026-10-17, orchestrator). Adds to the frozen contract: `email_delivery: z.boolean().default(false)` on `AppConfig`.

## Context
The fresh-eyes journey audit (scratchpad `verdicts/PM-journeys.md`, Journey 3 step 2 and promise R30) signed up with `owner_email` on the live deploy and got the next_step "We emailed your user at pm-review@example.com a private control link", while `/status` and `/healthz` said email was simulated. Nothing was delivered. The fake `Email` provider records the message in its outbox and resolves, so `emailOwner` returned true and the engine took the "emailed" branch. The engine had no way to tell a simulated send from a real one: `Providers.email` is the same interface either way, and `AppConfig` did not say which one was wired.

## Decision
- `AppConfig.email_delivery` (default `false`) says whether owner emails reach a real inbox. `apps/mcp/src/main.ts` sets it from `liveProviders(env).email`, the same decision that picks `createPrimitiveEmail` over the fake, so the flag and the wired provider cannot disagree on a deployed server.
- When it is false, signup with `owner_email` still sends through `providers.email` (the fake outbox is how tests observe the owner link), but next_step says owner email delivery is not set up on this server, nothing was sent to that address, and the user can get the control link from the Eyes operator, who creates it with `pnpm owner-link <agent_id>`. When it is true, next_step is unchanged. A send that throws still gets "We could not email your user" in both modes.
- `creditTopup` (ADR-015 payer email) needs no change: it returns nothing to the agent, the webhook answers `{ received: true }`, and a successful send is not logged, so no caller is told an email went out.
- Default `false`: a config built without the field (tests, scripts, evals) never claims a delivery it cannot make. Only the server entry point can turn it on.

## Alternatives rejected
- A `simulated` flag on the `Email` provider or on `send`'s result: a change to the provider interface and to both implementations (`packages/core/src/fakes.ts`, `packages/comms`) for a fact the entry point already knows.
- Skipping the send when delivery is off: the fake outbox is the only way integration tests and the demo harness read the owner link.

## Consequences
Every `AppConfig.parse` caller gets `email_delivery: false` without edits. A harness that wires a real `Email` provider but builds `AppConfig` itself must set `email_delivery: true`, or its agents are told no email was sent while one was.
