# ADR-047: Photo reuse check

Status: accepted

## Decision

`submissions` gets `photo_sha256` and `photo_phash` (signed 64-bit dHash), with an index on the SHA.
`eyes_photo_reuse` returns true when any earlier answer has the same SHA-256, or a dHash within `PHOTO_PHASH_MAX_DISTANCE` (6) bits.
A match clears `auto_approve`, so the task goes to `needs_review` and no release ledger row is written.
`eyes_store_photo_hash` saves the hashes after `eyes_submit`; a failure there is logged and does not fail the submission.

## Consequences

The distance scan is linear in submissions. Add a BK-tree or an extension when the table is large.
Two honest photos of one static scene can match; ops release them from review.
