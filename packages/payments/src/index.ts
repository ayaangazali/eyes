import { EyesError, type Payments, type PaymentsEvent, type RouteDeps, usdToCents } from "@eyes/core";
import { type Context, Hono } from "hono";
import { html } from "hono/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import Stripe from "stripe";

type Env = Record<string, string | undefined>;

export function createStripePayments(env: Env): Payments {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. Copy the secret key from your Stripe sandbox (Dashboard > Developers > API keys).",
    );
  }
  const stripe = new Stripe(key);

  return {
    async createTopupCheckout({ agent_id, amount_cents, success_url, cancel_url }) {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Eyes balance top-up" },
              unit_amount: amount_cents,
            },
            quantity: 1,
          },
        ],
        client_reference_id: agent_id,
        metadata: { agent_id },
        payment_intent_data: { metadata: { agent_id } },
        success_url,
        cancel_url,
      });
      if (!session.url) throw new Error(`Stripe returned Checkout Session ${session.id} without a url`);
      return { url: session.url, session_id: session.id };
    },

    async createWorkerAccount({ worker_id, phone }) {
      const account = await stripe.accounts.create(
        {
          controller: {
            fees: { payer: "application" },
            losses: { payments: "application" },
            stripe_dashboard: { type: "express" },
          },
          country: "US",
          business_type: "individual",
          capabilities: { transfers: { requested: true } },
          individual: { phone },
          business_profile: {
            product_description: "Paid by Eyes for on-the-spot photo checks of public places.",
          },
          metadata: { worker_id },
        },
        { idempotencyKey: `eyes-worker-account-${worker_id}` },
      );
      return { account_id: account.id };
    },

    async createOnboardingLink({ account_id, refresh_url, return_url }) {
      const link = await stripe.accountLinks.create({
        account: account_id,
        refresh_url,
        return_url,
        type: "account_onboarding",
        collection_options: { fields: "currently_due" },
      });
      return { url: link.url };
    },

    async payoutWorker({ account_id, amount_cents, task_id, idempotency_key }) {
      const transfer = await stripe.transfers.create(
        {
          amount: amount_cents,
          currency: "usd",
          destination: account_id,
          transfer_group: task_id,
          metadata: { task_id },
        },
        { idempotencyKey: idempotency_key },
      );
      return { transfer_id: transfer.id };
    },

    async parseWebhook(rawBody, signature) {
      const secrets = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(
        (s): s is string => !!s,
      );
      if (secrets.length === 0) {
        throw new Error("STRIPE_WEBHOOK_SECRET is not set, so Stripe webhooks cannot be verified.");
      }
      const event = await Promise.any(
        secrets.map((secret) => stripe.webhooks.constructEventAsync(rawBody, signature ?? "", secret)),
      ).catch((err: AggregateError) => {
        throw err.errors[0];
      });
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const agent_id = session.metadata?.agent_id;
        if (session.payment_status !== "paid" || !agent_id || session.amount_total === null) return null;
        return { type: "topup.completed", agent_id, amount_cents: session.amount_total, ref: session.id };
      }
      if (event.type === "account.updated") {
        const account = event.data.object;
        if (account.capabilities?.transfers === "active" || account.payouts_enabled) {
          return { type: "worker.onboarded", account_id: account.id };
        }
      }
      return null;
    },
  };
}

const page = (title: string, text: string) =>
  html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem"><h1>${title}</h1><p>${text}</p></body>
</html>`;

async function redirectTo(c: Context, url: () => Promise<string>) {
  try {
    return c.redirect(await url(), 302);
  } catch (err) {
    if (!(err instanceof EyesError)) throw err;
    return c.html(page(err.message, err.fix), err.status as ContentfulStatusCode);
  }
}

export function stripeRoutes(deps: RouteDeps, _env: Env): Hono {
  const app = new Hono();

  app.post("/webhooks/stripe", async (c) => {
    const rawBody = await c.req.text();
    let event: PaymentsEvent | null;
    try {
      event = await deps.providers.payments.parseWebhook(rawBody, c.req.header("stripe-signature") ?? null);
    } catch (err) {
      return c.text(`Webhook Error: ${(err as Error).message}`, 400);
    }
    if (event?.type === "topup.completed") {
      await deps.service.creditTopup({
        agent_id: event.agent_id,
        amount_cents: event.amount_cents,
        stripe_ref: event.ref,
      });
    }
    if (event?.type === "worker.onboarded") await deps.service.markWorkerOnboarded(event.account_id);
    return c.json({ received: true });
  });

  app.get("/topup/done", (c) =>
    c.html(
      page(
        "Payment received",
        "Your agent's Eyes balance updates within a few seconds. You can close this tab.",
      ),
    ),
  );
  app.get("/topup/cancel", (c) =>
    c.html(page("Top-up cancelled", "Nothing was charged. You can close this tab.")),
  );
  app.get("/topup/:token", (c) => {
    const query = c.req.query("amount_usd");
    const usd = query ? Number(query) : Number.NaN;
    const cents = Number.isFinite(usd) ? usdToCents(Math.min(100, Math.max(5, usd))) : undefined;
    return redirectTo(c, () => deps.service.topupCheckoutUrl(c.req.param("token"), cents));
  });

  app.get("/w/connect/done", (c) =>
    c.html(
      page(
        "Payouts are set up",
        "You can close this tab. If Stripe still needs details from you, open the Eyes payout link again to finish.",
      ),
    ),
  );
  app.get("/w/connect/:token", (c) =>
    redirectTo(c, () => deps.service.workerConnectUrl(c.req.param("token"))),
  );

  return app;
}
