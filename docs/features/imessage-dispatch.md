# iMessage dispatch

When an agent asks Eyes a question about a place, Eyes texts the nearest free workers: up to 3 people within 3 km. The text says what to check, what it pays, and the deadline. The first worker to reply YES gets the task and a private capture link. Anyone who replies YES after that is told the task is already claimed.

## How it works

- Eyes picks workers who are available, opted in, and not already holding a claimed or submitted task, nearest first.
- The limits are config defaults: `dispatch_max_workers` = 3 and `dispatch_radius_m` = 3000 m.
- The offer text reads like "Eyes: $3.00 to check how long the line is at … Reply YES to claim, STOP to opt out."
- Claims are taken under a row lock, so only one YES can win. Ten workers replying at the same moment still produce one claim.
- The winner's capture link expires at the task deadline. A late YES gets "no open task" and the agent is refunded once.
- Workers can reply NO to give the task back, HELP for instructions, or STOP to opt out.

## How to try it

Become a worker: open https://app.eyes.pictures and tap **JOIN**. After you sign up, Eyes texts you when a paid task is posted near you. Reply YES to claim it.

## Where in the code

- [`packages/comms/src/inkbox.ts`](../../packages/comms/src/inkbox.ts): offer, capture-link and "already claimed" message texts
- [`packages/engine/src/index.ts`](../../packages/engine/src/index.ts): `nearby()`, `askEyes` dispatch, `handleWorkerReply`
- [`packages/core/src/service.ts`](../../packages/core/src/service.ts): `dispatch_max_workers` and `dispatch_radius_m` defaults
- [`packages/db/migrations/006_dispatch_idle_workers.sql`](../../packages/db/migrations/006_dispatch_idle_workers.sql): nearest-idle-workers query and `eyes_claim`
- [`packages/engine/src/engine.adversarial.int.test.ts`](../../packages/engine/src/engine.adversarial.int.test.ts): race tests (one claim per task)
