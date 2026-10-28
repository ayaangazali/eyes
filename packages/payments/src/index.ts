import { createHash } from "node:crypto";
import {
  centsToUsd,
  EyesError,
  type LedgerType,
  type OwnerConsole,
  OwnerPolicyInput,
  type Payments,
  type PaymentsEvent,
  placeName,
  type RouteDeps,
  TASK_TYPES,
  type TaskStatus,
  type TaskType,
  TOOLS,
  usdToCents,
} from "@eyes/core";
import { PAGE_CSS, PAGE_HEADER } from "@eyes/ui/page";
import { type Context, Hono, type Next } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import Stripe from "stripe";

type Env = Record<string, string | undefined>;

// New connected accounts wait this long before Stripe pays out to the bank (Connect risk guidance).
const NEW_ACCOUNT_DELAY_DAYS = 7;
const schedule = (paused: boolean) =>
  paused
    ? { interval: "manual" as const }
    : { interval: "daily" as const, delay_days: NEW_ACCOUNT_DELAY_DAYS };

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
        success_url,
        cancel_url,
      });
      if (!session.url) throw new Error(`Stripe returned Checkout Session ${session.id} without a url`);
      return { url: session.url, session_id: session.id };
    },

    async createWorkerAccount({ worker_id, phone, email }) {
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
          settings: { payouts: { schedule: schedule(false) } },
          individual: { phone, email: email ?? undefined },
          business_profile: {
            product_description: "Paid by Eyes for on-the-spot photo checks of public places.",
          },
          metadata: { worker_id },
        },
        { idempotencyKey: `eyes-worker-account-${worker_id}` },
      );
      return { account_id: account.id };
    },

    async setPayoutsPaused({ account_id, paused }) {
      await stripe.accounts.update(account_id, { settings: { payouts: { schedule: schedule(paused) } } });
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

    async reverseTransfer({ transfer_id, amount_cents, idempotency_key }) {
      const reversal = await stripe.transfers.createReversal(
        transfer_id,
        { amount: amount_cents, metadata: { reason: "fraud" } },
        { idempotencyKey: idempotency_key },
      );
      return { reversal_id: reversal.id };
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

const shell = (title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) =>
  html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${title}</title>
<style>${raw(PAGE_CSS)}</style></head>
<body class="ui">${raw(PAGE_HEADER)}
<main class="page">${body}</main>
</body>
</html>`;

// One-message pages (payment received, payouts set up, errors): a framed card with the next step and
// a way out to the Eyes landing page, so a dead-end link never leaves people on a blank screen.
const page = (title: string, text: string) =>
  shell(
    title,
    html`<section class="notice-page"><h1>${title}</h1><p>${text}</p><a class="button" href="https://eyes.pictures">Go to eyes.pictures</a></section>`,
  );

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

// font-src: the h1 face (Instrument Sans) that @eyes/ui/page loads from /fonts on the API host.
export const PAGE_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
const AT_LIMIT_LABELS = { ask: "Ask me", pause: "Pause spending", notify: "Notify me" };
const INVALID: Note = {
  text: "Nothing was saved. Max bounty must be empty or a number from 0 to 50 USD, and the cap empty or a USD amount like 12 or 12.50.",
  error: true,
};
const UNCONFIRMED: Note = {
  text: "The API key was not replaced. Tick the box to confirm that the old key stops working now, then press Replace the API key.",
  error: true,
};

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

// Task status as the agent's owner reads it.
const OWNER_STATUS: Record<TaskStatus, { label: string; tone: "" | "success" | "warning" }> = {
  dispatched: { label: "Looking for a worker", tone: "" },
  claimed: { label: "Worker on the way", tone: "" },
  submitted: { label: "Checking the photo", tone: "" },
  verified: { label: "Answered", tone: "success" },
  paid: { label: "Answered and paid", tone: "success" },
  expired: { label: "Expired, refunded", tone: "" },
  refunded: { label: "Refunded", tone: "" },
  disputed: { label: "Disputed", tone: "warning" },
  needs_review: { label: "Needs review", tone: "warning" },
};

// Dates render in UTC on the server and switch to the reader's local time when scripts run.
// The page CSP allows exactly this script by hash.
const LOCAL_TIME =
  'const f=new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});for(const t of document.querySelectorAll("time[datetime]"))t.textContent=f.format(new Date(t.dateTime));';
const LOCAL_TIME_CSP = PAGE_HEADERS["Content-Security-Policy"].replace(
  "default-src 'none';",
  `default-src 'none'; script-src 'sha256-${createHash("sha256").update(LOCAL_TIME).digest("base64")}';`,
);

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
<dt>Spent ${p.cap_period === "day" ? "today" : `this ${p.cap_period}`} (UTC)</dt><dd>${p.daily_cap_usd === 0 ? "Frozen (cap $0)" : p.daily_cap_usd === null ? `${usd(p.spent_today_usd)}, no limit` : `${usd(p.spent_today_usd)} of ${usd(p.daily_cap_usd)}`}</dd>
</dl>
<p class="hint">Tasks nobody answers before the deadline, or that are cancelled, are refunded in full to the balance.</p>
${view.top_up_url ? html`<a class="button" href="${view.top_up_url}">Add funds</a>` : ""}
<h2>Spending limits</h2>
<form method="post" action="/owner/${token}/policy">
<label for="max_bounty_usd">Most it may pay a worker per task (USD)</label>
<input id="max_bounty_usd" name="max_bounty_usd" type="number" inputmode="decimal" min="0" max="50" step="0.01" value="${p.max_bounty_usd === null ? "" : p.max_bounty_usd.toFixed(2)}" aria-describedby="bounty-hint">
<p class="hint" id="bounty-hint">Leave empty for no limit. Eyes still caps every bounty at $50.</p>
<label for="daily_cap_usd">Spending cap (USD)</label>
<input id="daily_cap_usd" name="daily_cap_usd" type="number" inputmode="decimal" min="0" step="0.01" value="${p.daily_cap_usd === null ? "" : p.daily_cap_usd.toFixed(2)}" aria-describedby="cap-hint">
<label for="cap_period">Cap counts per</label>
<select id="cap_period" name="cap_period">${(["day", "week", "month"] as const).map((v) => html`<option value="${v}"${p.cap_period === v ? html` selected` : ""}>${v}</option>`)}</select>
<label for="at_limit">At the limit</label>
<select id="at_limit" name="at_limit">${(["ask", "pause", "notify"] as const).map((v) => html`<option value="${v}"${p.at_limit === v ? html` selected` : ""}>${AT_LIMIT_LABELS[v]}</option>`)}</select>
<p class="hint" id="cap-hint">Leave empty for no limit. A cap of 0 freezes all spending. Each task counts its bounty plus the ${usd(feeUsd)} Eyes fee. A week starts Monday and a month on the 1st, UTC.</p>
<fieldset><legend>Kinds of tasks it may post</legend>
${TASK_TYPES.map((t) => html`<label><input type="checkbox" name="allowed_task_types" value="${t}"${p.allowed_task_types.includes(t) ? html` checked` : ""}>${TASK_TYPE_LABELS[t]}</label>`)}
</fieldset>
<button type="submit">Save limits</button>
</form>
<h2>Recent tasks</h2>
${
  view.tasks.length
    ? html`<ol class="tasks">${view.tasks.map((t) => {
        const s = OWNER_STATUS[t.status];
        return html`<li class="task">
<div class="task__top"><span class="ui-badge${s.tone ? ` ui-badge--${s.tone}` : ""}">${s.label}</span><span class="task__bounty">${usd(t.bounty_usd)}</span></div>
<p class="task__question">${t.question}</p>
<p class="task__place">${placeName(t.place_label)}</p>
<p class="task__when">Asked <time datetime="${t.created_at}">${when(t.created_at)}</time></p>
</li>`;
      })}</ol>`
    : html`<p>No tasks yet.</p>`
}
<h2>Money in and out</h2>
${
  view.ledger.length
    ? html`<ol class="ledger">${view.ledger.map((l) => {
        const task = l.task_id ? view.tasks.find((t) => t.task_id === l.task_id)?.question : undefined;
        return html`<li><span class="ledger__what">${LEDGER_LABELS[l.type]}</span><span class="ledger__amount">${usd(l.amount_usd)}</span>
<span class="ledger__meta">${task ? html`${task} · ` : ""}<time datetime="${l.created_at}">${when(l.created_at)}</time></span></li>`;
      })}</ol>`
    : html`<p>No money in or out yet.</p>`
}
<h2>Replace this agent's API key</h2>
<p>If the API key may have leaked, replace it. The old key stops working immediately, so your agent cannot use Eyes until you give it the new key. The new key is shown once, on the next page.</p>
<form method="post" action="/owner/${token}/rotate-key">
<label><input type="checkbox" name="confirm" value="yes" required>I understand the old key stops working now, and my agent cannot use Eyes until I give it the new key.</label>
<button class="danger" type="submit">Replace the API key</button>
</form>
<script>${raw(LOCAL_TIME)}</script>`,
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
  );

function ownerJsonRoutes(app: Hono, deps: RouteDeps) {
  // JSON twins of the owner console (ADR-044). Same token, same service calls, same validation; the data
  // belongs to the token's agent only because every call below passes the token, never an agent id.
  const ownerJson = (c: Context, respond: (token: string) => Promise<unknown>) =>
    respond(c.req.param("token") ?? "").then(
      (body) => c.json(body as object),
      (err) => {
        if (!(err instanceof EyesError)) throw err;
        return c.json(
          err.toBody(),
          (err.code === "owner_link_invalid" ? 401 : err.status) as ContentfulStatusCode,
        );
      },
    );
  const badJson = (c: Context, issues: unknown) =>
    c.json({ ...new EyesError("invalid_input").toBody(), issues }, 400);
  const jsonBody = (c: Context) =>
    c.req.json().catch(() => undefined) as Promise<Record<string, unknown> | undefined>;

  app.get("/owner/:token/state.json", (c) => ownerJson(c, (token) => deps.service.ownerConsole(token)));
  app.get("/owner/:token/tasks.json", async (c) => {
    const query = TOOLS.list_tasks.input.safeParse({
      ...c.req.query(),
      ...(c.req.query("limit") === undefined ? {} : { limit: Number(c.req.query("limit")) }),
    });
    if (!query.success) return badJson(c, query.error.issues);
    return ownerJson(c, async (token) => {
      const { tasks, next_cursor } = await deps.service.ownerTasks(token, query.data);
      return { tasks, next_cursor };
    });
  });
  app.post("/owner/:token/policy.json", async (c) => {
    const input = OwnerPolicyInput.safeParse(await jsonBody(c));
    if (!input.success) return badJson(c, input.error.issues);
    return ownerJson(c, (token) => deps.service.updateSpendPolicy(token, input.data));
  });
  app.post("/owner/:token/rotate-key.json", async (c) => {
    if ((await jsonBody(c))?.confirm !== true)
      return badJson(c, [{ path: ["confirm"], message: 'Send {"confirm": true}.' }]);
    return ownerJson(c, (token) => deps.service.rotateApiKey(token));
  });
}

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
      console.error(err instanceof EyesError ? `stripe webhook: ${err.message}` : "stripe webhook rejected", {
        task_id: null,
        error: err instanceof EyesError ? err.code : err instanceof Error ? err.name : typeof err,
      });
      if (err instanceof EyesError) {
        return c.text("Internal Server Error", 500);
      }
      return c.text(`Webhook Error: ${(err as Error).message}`, 400);
    }
    if (event?.type === "topup.completed") {
      try {
        await deps.service.creditTopup({
          agent_id: event.agent_id,
          amount_cents: event.amount_cents,
          stripe_ref: event.ref,
          payer_email: event.payer_email,
        });
      } catch (err) {
        // The ledger row needs its agent in this database. A top-up for an agent this database lacks (for
        // example, a Checkout session made against another deployment) fails that foreign key. Only that
        // failure is acknowledged; any other credit error still answers 500 so Stripe retries it.
        if (!(err instanceof Error && err.message.includes("ledger_agent_id_fkey"))) throw err;
        console.error(
          `stripe top-up for unknown agent ${event.agent_id.slice(0, 8)}, not credited (session ${event.ref.slice(0, 12)})`,
        );
      }
    }
    if (event?.type === "worker.onboarded") await deps.service.markWorkerOnboarded(event.account_id);
    return c.json({ received: true });
  });

  app.get("/topup/done", (c) => {
    if (c.req.query("simulated") !== undefined) {
      return c.html(
        page(
          "Payments are simulated",
          "Payments are simulated on this server, so no money moved and nothing was added to your agent's balance. You can close this page.",
        ),
      );
    }
    return c.html(
      page(
        "Payment received",
        "Your payment was added to your agent's balance. It can take a few seconds to show. You can close this page.",
      ),
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
  const ownerView = (c: Context, note: Note | null, status: ContentfulStatusCode = 200) => {
    c.header("Content-Security-Policy", LOCAL_TIME_CSP);
    return explained(c, async () => {
      const token = c.req.param("token") ?? "";
      return c.html(ownerPage(await deps.service.ownerConsole(token), token, note, fee), status);
    });
  };
  // An empty field means no limit (null); anything else must be whole cents.
  const formNumber = (v: unknown) =>
    typeof v === "string" && v.trim() === ""
      ? null
      : typeof v === "string" && /^\d+(\.\d{1,2})?$/.test(v.trim())
        ? Number(v)
        : Number.NaN;

  app.get("/owner/:token", (c) => ownerView(c, c.req.query("saved") === undefined ? null : SAVED));
  app.post("/owner/:token/policy", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const input = OwnerPolicyInput.safeParse({
      max_bounty_usd: formNumber(form.max_bounty_usd),
      daily_cap_usd: formNumber(form.daily_cap_usd),
      cap_period: form.cap_period,
      at_limit: form.at_limit,
      allowed_task_types: [form.allowed_task_types ?? []].flat(),
    });
    if (!input.success) return ownerView(c, INVALID, 400);
    const token = c.req.param("token");
    return explained(c, async () => {
      await deps.service.updateSpendPolicy(token, input.data);
      return c.redirect(`/owner/${token}?saved=1`, 303);
    });
  });
  app.post("/owner/:token/rotate-key", async (c) => {
    if ((await c.req.parseBody()).confirm !== "yes") return ownerView(c, UNCONFIRMED, 400);
    return explained(c, async () => {
      const token = c.req.param("token");
      return c.html(newKeyPage((await deps.service.rotateApiKey(token)).api_key, token));
    });
  });
  ownerJsonRoutes(app, deps);

  app.get("/w/connect/done", (c) =>
    c.html(
      page(
        "Payouts are set up",
        "You can close this tab. If Stripe still needs details from you, open the Eyes payout link again to finish.",
      ),
    ),
  );
  // The earnings page is retired (T6.42, ADR-029): its "e:" token is the /me code (ADR-028), so old links open
  // the worker's task list. The code goes in the fragment only; no-store keeps the 301 out of caches.
  app.get("/w/earnings/:token", (c) => {
    const token = c.req.param("token");
    return c.redirect(
      `${deps.config.worker_web_url}/me${/^[\w-]+\.[\w-]+$/.test(token) ? `#c=${token}` : ""}`,
      301,
    );
  });
  app.get("/w/connect/:token", (c) =>
    deps.config.live_payouts
      ? redirectTo(c, () => deps.service.workerConnectUrl(c.req.param("token")))
      : c.html(
          page(
            "Payouts are simulated",
            "This is a test server and payouts are simulated, so there is nothing to set up and no real money is paid. You can close this page.",
          ),
        ),
  );

  return app;
}
