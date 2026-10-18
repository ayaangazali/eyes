# ADR-017: `idempotency_key` is required on `ask_eyes`; `location_not_found` suggests places that resolve

Status: accepted (2026-10-17, orchestrator, T4.11a). Changes the frozen contract: `AskEyesInput.idempotency_key` goes from optional to required, with new description and error text. Changes the text of `ERRORS.location_not_found.fix`. No other type, default or bound changes.

## Context
- SPEC §9 says "`idempotency_key` on `ask_eyes`; all retries are safe", and `ask_eyes` is annotated `idempotentHint: true`, so MCP clients may retry it on their own. The key was optional: a retry without one created a second task and escrowed bounty plus fee again. The PM audit (2026-10-17) sent an `ask_eyes` without a key and it reached dispatch.
- The `location_not_found` fix suggested "Blue Bottle Coffee, 66 Mint St, San Francisco". Neither the fake geocoder nor the deployed server resolves that string, so an agent that followed the fix got `location_not_found` again and looped.

## Decision
1. `AskEyesInput.idempotency_key` is required: a string of 1 to 128 characters. A missing or non-string key fails validation with: "Required. Pass any unique string for each task you intend to create, for example a UUID, and send the same key again when you retry that task, so the retry returns the original task instead of charging twice." The description says the same and adds "Use a new key for a new question."
2. Where agents see that text:
   - MCP: the SDK validates the input schema before the tool runs and returns "Input validation error: ... idempotency_key: Required. Pass ...".
   - REST: `invalid_input` lists the field in `issues`. `apps/mcp` now appends each issue (`path: message`) to the generic `fix`, so the `fix` says what to pass.
   - Engine: `askEyes` already parses `TOOLS.ask_eyes.input`, so callers of the service need a key too.
3. Every caller passes a key: e2e specs, `evals/ax/run.ts`, `scripts/smoke-live.ts`, `scripts/swarm.ts` and the Primitive email route already did. The CLI still makes its own key: it validates and hashes the ask without the key (`AskEyesInput.partial({ idempotency_key: true })`), so existing pending-ask files keep their names. The engine and dashboard integration tests now pass `randomUUID()` in their `ask` helpers.
4. `location_not_found.fix`: 'Pass the coordinates as numbers, e.g. {"lat": 37.7955, "lng": -122.3937}; coordinates always resolve. Or pass "place name, city", e.g. "Ferry Building, San Francisco".' "Ferry Building, San Francisco" is in `FAKE_PLACES`, which `createNominatimGeo` checks before it calls Nominatim, so it resolves in both geocoders. Coordinates resolve in both as well.

## Alternatives rejected
- Generate a key on the server when none is sent: a client retry would get a new key, so it would still pay twice. This is the bug being fixed.
- Derive the key from a hash of the parameters: two real asks with the same question at the same place (a fresh line check an hour later) would return the old task.
- Put idempotency_key advice in the catalog `invalid_input.fix`: every invalid signup, quote or capture would then mention it.

## Consequences
- A client that never sent a key now gets a validation error with the fix instead of a task. Our own clients already send one.
- Tool schema snapshot regenerated (`required` gains `idempotency_key`). `llms-full.txt`, `openapi.json` and the agent card regenerated.
- REST `invalid_input` fixes now end with the failing fields and their messages; MCP schema errors were already plain text that named them.

## Addendum (T4.13, 2026-10-17)
- `idempotency_key` length errors get their own messages. Zod applies the schema-level `error` to the `.min(1)` and `.max(128)` checks too, so an agent that sent `""` or a 200-character hash was told the key is "Required" and nothing about the limit. Now `.min(1)` says "Must not be empty. Pass any unique string for each task, for example a UUID." and `.max(128)` says "At most 128 characters. Pass a shorter unique string, for example a UUID (36 characters)." The "Required. Pass any unique string ..." text stays for a missing or non-string key, as Decision 1 says. The JSON Schema (and the tool snapshot) does not change, because zod messages are not part of it.
- `ERRORS.owner_link_invalid.fix` no longer assumes a signup email: with email simulated none is sent, and since ADR-015 the Checkout payer gets the link in a top-up receipt. It now reads "Open the newest owner link you have: from the signup email, a top-up receipt, or the Eyes operator, who can make a fresh one." No code, status or type changes.

## Addendum (T4.22a, 2026-10-17)
The second PM walkthrough found agent and owner surfaces that still pointed the wrong way. Pre-approved contract text and limit changes, no new error code, status, type or migration:
- `ERRORS.daily_cap_exceeded.fix` names the real field, `daily_cap_usd` (it said `daily_cap`). When the key's daily cap is 0, the engine overrides that fix, and `quote_task` uses the same sentence in `reason_if_not`: "Your user froze spending on this API key by setting its daily cap to 0, so waiting for the daily reset will not help. Do not retry; ask your user to raise daily_cap_usd in their Eyes owner console." The old texts told a frozen key to lower the bounty or wait for midnight UTC, and neither ever works.
- `ERRORS.task_not_found.fix` adds "Lost it? Call list_tasks to see your tasks and their task_ids." (ADR-013).
- `OwnerPolicyInput.max_bounty_usd` maximum goes from 100 to 50, the `AskEyesInput.bounty_usd` maximum, so the console no longer saves a limit the agent can never use. Rows already above $50 are left alone: the agent's own schema caps every ask at 50 anyway, and the console asks for 50 or less on the next save.
- `fakePayments().createTopupCheckout` returns the `success_url` it is given with `simulated=1` added, instead of `https://checkout.fake.test/...`, which no browser can resolve. `GET /topup/done?simulated=1` says payments are simulated on this server, no money moved and nothing was added to the balance. The Stripe adapter is unchanged.
- `ask_eyes` reports `insufficient_balance` (with the numbers) instead of `no_workers_nearby` when both are true. `eyes_post_task` (002) still checks workers before balance; when it raises `no_workers_nearby`, the engine re-reads the balance and swaps the error if the bounty plus fee does not fit. Nothing was written in either case, so atomicity is unchanged. Rejected: a balance check before the RPC (an idempotent retry of a task that already escrowed would be refused, because the replay happens inside the RPC before any check), and a migration that redefines `eyes_post_task` to reorder two blocks (same outcome, a 60-line function copy, and a database change).

## Addendum: interactive confirmation (2026-10-18)

Interactive MCP `ask_eyes` prepares a read-only draft (`confirmation_required`) and never calls the dispatch service. The card's native app-only `confirm_ask` accepts the unchanged `AskEyesInput`; its existing `idempotency_key` identifies the intent. Repeated confirmations use the existing atomic task/escrow/offer transaction. A new intentional Ask Again requires a new key and explicit confirmation.

Interactive discovery projects `AskEyesDraftInput` and `AskEyesDraftOutput`, preserving input validators/defaults while describing payment and deadlines as conditional on later confirmation. Its output permits only `confirmation_required`, request fields and quote data, with no task or payment-result fields. The shared registered `AskEyesMcpOutput` validator still accepts the existing dispatch and no-worker responses for non-UI MCP and app-only confirmation. `TOOLS.ask_eyes.output`, the core service, REST and CLI remain dispatched-only. Public generation documents the preparation and dispatch contracts separately.

MCP Apps capability detection takes precedence. The legacy fallback recognizes only tested ChatGPT/OpenAI and Claude-User browser identifiers, not generic Claude names; Claude Code remains programmatic. Native app-only visibility plus OpenAI private visibility excludes the confirmation action from conforming hosts' model tools. This is not a cryptographic approval system and makes no guarantee about custom clients that ignore visibility. No database state, approval framework or content/time-window deduplication is introduced.

The card resource is revised to `ui://eyes/confirmation-card.html` because old HTML calls the former paid tool. Hosts must refresh tool metadata and render a new card; old messages are not retroactively changed. The new task's retry context preserves its original deadline duration and photo requirement. Classifier approval remains tied to its exact original key and is not carried into a new Ask Again intent.
