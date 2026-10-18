# iMessage dispatch

When an agent asks Eyes a question about a place, Eyes texts the nearest free workers: up to 3 people within 3 km. The text says what to check, what it pays, and the deadline. The first worker to reply YES gets the task and a private capture link. Anyone who replies YES after that is told the task is already claimed.

## How it works

- Eyes picks workers who are available, opted in, have a fresh location, are not on a dispute-review hold, and are not already holding a claimed or submitted task, nearest first. Three distinct disputes on non-test tasks trigger a worker hold until operator review; retries on the same task do not count again.
- The limits are config defaults: `dispatch_max_workers` = 3 and `dispatch_radius_m` = 3000 m.
- Offer texts state the bounty and how to claim or opt out. The current deployment also discloses that payouts are simulated: test credits are not real cash.
- Claims are taken under a row lock, so only one YES can win. Ten workers replying at the same moment still produce one claim.
- The winner's capture link expires at the task deadline. A late YES gets "no open task" and the agent is refunded once.
- Workers can reply NO to give the task back, HELP for instructions, or STOP to opt out.
- Workers who add an email can also get offers by email. See [email channel](email-channel.md).

## Worker commands

START and HELP (when no held answer opens a review ticket) show every canonical command, one per line with a short meaning and blank lines between setup, commands, and accepted inputs. Aliases below still work but are not listed in the message. Two or more open setup steps are numbered; one is unnumbered; none says "You're all set." Live texts keep all links short and send the whole reply in one message.

- **Tasks:** YES (Y, YEP, YUP, YEAH, YEA, OK, OKAY, SURE, CLAIM, 👍) takes a task; NO (N, NOPE, NAH, PASS) declines or gives it back; TASK (LINK) resends the current capture link.
- **Setup:** START (UNSTOP) joins/resumes; HELP (INFO, ?) shows setup or requests review of a held answer; APP / INSTALL (DOWNLOAD, TESTFLIGHT) gets the app.
- **Location:** HERE (LOCATION, I'M HERE, IM HERE, I AM HERE) sends an update link; SHORTCUT (AUTO, AUTOMATION) sends automatic-location instructions and a device code.
- **Email, by text only:** EMAIL (E-MAIL) sends the first-email link; EMAIL OFF (E-MAIL OFF) removes email. `EMAILOFF` without a space is not a command.
- **Stop:** STOP (STOPALL, STOP ALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT, OPT OUT, STOP TEXTING ME, PLEASE STOP) pauses tasks, deletes location and email, and disables location codes.

Accepted inputs, not additional commands: an email address by text; an Apple/Google Maps link with coordinates or a `lat,lng` pair with at least three decimal places per number; an iMessage location share or short map link (answered with an update link); and details for an open review ticket. Commands are case-insensitive and tolerate punctuation. The parser also tolerates some single-word typos; these are not extra advertised aliases. Email replies cannot opt a phone into tasks.

## How to try it

Become a worker: open https://app.eyes.pictures and tap **JOIN**. After you sign up, Eyes texts you when a paid task is posted near you. Reply YES to claim it.

## Where in the code

- [`packages/comms/src/inkbox.ts`](../../packages/comms/src/inkbox.ts): offer, capture-link and "already claimed" message texts
- [`packages/engine/src/index.ts`](../../packages/engine/src/index.ts): `nearby()`, `askEyes` dispatch, `handleWorkerReply`
- [`packages/core/src/service.ts`](../../packages/core/src/service.ts): `dispatch_max_workers` and `dispatch_radius_m` defaults
- [`packages/db/migrations/006_dispatch_idle_workers.sql`](../../packages/db/migrations/006_dispatch_idle_workers.sql): nearest-idle-workers query and `eyes_claim`
- [`packages/engine/src/engine.adversarial.int.test.ts`](../../packages/engine/src/engine.adversarial.int.test.ts): race tests (one claim per task)
