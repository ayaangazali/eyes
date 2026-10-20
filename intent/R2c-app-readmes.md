---
task: R2c
title: Add READMEs for apps and the CLI
files:
  - apps/mcp/README.md
  - apps/mobile/README.md
  - apps/web/dashboard/README.md
  - apps/web/landing/README.md
  - apps/web/worker/README.md
  - cli/README.md
  - intent/INDEX.md
status: done
---

## Why

Issue #229 asks for a README in each app and the CLI.
A new contributor can see what each package does, its entry points, and how to test it, without a search of the code.
The mobile README tells why the app is outside the pnpm workspace.
`apps/edge/api` and `apps/edge/monitor` have no `package.json`, so they get no README.

## What changed

Add one short README to each of the six packages.
Each README links to `docs/architecture.md` and `CONTRIBUTING.md` and does not repeat them.
Deploys stay manual; the READMEs point to `docs/DEPLOY.md`.
No code changes.

## Verification

Each claim was checked against the package code and `package.json`.
Each test command was run on this branch.
Run root lint and the intent check.
