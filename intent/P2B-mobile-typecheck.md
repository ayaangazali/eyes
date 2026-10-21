---
task: P2B
title: Typecheck the mobile app in CI
files:
  - .github/workflows/ci.yml
  - apps/mobile/tsconfig.json
  - CONTRIBUTING.md
  - intent/INDEX.md
status: done
---

## Why

Issue #224 requests a mobile typecheck gate without changing app behavior.
The isolated mobile install cannot resolve the root-only Vitest imports in three test files.
The root Vitest unit project already runs these tests.
Exclude them from the app tsconfig instead of adding another test dependency.
These test files run without typechecking; the new gate checks app code only.

## What changed

Add a `mobile-typecheck` job with the same documentation-only skip as the root typecheck job.
Install only `apps/mobile` with `npm ci`, then run `npm run typecheck` there.
Keep the app source in the typecheck and keep mobile tests in the root unit suite.
No app code, dependency, release configuration, or core contract changes.

## Verification

The task reports three TS2307 errors and a TS7031 error before this change.
Use a copy outside the repository to run the isolated install and mobile typecheck.
The new CI job preserves this regression check on future changes.
Inject an invalid type in the copy's `App.tsx` and verify that the compiler rejects it, then restore the file.
Run the three mobile unit files, core contract tests, and location integration tests.
Run root lint and typecheck, actionlint, the intent check, and the Sentrux gate.
