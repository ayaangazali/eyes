# ADR-025: The photo check is moderation only

Status: accepted (2026-10-17, operator); photo policy narrowed on 2026-10-18. `VisionJudgeInput` is `{ photo_url }`; `VisionVerdict` is now `{ allowed, reason, confidence }`. The obsolete `prominent_faces` flag is removed. API fields `verification.vision_ok` / `vision_reason` are unchanged.

## Context
`verifySubmission` asked clef-omni (then Claude) whether the photo answers the question, and a "no" held the payout in `needs_review`. A model guessing whether "about 4 people in line" is right blocked honest workers on judgment calls, and the agent, who asked the question, is better placed to judge the answer from the photo. Wrong answers already have a path: `dispute_answer`.

## Decision
- Reject photo content only for confirmed graphic gore or explicit sexual/adult content. Do not infer adultery, relationships or moral traits. Ordinary scenes, faces, private spaces, personal details, screenshots and blank images are not rejection categories. Task-request privacy restrictions in `packages/safety` are unchanged.
- The judge sees only the photo. The question, place and worker answer are no longer sent, so the verdict cannot be about correctness (and there is no task data to inject through).
- clef-omni asks `gore` and `explicit_sexual` as `noul` questions. A category probability >= 0.8 rejects; otherwise content passes, including uncertainty. Actual provider failures use Claude when configured. Claude returns structured content flags and rejects only when a blocked flag is true with confidence >= 0.8. Missing, malformed or out-of-range provider responses throw; if fallback fails or is unavailable, verification remains unavailable and the task needs review.
- Payout: `gps_ok && fresh_ok && vision_ok` auto-approves, as before; `vision_ok` now means "safe to share". Answer correctness never blocks payout.
- A blocked photo is never delivered (`photo_url: null` in agent answers).
  An unavailable photo stays withheld until ops releases the task and the agent's payment is released.
  Store unavailable checks as `submissions.vision_ok = null`; keep confirmed blocks as `false` and successful checks as `true`.
  Deliver an unavailable photo only in `verified` or `paid`, when the release transaction has charged the agent.
  Keep the public `verification.vision_ok` boolean false for unavailable checks, even after release.
  Stored photos remain available to reviewers.
  Face-only deletion is removed, superseding ADR-014 for moderation.
  Lost-claim upload cleanup remains.
  Do not infer past moderation outcomes from reason text or rewrite old false verdicts.
- User-facing label: "Photo is safe to share" (capture page, ChatGPT widget card, dashboard, ops review, docs).

The release rule follows the stated default in [issue #180](https://github.com/ayaangazali/eyes/issues/180), applied for [issue #99](https://github.com/ayaangazali/eyes/issues/99).
The owner has not answered that product question.
An ops release cannot change a confirmed block.

## Alternatives rejected
- New field names (`moderation_ok`): breaks agents already reading `vision_ok`. Redefining the meaning in descriptions is enough because both fields only ever gated the same payout.
- Keep a correctness score as advice only: the agent would still read it as a verdict, and it costs a model call per photo.
- A generic "safe to share" question and face threshold: they conflated task-request privacy restrictions with photo moderation and held ordinary photos. Two explicit content categories keep the policy bounded.

## Consequences
The agent still evaluates correctness.
An ops-approved blocked photo stays undelivered: ops cannot "unblock" a confirmed block for the agent.
The nullable internal verdict does not change public tool schemas or grant clients access to stored photos.
Migration 042 permits a missing verdict without changing old rows or moving money.
Old false verdicts stay withheld because their reason text cannot safely distinguish an outage from a block.
Apply the migration before the new application code; stop the new writers before reverting the application.
Preserve nullable rows on rollback rather than reclassifying them as successful checks.
The 0.8 clef threshold is a policy cutoff, not a measured accuracy guarantee.
Image-ground-truth evaluation is separate from mocked category tests and safe-image runtime smoke.
