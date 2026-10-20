---
task: R2b
files:
  - intent/INDEX.md
  - intent/R2b-package-readmes.md
  - packages/comms/README.md
  - packages/core/README.md
  - packages/db/README.md
  - packages/engine/README.md
  - packages/payments/README.md
  - packages/safety/README.md
  - packages/ui/README.md
  - packages/verify/README.md
---

# Add READMEs for packages

## Why

The packages in `packages/` had no README. A contributor had to read the code to learn what each package does and how to test it.

## What

Add a short README to each package: its purpose, main exports, use in the repo, and the test command.
Link to `docs/architecture.md` and `CONTRIBUTING.md` instead of repeating them. No code changes.

## Verification

Check each claim against the package code and `package.json`.
Run each documented unit test command, lint, and the intent check.
