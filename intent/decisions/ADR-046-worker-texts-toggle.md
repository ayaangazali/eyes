# ADR-046: Turn worker texts on or off with POST /w/me/texts

Status: accepted

## Decision

Add `POST /w/me/texts {on: boolean}`, keyed by the worker's `e:` token like `/w/me`.
`on=false` runs the STOP path of `handleWorkerReply`; `on=true` runs the START path.
The route adds `workerSetTexts` to `EyesService` and returns the new `WorkerSetup`.
`WorkerSetup` gains `texts_on`, equal to `opted_in`.
A banned worker stays off. A bad body is 400 and a bad code is 401.
The route shares the 5 an hour per code limit with the email routes.

## Consequences

The app turns texts on and off without a texted word.
Replies, claim release and location cleanup match a texted STOP or START, so a switch sends the same reply text.
No migration. `opted_in` stays for the web page.
