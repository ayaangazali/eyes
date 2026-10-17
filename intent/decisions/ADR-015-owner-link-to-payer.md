# ADR-015: The person who pays for an agent gets its owner link

Status: accepted (2026-10-17, orchestrator). Adds to the frozen contract: `payer_email: string | null` on the `topup.completed` `PaymentsEvent`, and optional `payer_email?: string | null` on `EyesService.creditTopup`'s input.

## Context
ADR-011 promises the agent never sees the `p:` owner link, but the link goes to the `owner_email` the agent itself passes to `signup`. An agent that names an inbox it can read gets its own owner link and can raise its limits to the form maximums ($100 bounty, $1000/day) (issue #38). The agent cannot fake the one human step in the flow: completing Stripe Checkout with a card. Stripe records the email the payer typed on the Checkout form.

## Decision
- `parseWebhook` sets `payer_email` from the Checkout Session's `customer_details.email` (`string | null` in `stripe@23.0.0` `Checkout.Session.CustomerDetails`). The event is signature-verified, so the agent cannot alter it.
- The webhook route passes `payer_email` to `creditTopup`. After the ledger credit, the engine emails the payer the owner link with a receipt subject ("You added $15.00 to your AI agent's Eyes balance"), through the same `Email` provider and body as the signup owner email.
- Sent on every completed top-up, not only the first: it is the payer's receipt plus their control link, and it needs no new state.
- A replayed webhook (same Checkout Session id) is not credited twice (the `ledger (type, stripe_ref)` unique index), but it does send the same link to the same payer again. Stripe redelivers only when we did not answer 2xx, or on a manual resend, so this is rare and harmless. Skipping it would need `eyes_credit_topup` to report whether it inserted, which is a migration.
- A failed payer email never fails the credit or the webhook (a 500 would make Stripe retry a credit that already happened). The log line carries only the agent id and the error name.
- The signup `owner_email` path (ADR-011) stays: it lets a human control a test-mode agent before any money moves. The signup email and the owner console now say "Whoever pays for this agent also gets this link." The payer path is the trustworthy one because the agent picks `owner_email` but cannot complete a card payment on a human's behalf.

## Alternatives rejected
- Only the first top-up: needs a "has this agent been topped up before" read that the ledger has but no RPC exposes, for the cost of an occasional duplicate receipt.
- Drop `owner_email` at signup: an agent in test mode would have no human control until the first payment.
- Revoke the signup link when a payer appears: needs per-link revocation, which ADR-011 does not have.

## Consequences
An agent that pays with its own card becomes its own owner; that is its own money, which is the premise of this ADR. The signup link is still valid after a top-up, so an agent that named its own inbox keeps control until the link secret rotates; the payer can see the limits change on the console but cannot lock the agent out.
