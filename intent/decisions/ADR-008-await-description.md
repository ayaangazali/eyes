# ADR-008: `timeout_seconds` description names the stop statuses

Status: accepted (2026-10-17). Description-only change to a frozen schema; no type, default or bound changed.

## Context
PR #9 round 2 ax review: the `AwaitAnswerInput.timeout_seconds` description said "Call again if answered is false", which contradicts the stop rule for `expired`, `refunded` and `disputed` (all return `answered: false`). The text is generated into openapi.json and llms-full.txt, so agents read it.

## Decision
"Call again while answered is false and the status is dispatched, claimed or submitted; stop on expired, refunded or disputed."

## Consequences
Tool schema snapshot regenerated; the generated agent docs (T3.2) regenerate on their next merge with main.
