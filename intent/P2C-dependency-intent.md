---
task: P2C
title: Accept dependency-only updates without intent
files:
  - scripts/check-intent.ts
  - scripts/check-intent.test.ts
  - CONTRIBUTING.md
  - docs/SPEC.md
  - intent/INDEX.md
status: done
---

## Why

Issue #223 reports that dependency-only updates fail the intent check.
Accept modified package manifests and lockfiles when manifest edits only change existing dependency version strings.
Use the diff content rather than the author or a token.
Keep the existing governed paths for dependency additions, removals, source changes, scripts, and code.
Leave root release metadata outside those paths.

## Verification

Run the checker against temporary Git repositories with dependency updates, script changes, mixed code changes, and dependency additions.
The dependency update regression failed before the fix.
Run focused unit tests, lint, typecheck, the intent check, and Sentrux.
Replay the exact four-file diff from https://github.com/ayaangazali/eyes/pull/206 without an intent file.
Check that a dependency source replacement still requires intent.
