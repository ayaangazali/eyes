# iMessage dispatch

When an agent asks Eyes a question about a place, Eyes texts the nearest free workers: up to 3 people within 3 km. The text says what to check, what it pays, and the deadline. The first worker to reply YES gets the task and a private capture link. Other workers are told the task is already claimed; a repeat YES from the winner resends the capture link while the claim is active.

## How it works

- Eyes picks available, opted-in workers with fresh locations, no dispute-review hold, no held task, and no unexpired open offer.
  The database checks offer eligibility again under worker locks before charging for a task.
  Three distinct disputes on non-test tasks trigger a worker hold until operator review; retries on the same task do not count again.
- The limits are config defaults: `dispatch_max_workers` = 3 and `dispatch_radius_m` = 3000 m.
- Offer texts state the bounty and how to claim or opt out. The current deployment also discloses that payouts are simulated: test credits are not real cash.
- Claims are taken under a row lock, so only one YES can win. Ten workers replying at the same moment still produce one claim.
- The winner's capture link expires at the task deadline. A YES with no open task gets a "no open task" reply; a late or duplicate YES does not trigger a refund. Expiry processing separately refunds an unanswered task once its deadline passes.
- Workers can reply NO to give a task back without opting out.
  STOP and CANCEL release a held task and opt out in one transaction.
  Released tasks are offered again before the confirmation text is sent.
- Workers who add an email can also get offers by email. See [email channel](email-channel.md).

## Worker commands

START and HELP (when no held answer opens a review ticket) show every canonical command, one per line with a short meaning and blank lines between setup, commands, and accepted inputs. Aliases below still work but are not listed in the message. Two or more open setup steps are numbered; one is unnumbered; none says "You're all set." Live texts keep all links short and send the whole reply in one message.

- **Tasks:** YES (Y, YEP, YUP, YEAH, YEA, OK, OKAY, SURE, CLAIM, 👍, YES PLEASE) takes a task; NO (N, NOPE, NAH, PASS) declines or gives it back; TASK (LINK) resends the current capture link.
- **Setup:** START (UNSTOP) joins/resumes; HELP (INFO, ?) shows setup or requests review of a held answer; APP / INSTALL (DOWNLOAD, TESTFLIGHT) gets the app.
- **Location:** HERE (LOCATION, I'M HERE, IM HERE, I AM HERE) sends an update link; SHORTCUT (AUTO, AUTOMATION) sends automatic-location instructions and a device code.
- **Email, by text only:** EMAIL (E-MAIL) sends the first-email link; EMAIL OFF (E-MAIL OFF) removes email. `EMAILOFF` without a space is not a command.
- **Stop:** STOP (STOPALL, STOP ALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPTOUT, OPT OUT, STOP TEXTING ME, PLEASE STOP) pauses tasks, clears the stored location and revokes location codes. Known implementation gap: SMS STOP does not delete the saved email address. Text EMAIL OFF or use **Remove** on `/me` to remove it.
  HELP after opting out returns the standard command menu without restoring consent or creating location codes.

Accepted inputs include an email address, a Maps link with coordinates, and a `lat,lng` pair with three decimal places per number.
iMessage location shares and short map links receive an update link.
Free text can add details to an open review ticket.
Commands ignore case and punctuation.
YES, NO, STOP, START, and their explicit aliases require exact matching; other commands still allow some single-word typos.
Questions such as `yes please?` do not claim tasks.
Photos sent by MMS or iMessage receive instructions to take and submit the photo through the live capture link.
Without a live claim, the reply says there is no open task.
STOP, START, and HELP still work when a message includes an attachment.
Email replies cannot opt a phone into tasks.

## How to try it

Become a worker: open https://app.eyes.pictures and tap **JOIN**. After you sign up, Eyes texts you when a paid task is posted near you. Reply YES to claim it.

## Where in the code

- [`packages/comms/src/inkbox.ts`](../../packages/comms/src/inkbox.ts): offer, capture-link and "already claimed" message texts
- [`packages/engine/src/index.ts`](../../packages/engine/src/index.ts): `nearby()`, `askEyes` dispatch, `handleWorkerReply`
- [`packages/core/src/service.ts`](../../packages/core/src/service.ts): `dispatch_max_workers` and `dispatch_radius_m` defaults
- [`packages/db/migrations/006_dispatch_idle_workers.sql`](../../packages/db/migrations/006_dispatch_idle_workers.sql): nearest-idle-workers query and `eyes_claim`
- [`packages/engine/src/engine.adversarial.int.test.ts`](../../packages/engine/src/engine.adversarial.int.test.ts): race tests (one claim per task)
