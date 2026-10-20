---
task: R3
files:
  - .claude/agents/integration-verifier.md
  - README.md
  - docs/CONNECT.md
  - docs/DEPLOY.md
  - docs/SPEC.md
  - docs/archive/hackathon/DEMO.md
  - docs/archive/hackathon/PLAN.md
  - docs/archive/hackathon/README.md
  - docs/archive/hackathon/STATUS.md
  - docs/archive/hackathon/SUBMISSION.md
  - docs/archive/hackathon/hackathon.md
  - docs/manufact/README.md
  - docs/vendor/blaxel.md
  - intent/INDEX.md
  - intent/R3-archive-hackathon.md
  - scripts/archive-links.test.ts
  - scripts/ci-scope.test.ts
---

# Archive hackathon records

## Why

Keep the hackathon records separate from current documentation without losing their history or links.

## What

Move five records with `git mv` and update their references in live documentation.
Preserve historical intent records, verdicts, and decisions with their original paths.
Only path corrections change the archived records and the Manufact evidence README.
Add an archive description and a regression check for local archive links.

## Verification

Run the archive navigation regression and CI scope tests, lint, typecheck, contract tests, and the intent check.
The archive test fails before the move because the archive does not exist.
Check all five old filenames in live documentation, scripts, workflows, public docs, and agent instructions.
