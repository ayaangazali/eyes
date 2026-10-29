# Ads that lower the cost of a human check

Status: design only. The ad slot is in the code, but it is off. No ad network, sponsor contract or live ad exists. The owner must approve each of these before it goes live (#264).

## Why

Each human check costs the owner the worker bounty plus the Eyes fee: $3.00 + $0.50 = $3.50 by default (`default_bounty_cents`, `fee_cents` in `packages/core/src/service.ts`). Ad money can pay part of the Eyes fee, so each check costs the owner less. The worker bounty does not change.

## Placement

- One slot on the worker setup page, `app.eyes.pictures/me`, between the setup checklist and the task list. It is a plain `.ui-card` with a `Sponsored` badge.
- Eyes texts link workers to this page (`Your setup:` with `meUrl` in `packages/engine`), so the slot is in the worker app that workers already open. The iPhone app does not show the slot.
- No ads on these surfaces:
  - The capture, here and join pages. A worker on a task must not lose attention, and a new worker must see only the terms.
  - Task texts (iMessage, SMS, email).
  - MCP tool results and the REST API. Agents are not the audience, and ad text in a tool result could act as a prompt injection.
  - The owner console. Owners pay for checks, and its CSP blocks third-party content.
- The slot never shows inside the task list or looks like a task.

## Ad source

- Use direct sponsors only, not an ad network. An ad network loads third-party scripts and trackers that follow workers across sites.
- A sponsor gives one text line, one link and an optional image. Eyes stores the image and serves it from its own origin.
- Ads are contextual: each worker sees the same ad. Eyes does not target ads by person, location or task history.
- A sponsor pays Eyes through a Stripe Checkout payment. This uses the same Stripe account and `mode: "payment"` flow as the balance top-up (`createTopupCheckout` in `packages/payments`). The payment goes to Eyes, not to an agent balance.

## Disclosure

- The slot always shows the `Sponsored` badge. The badge is also the accessible name of the slot (`aria-labelledby`).
- Sponsor links use `rel="sponsored noopener"` and open the sponsor's page directly, without a redirect through a tracker.
- The landing page and the owner docs tell owners when a check got cheaper because of ads.

## Privacy impact

The policy at `eyes.pictures/privacy` does not mention ads now. Before the first live ad, add a section with these facts:

- Eyes shows sponsored messages on `app.eyes.pictures/me`.
- Eyes does not share personal data with sponsors and does not use ad networks, ad cookies or tracking pixels.
- Eyes counts views and clicks only as totals per ad, with no device ID or account. It uses the existing Cloudflare Web Analytics disclosure for page views.

Links to the open privacy issues:

- #115 (private data-request address): ads add no new personal data, so this change needs no new request channel. The policy update must still use the address that #115 adds.
- #111 (Cloudflare host exclusions): if click totals use Cloudflare Web Analytics, the host list in #111 must include `app.eyes.pictures`. Otherwise, count clicks on the Eyes server.

## Credit calculation

- Credits use ad money that Eyes already has, not money that Eyes expects to get.
- Each month: `credit_cents = min(fee_cents, floor(0.8 × R / N))`.
  - `R` is the net ad revenue for the last month, in cents, after Stripe fees.
  - `N` is the number of paid human checks in the last month.
  - Eyes keeps 20% of `R` for review and operating cost.
- The credit comes off the Eyes fee only, so it can never be more than `fee_cents`. The worker always gets the full bounty.
- `quote_task` and `ask_eyes` show the lower total and an `ad_credit_usd` field. The MCP connector and the REST API return the same price, and the owner console ledger shows the lower fee.
- Example: `R` = $400.00, `N` = 1,000. Then `0.8 × 40000 / 1000 = 32` cents. A default check costs $3.18 instead of $3.50.
- If `R` is 0, the credit is 0 and prices stay the same.
- The credit and fee changes touch `packages/core` and need an ADR.

## Flag

- `VITE_ADS=true` at build time shows the slot in `apps/web/worker` (`ADS` in `src/api.ts`). Any other value or no value hides it.
- The slot shows placeholder text until a sponsor is approved.
- The e2e test `apps/web/worker/e2e/me.spec.ts` checks that a default build shows no slot.

## Rollout steps

1. The owner approves the design and the first sponsor.
2. Update the privacy policy.
3. Add the sponsor content, the totals counter and the credit calculation, with an ADR.
4. Build the worker app with `VITE_ADS=true`.
