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
