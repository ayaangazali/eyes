# ADR-038: Clear error codes

## Decision

Follow the defaults in issue #180 for issues #118 and #119.
Add `service_unavailable` (503), `not_found` (404), `method_not_allowed` (405), and `payload_too_large` (413) to the public error catalog.
REST responses and MCP errors use the same catalog.
A 405 response includes `Allow` with the supported methods.
The MCP endpoint supports GET, POST, and DELETE; ordinary GET routes also support HEAD through Hono.
Keep MCP protocol errors unrelated to these HTTP failures unchanged.

Mark an unavailable safety verdict explicitly instead of deriving availability from its category or message.
Return `service_unavailable` before dispatch or charge, including when a classifier approval exists.
Tell the agent to retry the same request and idempotency key after a short wait.
Keep `location_not_found` when the place cannot resolve and the classifier has no specific block.
Keep actual safety refusals as `unsafe_task`.

Tell agents to check task state after `task_not_cancellable`.
Only claimed or submitted tasks need `await_answer`; expired and refunded tasks need no cancellation.

## Consequences

Clients can distinguish a request change from a retry without parsing message text.
Unknown routes and unsupported methods no longer use `invalid_input`.
Oversized bodies keep the existing limits and photo-specific fix but use `payload_too_large`.
Refresh the error snapshot and generated OpenAPI and public documents together.
Do not change list_tasks paging in this decision.

Issue #118 item 2 already has the location-error precedence fix.
Item 3 already has a confidence threshold for named categories; low-confidence categories do not produce a misleading refusal.
This change completes the outage and cancellation guidance items.
