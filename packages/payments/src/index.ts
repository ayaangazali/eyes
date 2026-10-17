import {
  centsToUsd,
  EyesError,
  type LedgerType,
  type OwnerConsole,
  OwnerPolicyInput,
  type Payments,
  type PaymentsEvent,
  type RouteDeps,
  TASK_TYPES,
  type TaskType,
  usdToCents,
  type WorkerEarnings,
} from "@eyes/core";
import { type Context, Hono, type Next } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
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
  if (/^[rs]k_live_/.test(key) && env.EYES_TEST_MODE !== "false") {
    throw new Error(
      'STRIPE_SECRET_KEY is a live key, which moves real money, but EYES_TEST_MODE is not "false". Use a test key (sk_test_...) from your Stripe sandbox, or set EYES_TEST_MODE=false to take real payments on purpose.',
    );
  }
  const stripe = new Stripe(key, { timeout: 80_000, maxNetworkRetries: 2 });

  return {
    async createTopupCheckout({ agent_id, amount_cents, success_url, cancel_url }) {
      const done = new URL(success_url);
      done.searchParams.set("amount_cents", String(amount_cents));
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
        allowed_payment_method_types: ["card"],
        client_reference_id: agent_id,
        metadata: { agent_id, topup_cents: String(amount_cents) },
        payment_intent_data: { metadata: { agent_id }, transfer_group: `topup_${agent_id}` },
        success_url: done.href,
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
      const transfers = (await stripe.accounts.retrieve(account_id)).capabilities?.transfers ?? "none";
      if (transfers !== "active") {
        throw new Error(
          `Stripe account ${account_id} cannot receive transfers yet (transfers capability: ${transfers}); the worker has not finished payout setup.`,
        );
      }
      const transfer_group = `task_${task_id}`;
      const [earlier] = (await stripe.transfers.list({ transfer_group, limit: 1 })).data;
      if (earlier) return { transfer_id: earlier.id };
      const transfer = await stripe.transfers
        .create(
          {
            amount: amount_cents,
            currency: "usd",
            destination: account_id,
            transfer_group,
            metadata: { task_id },
          },
          { idempotencyKey: idempotency_key },
        )
        .catch((err: { statusCode?: number; type?: string; headers?: Record<string, string> }) => {
          const refused =
            [400, 402, 404].includes(err.statusCode ?? 0) &&
            err.type !== "StripeRateLimitError" &&
            err.headers?.["stripe-should-retry"] !== "true";
          throw refused ? err : Object.assign(err, { outcome_unknown: true });
        });
      return { transfer_id: transfer.id };
    },

    async parseWebhook(rawBody, signature) {
      const secrets = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(
        (s): s is string => !!s,
      );
      if (secrets.length === 0) {
        throw new EyesError(
          "internal_error",
          {},
          { message: "STRIPE_WEBHOOK_SECRET is not set, so Stripe webhooks cannot be verified." },
        );
      }
      const event = await Promise.any(
        secrets.map((secret) => stripe.webhooks.constructEventAsync(rawBody, signature ?? "", secret)),
      ).catch((err: AggregateError) => {
        throw err.errors[0];
      });
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const agent_id = session.metadata?.agent_id;
        if (event.account || session.currency !== "usd" || session.payment_status !== "paid") return null;
        if (!agent_id || session.amount_total === null) return null;
        return {
          type: "topup.completed",
          agent_id,
          amount_cents: session.amount_total,
          ref: session.id,
          payer_email: session.customer_details?.email ?? null,
        };
      }
      if (event.type === "account.updated" && event.account) {
        const account = event.data.object;
        if (account.capabilities?.transfers === "active")
          return { type: "worker.onboarded", account_id: account.id };
      }
      return null;
    },
  };
}

const BRAND_STYLE = `*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#121820;background:#fafafa}
header{background:#121820;padding:.75rem max(1rem,calc(50% - 19rem))}
header a{display:inline-flex;align-items:center;gap:.6rem;color:#eef3f8;font-size:1.25rem;font-weight:750;letter-spacing:-.02em;text-decoration:none}
.mark{width:1.6rem;height:1rem;border-radius:50%;background:radial-gradient(circle,#121820 0 28%,#ffc24b 30%);box-shadow:0 0 .8rem rgba(255,194,75,.45)}
main{max-width:40rem;margin:0 auto;padding:1rem 1rem 3rem}
h1{font-size:1.5rem;margin:.5rem 0}`;

const shell = (title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>, style = "") =>
  html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>${raw(BRAND_STYLE + style)}</style></head>
<body><header><a href="/"><span class="mark"></span>Eyes</a></header>
<main>${body}</main>
</body>
</html>`;

const page = (title: string, text: string) => shell(title, html`<h1>${title}</h1><p>${text}</p>`);

async function explained(c: Context, respond: () => Promise<Response>) {
  try {
    return await respond();
  } catch (err) {
    if (!(err instanceof EyesError)) throw err;
    return c.html(page(err.message, err.fix), err.status as ContentfulStatusCode);
  }
}

const redirectTo = (c: Context, url: () => Promise<string>) =>
  explained(c, async () => c.redirect(await url(), 302));

export const PAGE_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const TASK_TYPE_LABELS: Record<TaskType, string> = {
  is_open: "Whether a place is open",
  line_length: "How long a line is",
  in_stock: "Whether something is in stock",
  photo_of_place: "A photo of a public place",
  price_check: "A price check",
  crowd_level: "How crowded a place is",
  other_public: "Other checks of public places",
};

const LEDGER_LABELS: Record<LedgerType, string> = {
  topup: "Funds added",
  escrow: "Held for a task",
  release: "Paid to a worker",
  fee: "Eyes fee",
  refund: "Refunded",
  payout: "Worker payout",
};

type Note = { text: string; error: boolean };
const SAVED: Note = { text: "Saved. The new limits apply to your agent's next request.", error: false };
const INVALID: Note = {
  text: "Nothing was saved. Max bounty must be a number from 0 to 100 USD, and the daily cap a number from 0 to 1000 USD.",
  error: true,
};

const OWNER_STYLE = `
h2{font-size:1.2rem;margin-top:2rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem}dt{color:#555}dd{margin:0;font-weight:600}
label{display:block;margin-top:1rem;font-weight:600}
input[type=number]{display:block;width:100%;font-size:1rem;padding:.6rem;margin-top:.25rem;border:1px solid #888;border-radius:.4rem}
fieldset{margin-top:1rem;border:1px solid #ccc;border-radius:.4rem}fieldset label{font-weight:400;margin-top:.5rem}
input[type=checkbox]{width:1.25rem;height:1.25rem;vertical-align:middle;margin:0 .5rem 0 0}
button,.button{display:inline-block;font-size:1rem;padding:.75rem 1.25rem;margin-top:1rem;border:0;border-radius:.5rem;background:#121820;color:#fff;text-decoration:none}
.note{padding:.75rem;border-radius:.5rem;background:#e6f4ea}.error{background:#fdecea}.hint{color:#555}
.danger{background:#a4231a}.key{font:1rem ui-monospace,monospace;word-break:break-all;padding:.75rem;border:1px solid #888;border-radius:.4rem;background:#fff}
ul{padding-left:1.25rem}li{margin-bottom:.75rem}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:.35rem .25rem;border-bottom:1px solid #ddd}`;

const usd = (n: number) => `$${n.toFixed(2)}`;
const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
const shortId = (id: string) => id.slice(0, 8);

const PAYOUT_LABELS: Record<NonNullable<WorkerEarnings["tasks"][number]["payout"]>, string> = {
  paid: "Paid",
  pending:
    "Not sent yet. If you have not finished payout setup, use the link we texted, or text START for a new one.",
  waiting_for_payout_setup: "Waiting for your payout setup",
};

function earningsPage(view: WorkerEarnings) {
  const waiting = view.tasks.some((t) => t.payout === "waiting_for_payout_setup");
  return shell(
    "Your Eyes earnings",
    html`<h1>Your earnings</h1>
<p>Keep this link private: anyone who has it can see where and when you did tasks. Links stop working 7 days after we text them; text HELP to the Eyes number for a new one.</p>
<dl>
<dt>Paid to you</dt><dd>${usd(view.paid_usd)}</dd>
<dt>Earned, not sent yet</dt><dd>${usd(view.pending_usd)}</dd>
</dl>
${waiting ? html`<p class="note">Some of your earnings are waiting for you to set up payouts. Open the payout link we texted you, or text START to the Eyes number for a new one.</p>` : ""}
<h2>Your recent tasks</h2>
${
  view.tasks.length
    ? html`<div class="scroll"><table>
<thead><tr><th scope="col">Place</th><th scope="col">Bounty</th><th scope="col">Task</th><th scope="col">Payout</th><th scope="col">Claimed</th></tr></thead>
<tbody>${view.tasks.map((t) => html`<tr><td>${t.place_label}</td><td>${usd(t.bounty_usd)}</td><td>${t.status.replaceAll("_", " ")}</td><td>${t.payout ? PAYOUT_LABELS[t.payout] : ""}${t.paid_at ? ` ${when(t.paid_at)}` : ""}</td><td>${when(t.claimed_at)}</td></tr>`)}</tbody>
</table></div>`
    : html`<p>No tasks yet. Reply YES to a task text to claim one.</p>`
}`,
    OWNER_STYLE,
  );
}

function ownerPage(view: OwnerConsole, token: string, note: Note | null, feeUsd: number) {
  const p = view.policy;
  return shell(
    "Eyes owner controls",
    html`<h1>${view.agent_name}</h1>
<p>Owner controls for your AI agent on Eyes, which pays nearby people a few dollars to check public places. Keep this link private: anyone who has it can change these limits. The first person who pays for this agent also gets this link.</p>
${note ? html`<p class="note${note.error ? " error" : ""}" role="status">${note.text}</p>` : ""}
<dl>
<dt>Balance</dt><dd>${usd(view.balance_usd)}</dd>
<dt>Held for open tasks</dt><dd>${usd(view.escrowed_usd)}</dd>
<dt>Spent today (UTC)</dt><dd>${p.daily_cap_usd === 0 ? "Frozen (daily cap $0)" : `${usd(p.spent_today_usd)} of ${usd(p.daily_cap_usd)}`}</dd>
</dl>
<p class="hint">Tasks nobody answers before the deadline, or that are cancelled, are refunded in full to the balance.</p>
${view.top_up_url ? html`<a class="button" href="${view.top_up_url}">Add funds</a>` : ""}
<h2>Spending limits</h2>
<form method="post" action="/owner/${token}/policy">
<label for="max_bounty_usd">Most it may pay a worker per task (USD)</label>
<input id="max_bounty_usd" name="max_bounty_usd" type="number" inputmode="decimal" min="0" max="100" step="0.01" required value="${p.max_bounty_usd.toFixed(2)}">
<label for="daily_cap_usd">Daily spending cap (USD)</label>
<input id="daily_cap_usd" name="daily_cap_usd" type="number" inputmode="decimal" min="0" max="1000" step="0.01" required value="${p.daily_cap_usd.toFixed(2)}" aria-describedby="cap-hint">
<p class="hint" id="cap-hint">A daily cap of 0 freezes all spending. Each task counts its bounty plus the ${usd(feeUsd)} Eyes fee.</p>
<fieldset><legend>Kinds of tasks it may post</legend>
${TASK_TYPES.map((t) => html`<label><input type="checkbox" name="allowed_task_types" value="${t}"${p.allowed_task_types.includes(t) ? html` checked` : ""}>${TASK_TYPE_LABELS[t]}</label>`)}
</fieldset>
<button type="submit">Save limits</button>
</form>
<h2>Recent tasks</h2>
${
  view.tasks.length
    ? html`<ul>${view.tasks.map((t) => html`<li><strong>${t.question}</strong><br>${t.place_label}<br>${t.status.replaceAll("_", " ")}, ${usd(t.bounty_usd)} bounty, ${when(t.created_at)}, task ${shortId(t.task_id)}</li>`)}</ul>`
    : html`<p>No tasks yet.</p>`
}
<h2>Money in and out</h2>
<div class="scroll"><table>
<thead><tr><th scope="col">What</th><th scope="col">Amount</th><th scope="col">Task</th><th scope="col">When</th></tr></thead>
<tbody>${view.ledger.map((l) => html`<tr><td>${LEDGER_LABELS[l.type]}</td><td>${usd(l.amount_usd)}</td><td>${l.task_id ? shortId(l.task_id) : ""}</td><td>${when(l.created_at)}</td></tr>`)}</tbody>
</table></div>
<h2>Replace this agent's API key</h2>
<p>If the API key may have leaked, replace it. The old key stops working immediately, so your agent cannot use Eyes until you give it the new key. The new key is shown once, on the next page.</p>
<form method="post" action="/owner/${token}/rotate-key">
<button class="danger" type="submit">Replace the API key</button>
</form>`,
    OWNER_STYLE,
  );
}

const newKeyPage = (apiKey: string, token: string) =>
  shell(
    "New API key",
    html`<h1>New API key</h1>
<p>The old key has stopped working. Give this new key to your agent now. This page shows it only once and Eyes cannot show it again; if you lose it, replace the key again.</p>
<p class="key">${apiKey}</p>
<p class="hint">Your agent sends it as the header Authorization: Bearer followed by the key.</p>
<a class="button" href="/owner/${token}">Back to owner controls</a>`,
    OWNER_STYLE,
  );

export function stripeRoutes(deps: RouteDeps, _env: Env): Hono {
  const app = new Hono();
  const pageHeaders = async (c: Context, next: Next) => {
    for (const [name, value] of Object.entries(PAGE_HEADERS)) c.header(name, value);
    await next();
  };
  for (const path of ["/topup/*", "/owner/*", "/w/connect/*", "/w/earnings/*"]) app.use(path, pageHeaders);

  app.post("/webhooks/stripe", async (c) => {
    const rawBody = await c.req.text();
    let event: PaymentsEvent | null;
    try {
      event = await deps.providers.payments.parseWebhook(rawBody, c.req.header("stripe-signature") ?? null);
    } catch (err) {
      if (err instanceof EyesError) {
        console.error(`stripe webhook: ${err.message}`);
        return c.text("Internal Server Error", 500);
      }
      return c.text(`Webhook Error: ${(err as Error).message}`, 400);
    }
    if (event?.type === "topup.completed") {
      await deps.service.creditTopup({
        agent_id: event.agent_id,
        amount_cents: event.amount_cents,
        stripe_ref: event.ref,
        payer_email: event.payer_email,
      });
    }
    if (event?.type === "worker.onboarded") await deps.service.markWorkerOnboarded(event.account_id);
    return c.json({ received: true });
  });

  app.get("/topup/done", (c) => {
    const cents = c.req.query("amount_cents") ?? "";
    const added = /^\d{1,6}$/.test(cents)
      ? `${usd(centsToUsd(Number(cents)))} added to your agent's balance.`
      : "Your payment was added to your agent's balance.";
    return c.html(
      page("Payment received", `${added} It can take a few seconds to show. You can close this page.`),
    );
  });
  app.get("/topup/cancel", (c) =>
    c.html(
      page(
        "Top-up cancelled",
        "Nothing was charged. To try again, reopen the top-up link your agent gave you. You can close this page.",
      ),
    ),
  );
  app.get("/topup/:token", (c) => {
    const query = c.req.query("amount_usd");
    const usd = query ? Number(query) : Number.NaN;
    const cents = Number.isFinite(usd) ? usdToCents(Math.min(100, Math.max(5, usd))) : undefined;
    return redirectTo(c, () => deps.service.topupCheckoutUrl(c.req.param("token"), cents));
  });

  const fee = centsToUsd(deps.config.fee_cents);
  const ownerView = (c: Context, note: Note | null, status: ContentfulStatusCode = 200) =>
    explained(c, async () => {
      const token = c.req.param("token") ?? "";
      return c.html(ownerPage(await deps.service.ownerConsole(token), token, note, fee), status);
    });
  const formNumber = (v: unknown) =>
    typeof v === "string" && /^\d+(\.\d{1,2})?$/.test(v.trim()) ? Number(v) : Number.NaN;

  app.get("/owner/:token", (c) => ownerView(c, c.req.query("saved") === undefined ? null : SAVED));
  app.post("/owner/:token/policy", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const input = OwnerPolicyInput.safeParse({
      max_bounty_usd: formNumber(form.max_bounty_usd),
      daily_cap_usd: formNumber(form.daily_cap_usd),
      allowed_task_types: [form.allowed_task_types ?? []].flat(),
    });
    if (!input.success) return ownerView(c, INVALID, 400);
    const token = c.req.param("token");
    return explained(c, async () => {
      await deps.service.updateSpendPolicy(token, input.data);
      return c.redirect(`/owner/${token}?saved=1`, 303);
    });
  });
  app.post("/owner/:token/rotate-key", (c) =>
    explained(c, async () => {
      const token = c.req.param("token");
      return c.html(newKeyPage((await deps.service.rotateApiKey(token)).api_key, token));
    }),
  );

  app.get("/w/connect/done", (c) =>
    c.html(
      page(
        "Payouts are set up",
        "You can close this tab. If Stripe still needs details from you, open the Eyes payout link again to finish.",
      ),
    ),
  );
  app.get("/w/earnings/:token", (c) =>
    explained(c, async () => c.html(earningsPage(await deps.service.workerEarnings(c.req.param("token"))))),
  );
  app.get("/w/connect/:token", (c) =>
    redirectTo(c, () => deps.service.workerConnectUrl(c.req.param("token"))),
  );

  return app;
}
