# ADR-049: Open-ended spend limits

Status: accepted for S03.

## Context

The owner could set only a daily cap of 0 to 1000 USD and a max bounty. An owner could not say "no limit", pick a longer window, or choose what happens at the limit.

## Decision

- `agents.daily_cap_cents` and `agents.max_bounty_cents` may be null. Null means no limit.
- `agents.cap_period` is `day`, `week` or `month`, default `day`. A window starts at 00:00 UTC, on Monday, or on the 1st.
- `agents.at_limit` is `ask`, `pause` or `notify`, default `ask`.
- Migration 048 changes defaults for nothing: existing rows keep their values, a day window and `ask`.
- `eyes_spent_today` sums the spend since the start of the agent's current window. The name and the `spent_today_usd` field stay, so agent clients do not break; the field means "spent this period".
- `daily_cap_usd` and `max_bounty_usd` in `get_spend_policy`, the owner form and `policy.json` accept null. A bounty stays capped at 50 USD (ADR-042 whole cents still applies; the cap has no upper bound but 10,000,000 USD).
- A cap above 0 must cover one request: the max bounty plus the fee. Otherwise the save fails with 400 `The weekly total is less than one request.` (`daily` or `monthly` for the other periods). A cap of 0 still freezes spending.
- `policy.json` and the form treat an omitted `cap_period` or `at_limit` as "keep the stored value".
- At the limit every mode refuses the task with `daily_cap_exceeded`. `pause` tells the agent not to retry until the window resets or the owner raises the cap. `ask` and `notify` tell the agent to ask its user.

## Consequences

The owner push or message for `ask` and `notify` is not sent yet; the app slice that shows "limit reached" reads `at_limit` from `state.json`.
The field name `daily_cap_usd` stays although the window can be a week or month. A rename would break every deployed agent.
The migration drops and recreates `eyes_agent_summary`, `eyes_owner_console` and `eyes_update_spend_policy`, and replaces `eyes_post_task`.
