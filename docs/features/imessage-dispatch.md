# iMessage dispatch

When an agent asks Eyes a question about a place, Eyes texts the nearest free workers: up to 3 people within 3 km. The text says what to check, what it pays, and the deadline. The first worker to reply YES gets the task and a private capture link. Other workers are told the task is already claimed; a repeat YES from the winner resends the capture link while the claim is active.

## How it works

- Eyes picks workers who are available, opted in, have a fresh location, are not on a dispute-review hold, and are not already holding a claimed or submitted task, nearest first. Three distinct disputes on non-test tasks trigger a worker hold until operator review; retries on the same task do not count again.
- The limits are config defaults: `dispatch_max_workers` = 3 and `dispatch_radius_m` = 3000 m.
- Offer texts state the bounty and how to claim or opt out. The current deployment also discloses that payouts are simulated: test credits are not real cash.
- Claims are taken under a row lock, so only one YES can win. Ten workers replying at the same moment still produce one claim.
- The winner's capture link expires at the task deadline. A YES with no open task gets a "no open task" reply; a late or duplicate YES does not trigger a refund. Expiry processing separately refunds an unanswered task once its deadline passes.
- Workers can reply NO to give the task back, HELP for instructions, or STOP to opt out. STOP clears the stored location and revokes location codes. Known implementation gap: SMS STOP does not delete the saved email address. Text EMAIL OFF or use **Remove** on `/me` to remove it.

## How to try it

Become a worker: open https://app.eyes.pictures and tap **JOIN**. After you sign up, Eyes texts you when a paid task is posted near you. Reply YES to claim it.

## Where in the code

- [`packages/comms/src/inkbox.ts`](../../packages/comms/src/inkbox.ts): offer, capture-link and "already claimed" message texts
- [`packages/engine/src/index.ts`](../../packages/engine/src/index.ts): `nearby()`, `askEyes` dispatch, `handleWorkerReply`
- [`packages/core/src/service.ts`](../../packages/core/src/service.ts): `dispatch_max_workers` and `dispatch_radius_m` defaults
- [`packages/db/migrations/006_dispatch_idle_workers.sql`](../../packages/db/migrations/006_dispatch_idle_workers.sql): nearest-idle-workers query and `eyes_claim`
- [`packages/engine/src/engine.adversarial.int.test.ts`](../../packages/engine/src/engine.adversarial.int.test.ts): race tests (one claim per task)
