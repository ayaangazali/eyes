---
task: S10-photo-reuse-check
files:
  - packages/db/migrations/047_photo_reuse.sql
  - packages/engine/src/photo-hash.ts
  - packages/engine/src/photo-hash.test.ts
  - packages/engine/src/index.ts
  - packages/engine/package.json
---

## Why

Eyes had no check for a worker who sends an earlier answer photo again to collect a second payout.
`submitCapture` now fingerprints each JPEG answer photo with a SHA-256 and a 64-bit dHash.
An exact SHA-256 match, or a dHash within 6 bits of any earlier answer, sends the answer to `needs_review` and holds the payout.
The worker text says the photo matches an earlier answer.
Bytes that are not a decodable JPEG are not fingerprinted.
The hashes are new nullable columns on `submissions`, added by an append-only migration.
`jpeg-js` (pure JavaScript, no native build) decodes the photo, because no image library was installed in the workspace.

## Verification

Unit test: a recompressed copy stays within 6 bits, a different photo does not, and non-JPEG bytes give no fingerprint.
The migration SQL ran on an in-memory Postgres: stored hashes match by SHA and by Hamming distance, and a far hash does not.
