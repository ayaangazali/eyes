# ADR-044: Owner JSON API

Status: accepted for S02.

## Context

The Eyes app needs the owner console as data. The HTML console under `/owner/:token` is the only owner surface.

## Decision

Add JSON twins under the same owner link:

- `GET /owner/:token/state.json` returns the `OwnerConsole` view: agent, balance, spend policy, spent today, recent tasks and ledger.
- `GET /owner/:token/tasks.json` takes `status`, `limit` and `before` and returns `tasks` and `next_cursor` in the ADR-041 shape.
- `POST /owner/:token/policy.json` takes `OwnerPolicyInput` as JSON numbers and returns the saved policy.
- `POST /owner/:token/rotate-key.json` takes `{"confirm": true}` and returns `{"api_key"}`, shown once.

Each route calls the service with the URL token only: `ownerConsole`, new `ownerTasks`, `updateSpendPolicy`, `rotateApiKey`.
The token names the agent, so one owner token cannot read or change another owner (OWASP API1:2023).
An unknown token answers 401 `owner_link_invalid`; the HTML routes keep 404.
Invalid input answers 400 `invalid_input` with `issues`. All routes send `Cache-Control: no-store`.
State has no key list: the database stores only a key hash.

## Consequences

The routes are a public contract. Spend-policy changes (S03) must update `policy.json` with the form.
`ownerTasks` shares one query with `list_tasks`, so paging cannot drift.
