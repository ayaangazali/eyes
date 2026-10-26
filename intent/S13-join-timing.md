---
task: S13
title: Same database write for new and known phones on join
files:
  - packages/db/migrations/045_join_same_write.sql
  - packages/db/src/join-write.int.test.ts
  - intent/decisions/ADR-021-join-oracle.md
  - intent/INDEX.md
status: done
---

## Why

Issue #71: a phone that already joined answered POST /w/join about 1.5 ms faster than a new one, because only the new one committed a write.

## What changed

Migration 045 makes `eyes_join_worker` update the conflicting row to its own phone. A repeat join now writes and commits like a new join, and no column changes.

## Verification

An integration test joins a phone twice and checks that the row version changed on the repeat while name, location and id stayed the same.
