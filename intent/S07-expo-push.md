---
task: S07
title: Expo push notifications
files:
  - packages/db/migrations/052_push_tokens.sql
  - packages/engine/src/push.ts
  - packages/engine/src/push.test.ts
  - packages/engine/src/push-events.test.ts
  - packages/engine/src/index.ts
  - packages/core/src/service.ts
  - apps/mcp/src/server.ts
  - apps/mcp/src/server.test.ts
  - intent/decisions/ADR-053-expo-push.md
  - intent/INDEX.md
status: done
---

## Why

The app needs push for new offers, disputes, decided reviews and spend limits (ADR-053). Texts stay.

## Verification

Unit tests mock the Expo call and check that `DeviceNotRegistered` removes the token and that an outage is swallowed.
