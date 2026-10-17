# ADR-010: Which verifier findings block a merge

Status: accepted by the humans (2026-10-17, ~01:00 PT). Supersedes "blockers and majors must be fixed before merge" in SPEC §3 for the rest of the event.

## Context
Four PRs (#7, #9, #11, #14) each failed verification three times. About half of the late failures were defense-in-depth edges (log formatting, regex performance on authenticated input), while the money, auth and data paths were already verified.

## Decision
Blocking (must be fixed before merge), whatever severity a verifier assigns:
- money: escrow, ledger, payouts, idempotency
- auth and secrets
- data integrity
- safety and abuse classifier
- the demo path (SPEC §13)

Non-blocking (merge, then a follow-up PR): defense-in-depth edges such as log formatting, performance on authenticated input, and hardening of already-guarded paths.

For every deferred finding, right away: open a follow-up PR or GitHub issue, list it in STATUS.md under "Deferred", and add it to the task's intent file under Known gaps. All deferred items are triaged at feature freeze (6:00 AM Sunday).

## Consequences
Verifier prompts classify each finding as blocking or deferrable under this rule. The orchestrator records the classification in intent/verdicts/.
