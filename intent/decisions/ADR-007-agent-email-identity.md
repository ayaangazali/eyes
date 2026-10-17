# ADR-007: Agent email identity for the Primitive track

Status: accepted (Phase 3 prep, 2026-10-17). Notified: engine-builder (T1.2), mcp-builder (T1.1), ax-builder (T3.2), comms-builder (T3.1).

## Context
SPEC §1 Primitive track: agents get an Eyes email identity, email questions to Eyes and get threaded answers with the photo attached. The Primitive note (docs/vendor/primitive.md) says the subdomain is auto-assigned, any local-part works, and routing is per domain. Email `From` headers are spoofable, so the sender address cannot authenticate an agent.

## Decision
1. Each agent's Eyes address is a capability address: `ask+<agent id hex>-<16-char HMAC>@<PRIMITIVE_DOMAIN>`, built and checked by `agentEmailAddress` / `agentIdFromEmailAddress` in `@eyes/core` with `link_secret`. Knowing the address is the authorization, like an API key; the local part stays under 64 characters.
2. `SignupOutput.email_address` (nullable: null when no email domain is configured) returns it once at signup. `AppConfig.email_domain` carries the domain (`PRIMITIVE_DOMAIN`).
3. `EyesService.agentById(id)` lets the inbound email route resolve the agent after verifying the address.
4. Threaded replies need no new storage: the inbound route creates the task with `askEyes`, then a background loop calls `awaitAnswer` until answered or terminal and replies in-thread with `Email.send` (`in_reply_to`, `references`, photo attachment). A server restart drops pending email replies; the agent can still use MCP or REST, and the gap is recorded.
5. `LocationInput` description gains a numeric `{lat, lng}` example (ax review of PR #2).

## Consequences
Engine implements `agentById` and fills `email_address`. Generated agent docs (T3.2) regenerate. Worker email replies with attachments (SPEC §1) are out of scope: workers are reached by text only.
