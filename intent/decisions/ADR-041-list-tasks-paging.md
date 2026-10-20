# ADR-041: Stable task-list paging

Status: accepted for C3, issue #119.

## Context

The first 50 tasks were the only tasks that `list_tasks` could return.
This change follows the default in issue #180.

## Decision

Add an optional `before` cursor and a required nullable `next_cursor`.
The cursor is the last returned task's UUID; clients pass it unchanged.
Postgres resolves its exact `created_at` and compares `(created_at, id)` in descending order.
This preserves timestamp precision and orders tasks with equal timestamps.
Both the cursor lookup and the returned rows belong to the authenticated agent.
Unknown or foreign cursors return an empty page.
Clients retain the same status filter when they request the next page.

Fetch one extra row to distinguish a full final page from a page with more results.
Add an `(agent_id, created_at desc, id desc)` index.
Replace the old three-argument database function in append-only migration `044_list_tasks_paging.sql`.
Keep its public, anonymous, and authenticated execution restrictions.

MCP, REST, and the CLI share the same input schema and engine query.
Only CLI requests with a body send the JSON content type.
This lets a bodiless task-list request reach the Hono route without a JSON parse error.

## Consequences

The response gains `next_cursor`; existing task fields and page-size limits do not change.
Paging is not a snapshot: a task whose status changes can enter or leave a filtered list.
Deleting the cursor task ends that traversal; task deletion is not an exposed operation.
The API and migration need a coordinated cutover; an older API cannot call the replaced three-argument function.
Rolling back only the API is not supported after this migration.
Offset paging and serialized timestamps are unnecessary.
