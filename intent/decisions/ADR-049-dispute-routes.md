# ADR-049: Dispute routes for workers and owners

Status: accepted

## Decision

Add `POST /owner/:token/tasks/:task_id/dispute {reason}` and `POST /w/me/tasks/:task_id/dispute {reason}`.
The owner route uses the owner console token and the same engine path as `POST /v1/tasks/:task_id/dispute`.
A second owner dispute on one task is 409 `task_not_disputable`. The agent route keeps its quiet repeat.
A task of another owner is 404 `task_not_found`. A bad owner link is 401.
The worker route uses the `e:` token. It contests an open or upheld owner dispute on the worker's own task, once.
It opens one `manual_review` ticket with `tickets.appeal = true` (migration 048), so ops uses the existing HELP actions.
`eyes_dispute_states` gives the state: `open`, `in_review` (an appeal ticket is open), `stands` (rejected) or `upheld` (refunded).
`list_tasks`, owner `tasks.json` and `/w/me/tasks` items gain `dispute`, the state or null.
Both routes allow 10 calls an hour per token.

## Consequences

The app shows dispute state to both sides. Ops needs no new ticket kind.
A worker cannot contest a dispute that ops rejected. One appeal per task is final.
`dispute` is a new required key in three outputs; clients that ignore unknown keys keep working.
