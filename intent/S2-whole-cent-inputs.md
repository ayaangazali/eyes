---
task: S2
title: Reject sub-cent bounty and policy inputs
files:
  - packages/core/src/util.ts
  - packages/core/src/util.cents.test.ts
  - packages/engine/src/index.ts
  - intent/decisions/ADR-042-whole-cent-inputs.md
status: done
---

## Why

Issue #117 reports that rounding caller amounts silently changes bounties and policy limits.
Reject sub-cent inputs before money conversion.
Keep the contributor's validation approach and tests.

## What changed

Validate bounty and policy amounts before converting USD to cents.
Preserve the input type when validation returns the unchanged value.
Use `EyesError` with `invalid_input` so invalid amounts return HTTP 400.
Keep the existing rounding behavior for amounts outside these input boundaries.

## Verification

Run the core amount unit tests and contract tests.
Run the engine integration tests with the isolated test database.
Run lint, typecheck, the intent check, and the Sentrux gate.
