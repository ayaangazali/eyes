---
task: D2
title: Renumber duplicate ADR-023, ADR-024, and T6.36 records
files:
  - README.md
  - docs/features/ops-dashboard.md
  - docs/features/worker-location.md
  - intent/decisions/ADR-036-ops-access-events-tickets.md
  - intent/decisions/ADR-037-worker-location.md
  - intent/T6.68-worker-setup-page.md
  - intent/T6.4-ops-dashboard.md
  - intent/T6.6-worker-location.md
  - intent/T6.13-map-links.md
  - intent/T6.15-location-automations.md
  - packages/engine/src/engine.int.test.ts
  - intent/INDEX.md
status: done
---

## Why

Issue #133 identifies duplicate record identifiers.
Keep the records that reached main first on their original ADR numbers.
The keyless sandbox arrived in `f733257`, and the public-place description arrived in `7fe23d7`.
The ops and worker-location records arrived later in `3150958`.
Both T6.36 records reached main in that same commit.
The merge record was created in `95f01a5` before the worker-setup record in `e56b6ad`, so worker setup receives T6.68.
ADR-036, ADR-037, and T6.68 were free on main and in open pull requests.

## What changed

Renumber the later records and update their references and the generated index.
Preserve record content except for identifiers and the migration note.
Migration 017 retains its historical ADR-024 comment because applied migrations are append-only.
Issue #133 remains open; the AGENTS.md decision still waits in #180.

## Verification

Run the focused identifier regression before and after the change.
Regenerate the index and run the intent check.
Run lint, typecheck, the core unit and contract checks, and the engine integration test.
Compare the Sentrux gate with the saved baseline and review the diff once with ponytail-review.
