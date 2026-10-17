# ADR-014: Photos rejected for prominent faces are deleted

Status: accepted (2026-10-17, orchestrator). Adds to the frozen contract: `Storage.deletePhoto(i: { key: string }): Promise<void>`, implemented by `fakeStorage` and `createInsforgeStorage`.

## Context
`submitCapture` uploads the photo to the InsForge `photos` bucket before vision judges it, because `VisionJudgeInput` takes a `photo_url` and Claude vision fetches the image by URL. A photo the judge rejects for `prominent_faces` kept a permanent public URL in the bucket and in `submissions.photo_url`, so the agent received it in `await_answer` and `get_task`, the email reply attached it, and the dashboard feed showed it. SPEC §12 promises no photos of identifiable people, and this is the one photo we know shows a face (issue #27).

## Decision
- Delete after reject. When the vision verdict has `prominent_faces: true`, the engine calls `storage.deletePhoto({ key })` with the key it uploaded under and stores `photo_url = null` on the submission. The column is already nullable in `001_init.sql` and `eyes_submit` already takes a nullable `p_photo_url`, so no migration.
- The engine reads the verdict by wrapping the `Vision` provider it passes to `verifySubmission` and recording `prominent_faces`. `VerificationResult` does not carry the flag, and `vision_reason` text is not a contract to parse.
- A failed delete never fails the worker's submission: the engine logs `photo delete for task <id> failed` (task id only) and still stores `photo_url = null`, so the agent never receives the URL either way.
- The task still goes to `needs_review` with escrow held, as before; the reviewer sees `vision_reason` instead of the photo.

## Alternatives rejected
- Judge before upload: `VisionJudgeInput.photo_url` would become bytes, `createClaudeVision` would switch to a base64 image source, `packages/verify` would change, and the engine would still upload after an approval. Three packages and two contract changes against one method here.
- Add `prominent_faces` to `VerificationResult`: a second contract change plus an edit to `packages/verify` (another builder's package) for a flag the engine can read from the verdict it already routes.
- Private bucket with presigned URLs: protects every photo but changes how agents, email and the dashboard get every URL. Out of scope for one rejected photo.

## Consequences
Every `Storage` implementation must implement `deletePhoto`. Until the delete runs, the face photo is public for the seconds vision takes; a failed delete leaves the object in the bucket under an unguessable key that nothing stores or returns. If the judge times out (25 s in `verifySubmission`) its verdict arrives too late to act on, and the photo is kept for manual review as before.
