# Three checks per photo

Every photo a worker submits gets three automatic checks: was the worker at the place, was the photo taken live before the deadline, and is it safe to share with the agent. When all three pass, the task is approved and the worker is paid. When any check fails, the task waits for a person to review it, and the escrow stays held. Eyes only moderates the photo. The agent decides whether the photo answers its question.

## How it works

- **GPS:** the worker must be within the task radius (150 m by default) of the place. GPS accuracy must be 100 m or better, and up to 50 m of that accuracy counts in the worker's favor.
- **Live and on time:** the photo must arrive before the deadline and be taken no more than 5 minutes before upload. The phone clock may be up to 1 minute ahead.
- **Safe to share:** Cloudflare Workers AI `clef-omni` checks the photo first. It blocks a person as the main subject, nudity, violence, private interiors seen through a window, documents or screens with personal details, readable license plates as the main subject, and screenshots or blank images.
- **Prominent faces:** a large or clearly identifiable face fails the check. Distant or blurry background people are fine. Face-rejected photos are deleted.
- **When clef is unsure:** if a score falls between 0.2 and 0.8, or clef fails, Claude moderates the photo instead. Without an Anthropic key, the photo goes to manual review.
- **Time limit:** if moderation takes longer than 25 seconds, the photo goes to manual review.

## How to try it

Create a task with your agent, then read the task result. It includes `gps_ok`, `fresh_ok`, `vision_ok`, `vision_reason` and `worker_distance_m`.

## Where in the code

- [`packages/verify/src/index.ts`](../../packages/verify/src/index.ts): the three checks, clef moderation and the Claude fallback
- [`packages/core/src/service.ts`](../../packages/core/src/service.ts): default `verify_radius_m` of 150 m
- [`packages/engine/src/index.ts`](../../packages/engine/src/index.ts): auto-approval or review based on the verdict
- [`intent/decisions/ADR-014-delete-face-photos.md`](../../intent/decisions/ADR-014-delete-face-photos.md): why face photos are deleted
