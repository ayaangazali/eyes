# @eyes/payments

The Stripe adapter. It takes agent top-ups through Stripe Checkout and pays workers through Stripe Connect.
It also serves the payment pages and the Stripe webhook.

## Exports

From `src/index.ts`:

- `createStripePayments(env)`: the `Payments` provider from `@eyes/core`.
  It makes top-up checkouts, worker accounts, onboarding links, payouts, and transfer reversals, and it parses webhooks.
  It needs `STRIPE_SECRET_KEY`. It refuses a live key unless `EYES_TEST_MODE` is `"false"`.
- `stripeRoutes(deps, env)`: a Hono app with `/webhooks/stripe`, the `/topup/*` pages, the owner console at `/owner/:token`, and the worker pages at `/w/connect/*` and `/w/earnings/:token`.
- `PAGE_HEADERS`: the security headers (including the content security policy) for these server-rendered pages.

The pages use the styles from `@eyes/ui/page`.

## Use in the repo

`apps/mcp/src/main.ts` makes the provider when Stripe credentials are set.
`apps/mcp/src/server.ts` mounts `stripeRoutes` at `/` and uses `PAGE_HEADERS` for its own pages.

`scripts/fund-platform.ts` adds test balance to a Stripe sandbox, so test payouts can run: `node packages/payments/scripts/fund-platform.ts [usd]`.
It refuses a live-mode key.

## Tests

```sh
pnpm vitest run --project unit packages/payments
DATABASE_URL=postgres://postgres:eyes@127.0.0.1:54329/eyes pnpm vitest run --project integration packages/payments
```

The tests mock the Stripe SDK. The integration test skips when `DATABASE_URL` is not set.

## See also

- [Architecture](../../docs/architecture.md)
- [Contributing](../../CONTRIBUTING.md)
