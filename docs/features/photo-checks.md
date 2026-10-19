# Three checks per photo

Every photo a worker submits gets three automatic checks: was the worker at the place, was the photo taken live before the deadline, and is it safe to share with the agent. Passing all three qualifies the task for automatic approval; payout processing is separate and can be held for a dispute or review. When any check fails, the task waits for a person to review it, and the escrow stays held. Eyes only moderates the photo, not answer correctness. The agent decides whether the photo answers its question. The deployed payment flow uses test credits, not real cash.

## How it works

- **GPS:** the worker must be within the task radius (150 m by default) of the place. GPS accuracy must be 100 m or better, and up to 50 m of that accuracy counts in the worker's favor.
- **Live and on time:** the photo must arrive before the deadline and be taken no more than 5 minutes before upload. The phone clock may be up to 1 minute ahead.
- **Photo content:** only confirmed graphic gore or explicit sexual/adult content is rejected. Ordinary public scenes and incidental faces are allowed; there is no automatic face-based rejection or deletion. Other content, including private spaces, personal details, screenshots and blank images, is not a photo rejection category. Task-request privacy rules remain separate and unchanged.
- **Content uncertainty:** clef asks only about graphic gore and explicit sexual content. A category probability of at least 0.8 rejects the photo; lower scores pass, even if uncertain. Claude requires a blocked content flag with confidence of at least 0.8, never an inferred relationship or adultery.
- **Provider failures:** network, HTTP and invalid-response errors use Claude when configured. If no provider returns a valid verdict, the photo stays unavailable and the task needs review; failure is never treated as a safety pass.
- **Time limit:** moderation has a 25-second outer limit. A timeout needs review. GPS, freshness, payment and idempotency rules are unchanged; this policy does not reprocess held tasks.

## How to try it

Create a task with your agent, then read the task result. It includes `gps_ok`, `fresh_ok`, `vision_ok`, `vision_reason` and `worker_distance_m`.

## Where in the code

- [`packages/verify/src/index.ts`](../../packages/verify/src/index.ts): the three checks, clef moderation and the Claude fallback
- [`packages/core/src/service.ts`](../../packages/core/src/service.ts): default `verify_radius_m` of 150 m
- [`packages/engine/src/index.ts`](../../packages/engine/src/index.ts): auto-approval or review based on the verdict
- [`intent/decisions/ADR-025-vision-is-moderation.md`](../../intent/decisions/ADR-025-vision-is-moderation.md): photo content policy and separation from task safety
