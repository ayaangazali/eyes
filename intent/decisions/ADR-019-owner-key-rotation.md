# ADR-019: Owners replace a leaked agent API key from the owner console

Status: accepted (2026-10-17, orchestrator). Adds to the frozen contract: `EyesService.rotateApiKey(token)` returning `{ api_key }`, and route `owner_rotate_key: "POST /owner/:token/rotate-key"`.

## Context
A leaked `api_key` lets anyone spend the agent's balance up to its limits. Today the only way to kill it is to rotate `EYES_LINK_SECRET`, which also breaks every top-up, owner, payout and capture link and every capability email address for every agent (issue #28). The owner console (ADR-011) is already the per-agent control surface the agent cannot reach, so it is the right place for a per-agent key replacement.

## Decision
- `rotateApiKey(token)` accepts only a verified `p:` owner token, with the same check as `ownerConsole` and `updateSpendPolicy`; `t:`, `o:`, `c:`, malformed and unknown-agent tokens throw `owner_link_invalid` (404).
- The engine makes the new key exactly as `signupAgent` does (same `eyes_test_` / `eyes_live_` prefix rule, 32 random bytes, SHA-256 hash), stores only the hash and returns the key once.
- `011_rotate_key.sql` adds one RPC, `eyes_rotate_api_key(agent_id, api_key_hash)`, that overwrites `agents.api_key_hash` for that agent. No new tables or columns; EXECUTE is revoked from `public`, `anon` and `authenticated` like 002 to 010.
- The old key fails `authenticate` on the next request: auth reads the agent row by key hash on every REST and MCP call, with no cache.
- Two concurrent replacements serialize on the row lock, so the later write wins and exactly one key works; each owner sees a key, and the one shown last is the valid one.
- The console has a "Replace this agent's API key" form that warns the old key stops working at once. `POST /owner/:token/rotate-key` answers 200 with a page that shows the new key once (HTML-escaped, under the `/owner/*` no-store, no-referrer and CSP headers). No GET has a side effect, the key is never put in a URL or redirect, and nothing logs it.

## Alternatives rejected
- A token generation counter on `agents` checked on every link verify (the issue's suggestion): needs a new column and a contract change to `verifyToken`, and also revokes links. This ADR covers only the API key.
- Redirect to a GET page that shows the key: the key would have to live in a URL or in new server state.
- Let the agent rotate its own key: whoever holds the leaked key could then lock the real agent out.

## Consequences
Capability links are unchanged: the owner link, the top-up link and the agent's capability email address (ADR-007) are derived from `EYES_LINK_SECRET` and the agent id, so they still work after a key replacement, and a leaked one still needs the secret rotated (the rest of #28). The agent cannot use Eyes until its owner gives it the new key. Reloading the result page re-posts the form and replaces the key again, which the browser asks to confirm.

## Issue #28 disposition (2026-10-27)

[Issue #180](https://github.com/ayaangazali/eyes/issues/180) sets the default for #28: defer per-agent revocation of capability emails and owner links.
The owner has not supplied a different decision.
The existing API-key replacement remains supported and revokes only that agent's old key.
REST requests and requests from an already connected MCP client must reject the old key.
Other agents keep their keys, and the existing owner link remains usable.

Issue #28 closes with the API-key part implemented and the capability-link part explicitly deferred, not implemented.
A leaked owner link or capability email address still requires rotating `EYES_LINK_SECRET`, which invalidates all links signed with that secret.
Reopen the capability-link work when the owner changes this default; do not treat API-key replacement as link revocation.
