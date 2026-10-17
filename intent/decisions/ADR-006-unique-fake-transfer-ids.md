# ADR-006: Fake transfer ids are globally unique

Status: accepted (Phase 1, 2026-10-17). Raised by engine-builder (T1.2).

## Context
`fakePayments().payoutWorker` returned `tr_fake_1`, `tr_fake_2`, ... per instance. The ledger has a unique `(type, stripe_ref)` index (ADR-001), so two integration test files that each pay out against the same database collided on `tr_fake_1`. Real Stripe transfer ids are globally unique, so the fake was less realistic than the thing it fakes.

## Decision
Fake transfer ids are `tr_fake_<n>_<uuid>`. Idempotency per key is unchanged: the same `idempotency_key` still returns the same id.

## Consequences
Integration tests across packages can share one database without suffix workarounds.
