---
task: R4
title: Move shared UI sources under src
files:
  - packages/ui/**
  - apps/web/dashboard/src/server.ts
  - apps/mobile/App.tsx
---

## Why

Keep the shared UI package consistent with the other packages by placing its sources and tests under `src/`.
This closes issue #230 without changing public imports or rendered pages.

## Changes

Move the eight source and test files with `git mv`.
Keep `package.json` and `README.md` at the package root.
Update the export targets, dashboard file reads, and mobile source reference.
Keep historical intent records unchanged and regenerate the index with the new source paths.
The package-wide CI filters already cover `src/`; Astro imports, CSS imports, and CODEOWNERS need no changes.
No deploy configuration, migrations, or core contracts change.

## Verification

A temporary relocation check fails before the move and passes after it for all seven public exports.
SHA-256 checks confirm that seven exported source files and five rendered CSS/HTML values remain identical.
- Lint, typecheck, and intent checks passed.
- Focused unit tests: 867 passed. Contract tests: 15 passed. Dashboard integration tests: two passed on the isolated local Postgres server.
- Dashboard, landing, and worker builds passed.
- Browser validation: 103 existing cases and one screenshot case passed with the repository's Playwright Chromium.
  The temporary harness used isolated ports; the dashboard screenshot blocked external map assets.
- Sentrux found no degradation: 6480 after the move, unchanged from the pre-change scan.
  The committed baseline remains unchanged.
- One ponytail review returned a written approval with no findings.
  Its wrapper rejected extra prose, not the diff.
