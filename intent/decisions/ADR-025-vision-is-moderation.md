# ADR-025: The photo check is moderation only

Status: accepted (2026-10-17, operator). Changes the frozen contract: `VisionJudgeInput` is `{ photo_url }` and `VisionVerdict` is `{ allowed, reason, prominent_faces, confidence }` (was `answers_question`). API field names `verification.vision_ok` / `vision_reason` are unchanged.

## Context
`verifySubmission` asked clef-omni (then Claude) whether the photo answers the question, and a "no" held the payout in `needs_review`. A model guessing whether "about 4 people in line" is right blocked honest workers on judgment calls, and the agent, who asked the question, is better placed to judge the answer from the photo. Wrong answers already have a path: `dispute_answer`.

## Decision
- The classifier answers one question: is this photo allowed to be delivered? It blocks only a prominent face or a person as the subject, nudity or sexual content, violence or gore, a private interior seen through a window, a document or screen with personal information, a license plate readable as the subject, or not a real photo (blank, totally black, screenshot).
- The judge sees only the photo. The question, place and worker answer are no longer sent, so the verdict cannot be about correctness (and there is no task data to inject through).
- clef-omni asks `safe_to_share` and `prominent_faces` as `noul` questions; when either is within 0.3 of 0.5 or clef fails, Claude decides if `ANTHROPIC_API_KEY` is set; otherwise the photo is not allowed and goes to manual review (fail closed). A judge timeout or error is also "not allowed".
- Payout: `gps_ok && fresh_ok && vision_ok` auto-approves, as before; `vision_ok` now means "safe to share". Answer correctness never blocks payout.
- Moderation fail: faces delete the photo (ADR-014, unchanged); any fail sends the task to `needs_review` with the moderation reason, the worker can reply HELP, and the agent gets `photo_url: null` (a blocked photo is never delivered; ops still sees it in the review panel).
- User-facing label: "Photo is safe to share" (capture page, ChatGPT widget card, dashboard, ops review, docs).

## Alternatives rejected
- New field names (`moderation_ok`): breaks agents already reading `vision_ok`. Redefining the meaning in descriptions is enough because both fields only ever gated the same payout.
- Keep a correctness score as advice only: the agent would still read it as a verdict, and it costs a model call per photo.
- One clef question per category: a better `vision_reason`, but more cost and latency per photo; the one-sentence Claude reason covers the unsure cases.

## Consequences
Fake answers are no longer caught automatically; they are handled by `dispute_answer` and human review. An ops-approved blocked photo stays undelivered (ceiling: ops cannot "unblock" a photo for the agent). The clef `safe_to_share` band is not yet measured on real worker photos.
