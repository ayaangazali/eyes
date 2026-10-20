# ADR-039: Worker text replies and one open offer

## Decision

Follow the defaults in issue #180 for issues #97, #135, and #136.
Require exact matching for consent and task decisions and their explicit aliases.
This includes YES: edit-distance matching against `yea` previously turned `year` into a claim.
Keep edit-distance matching for other commands.
Accept `yes please`, but not a question asking `yes please?`.
Keep `cancel` as STOP: it releases the held task and opts out.
This overrides the #180 default to follow the standard opt-out keyword rule.

Add the internal `media` reply intent for MMS and iMessage attachments.
Keep STOP, START, and HELP ahead of attachment handling.
Direct a worker with a live claim to its capture page to take and submit the photo.
Do not treat a text attachment as a submitted answer or an Apple location share.
Return the existing no-task reply when the worker has no live claim.

Use the existing command menu for HELP after STOP.
Do not mint location codes, opt in, or open a review ticket for an opted-out worker.

Add `eyes_stop_worker` to release the claim and clear consent in one database transaction.
Lock the worker before the task, matching the claim path.
Reuse the current release and opt-out functions, including their submission and location-deletion rules.
Send the release notice and offer the task to eligible workers after the transaction commits.

Reject workers with an unexpired dispatched offer during nearby selection and again under the posting transaction's worker locks.
Apply the same exclusion to repeat offers for other tasks.
The existing additional-offer path uses nearby selection under worker locks, so it inherits this rule.
Keep existing task deadlines as offer expiry; add no queue, timer, or expiry state.

## Consequences

Ordinary words no longer change consent or task ownership through typo matching.
Workers must use an exact reply or a listed alias for those decisions.
If every nearby worker already has an offer, the next task returns `no_workers_nearby` without charging.
A worker becomes eligible after the offered task is claimed, cancelled, or expires.
The migration only replaces functions and adds one function; it does not rewrite existing task or offer rows.
Existing in-flight offers remain valid.
