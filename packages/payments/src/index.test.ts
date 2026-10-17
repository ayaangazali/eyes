import {
  AppConfig,
  EyesError,
  type EyesService,
  FAKE_STRIPE_SIGNATURE,
  fakeProviders,
  type OwnerConsole,
  type OwnerPolicyInput,
  type Payments,
} from "@eyes/core";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStripePayments, stripeRoutes } from "./index.ts";

type Captured = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, string>;
};

const http = vi.hoisted(() => ({
  captured: [] as Captured[],
  response: {} as Record<string, unknown>,
  queue: [] as Record<string, unknown>[],
}));

vi.mock("stripe", async (importOriginal) => {
  const mod = await importOriginal<{ default: typeof Stripe }>();
  const stubFetch = async (url: string | URL | Request, init?: RequestInit) => {
    http.captured.push({
      method: String(init?.method),
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: Object.fromEntries(new URLSearchParams(String(init?.body ?? "")).entries()),
    });
    return new Response(JSON.stringify(http.queue.shift() ?? http.response), {
      status: 200,
      headers: { "content-type": "application/json", "request-id": "req_1" },
    });
  };
  class StubbedStripe extends mod.default {
    constructor(key: string) {
      super(key, { httpClient: mod.default.createFetchHttpClient(stubFetch) });
    }
  }
  return { ...mod, default: StubbedStripe };
});

beforeEach(() => {
  http.captured.length = 0;
  http.queue.length = 0;
});

const TASK_ID = "6f1c2b0e-8a4d-4c1e-9b7a-2d3e4f5a6b7c";
const OWNER_VIEW: OwnerConsole = {
  agent_id: "0b9e8d7c-6a5b-4c3d-8e2f-1a0b9c8d7e6f",
  agent_name: "Scout <b>bot</b>",
  balance_usd: 16.5,
  escrowed_usd: 3.5,
  policy: {
    max_bounty_usd: 10,
    daily_cap_usd: 20,
    spent_today_usd: 3.5,
    remaining_today_usd: 16.5,
    allowed_task_types: ["is_open", "line_length"],
  },
  tasks: [
    {
      task_id: TASK_ID,
      question: '<script>alert("owned")</script> Is it open?',
      place_label: "Cafe & Co",
      status: "dispatched",
      bounty_usd: 3,
      created_at: "2026-10-17T09:15:00.000Z",
    },
  ],
  ledger: [{ type: "escrow", amount_usd: 3.5, task_id: TASK_ID, created_at: "2026-10-17T09:15:00.000Z" }],
  top_up_url: "https://api.eyes.test/topup/agent-tok",
};

function setup(payments: Payments = fakeProviders().payments) {
  const service = {
    creditTopup: vi.fn(async () => {}),
    markWorkerOnboarded: vi.fn(async () => {}),
    topupCheckoutUrl: vi.fn(
      async (token: string, cents?: number) => `https://checkout.test/${token}/${cents}`,
    ),
    workerConnectUrl: vi.fn(async (token: string) => {
      if (token === "expired") throw new EyesError("offer_invalid");
      return `https://connect.test/${token}`;
    }),
    ownerConsole: vi.fn(async (token: string) => {
      if (token !== "owner-tok") throw new EyesError("owner_link_invalid");
      return OWNER_VIEW;
    }),
    updateSpendPolicy: vi.fn(async (token: string, _input: OwnerPolicyInput) => {
      if (token !== "owner-tok") throw new EyesError("owner_link_invalid");
      return OWNER_VIEW.policy;
    }),
  };
  const config = AppConfig.parse({
    public_api_url: "https://api.eyes.test",
    worker_web_url: "https://w.eyes.test",
    link_secret: "0123456789abcdef",
  });
  const app = stripeRoutes(
    { service: service as unknown as EyesService, providers: { ...fakeProviders(), payments }, config },
    {},
  );
  const webhook = (body: unknown, signature = FAKE_STRIPE_SIGNATURE) =>
    app.request("/webhooks/stripe", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "stripe-signature": signature },
    });
  return { app, service, webhook };
}

describe("stripeRoutes", () => {
  it("rejects a bad signature with 400 and never touches the service", async () => {
    const { service, webhook } = setup();
    const event = { type: "topup.completed", agent_id: "agt_1", amount_cents: 2000, ref: "cs_1" };
    const res = await webhook(event, "forged");
    expect(res.status).toBe(400);
    expect(service.creditTopup).not.toHaveBeenCalled();
  });

  it("credits a completed top-up with the exact cents and the session as stripe_ref", async () => {
    const { service, webhook } = setup();
    const res = await webhook({
      type: "topup.completed",
      agent_id: "agt_1",
      amount_cents: 2050,
      ref: "cs_1",
    });
    expect(res.status).toBe(200);
    expect(service.creditTopup).toHaveBeenCalledWith({
      agent_id: "agt_1",
      amount_cents: 2050,
      stripe_ref: "cs_1",
    });
  });

  it("marks a worker onboarded", async () => {
    const { service, webhook } = setup();
    const res = await webhook({ type: "worker.onboarded", account_id: "acct_1" });
    expect(res.status).toBe(200);
    expect(service.markWorkerOnboarded).toHaveBeenCalledWith("acct_1");
  });

  it("acknowledges events it does not handle with 200", async () => {
    const { service, webhook } = setup();
    const res = await webhook(null);
    expect(res.status).toBe(200);
    expect(service.creditTopup).not.toHaveBeenCalled();
    expect(service.markWorkerOnboarded).not.toHaveBeenCalled();
  });

  it("answers 500 when crediting fails so Stripe retries", async () => {
    const { service, webhook } = setup();
    service.creditTopup.mockRejectedValueOnce(new Error("db down"));
    const res = await webhook({ type: "topup.completed", agent_id: "agt_1", amount_cents: 500, ref: "cs_2" });
    expect(res.status).toBe(500);
  });

  it("answers a generic 500 without naming the missing webhook secret", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { service, webhook } = setup(createStripePayments({ STRIPE_SECRET_KEY: "sk_test_unit" }));
    const res = await webhook({}, "t=1,v1=x");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/STRIPE|secret/i);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("STRIPE_WEBHOOK_SECRET"));
    expect(service.creditTopup).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("redirects a top-up link to Checkout with the amount clamped to 5..100 USD", async () => {
    const { app, service } = setup();
    const res = await app.request("/topup/tok?amount_usd=20");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://checkout.test/tok/2000");
    await app.request("/topup/tok?amount_usd=500");
    await app.request("/topup/tok?amount_usd=1");
    await app.request("/topup/tok");
    expect(service.topupCheckoutUrl.mock.calls.map((call) => call[1])).toEqual([2000, 10000, 500, undefined]);
  });

  it("serves the done and cancel pages instead of treating them as tokens", async () => {
    const { app, service } = setup();
    for (const path of ["/topup/done", "/topup/cancel", "/w/connect/done"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    }
    expect(service.topupCheckoutUrl).not.toHaveBeenCalled();
    expect(service.workerConnectUrl).not.toHaveBeenCalled();
  });

  it("shows the top-up amount from the success URL and ignores a malformed one", async () => {
    const { app } = setup();
    const done = async (query: string) => (await app.request(`/topup/done${query}`)).text();
    expect(await done("?amount_cents=2050")).toContain("$20.50 added to your agent&#39;s balance.");
    for (const query of ["", "?amount_cents=20.5", "?amount_cents=1e9", "?amount_cents=<b>"]) {
      expect(await done(query)).toContain("Your payment was added to your agent&#39;s balance.");
    }
  });

  it("redirects a worker connect link to a freshly minted onboarding URL", async () => {
    const { app } = setup();
    const res = await app.request("/w/connect/tok");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://connect.test/tok");
  });

  it("explains an EyesError with its status", async () => {
    const { app } = setup();
    const res = await app.request("/w/connect/expired");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("invalid or has expired");
  });
});

describe("owner console routes", () => {
  const post = (app: ReturnType<typeof setup>["app"], token: string, body: string) =>
    app.request(`/owner/${token}/policy`, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  const privateHeaders = (res: Response) => ({
    referrer: res.headers.get("referrer-policy"),
    cache: res.headers.get("cache-control"),
    csp: res.headers.get("content-security-policy"),
  });
  const PRIVATE = {
    referrer: "no-referrer",
    cache: "no-store",
    csp: "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  };

  it("renders the console with agent-written text escaped and private-link headers", async () => {
    const { app } = setup();
    const res = await app.request("/owner/owner-tok");
    expect(res.status).toBe(200);
    expect(privateHeaders(res)).toEqual(PRIVATE);
    const body = await res.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;alert(&quot;owned&quot;)&lt;/script&gt; Is it open?");
    expect(body).toContain("Scout &lt;b&gt;bot&lt;/b&gt;");
    expect(body).toContain("Cafe &amp; Co");
    expect(body).toContain('value="is_open" checked>');
    expect(body).toContain('value="in_stock">');
    expect(body).toContain('href="https://api.eyes.test/topup/agent-tok"');
    expect(body).toContain('action="/owner/owner-tok/policy"');
  });

  it("saves posted limits, including several task types, and redirects back with a notice", async () => {
    const { app, service } = setup();
    const res = await post(
      app,
      "owner-tok",
      "max_bounty_usd=2.5&daily_cap_usd=0&allowed_task_types=is_open&allowed_task_types=in_stock",
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/owner/owner-tok?saved=1");
    expect(privateHeaders(res)).toEqual(PRIVATE);
    expect(service.updateSpendPolicy).toHaveBeenCalledWith("owner-tok", {
      max_bounty_usd: 2.5,
      daily_cap_usd: 0,
      allowed_task_types: ["is_open", "in_stock"],
    });
    await post(app, "owner-tok", "max_bounty_usd=3&daily_cap_usd=20");
    expect(service.updateSpendPolicy).toHaveBeenLastCalledWith("owner-tok", {
      max_bounty_usd: 3,
      daily_cap_usd: 20,
      allowed_task_types: [],
    });
    expect(await (await app.request("/owner/owner-tok?saved=1")).text()).toContain("Saved.");
  });

  it("re-renders invalid limits without saving, and answers a bad link with a 404 page", async () => {
    const { app, service } = setup();
    for (const body of [
      "max_bounty_usd=&daily_cap_usd=20",
      "max_bounty_usd=500&daily_cap_usd=20",
      "max_bounty_usd=0x10&daily_cap_usd=20",
      "max_bounty_usd=1.005&daily_cap_usd=20",
      "max_bounty_usd=3&daily_cap_usd=0.005",
    ]) {
      const res = await post(app, "owner-tok", body);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Nothing was saved.");
    }
    expect(service.updateSpendPolicy).not.toHaveBeenCalled();

    for (const res of [
      await app.request("/owner/agent-tok"),
      await post(app, "agent-tok", "max_bounty_usd=1&daily_cap_usd=1"),
    ]) {
      expect(res.status).toBe(404);
      expect(privateHeaders(res)).toEqual(PRIVATE);
      expect(await res.text()).toContain("This owner control link is invalid.");
    }
  });
});

describe("outbound Stripe requests", () => {
  const payments = createStripePayments({ STRIPE_SECRET_KEY: "sk_test_unit" });

  it("creates a card-only USD Checkout Session labelled with the agent", async () => {
    http.response = { id: "cs_1", object: "checkout.session", url: "https://checkout.stripe.com/c/cs_1" };
    const out = await payments.createTopupCheckout({
      agent_id: "agt_9",
      amount_cents: 2050,
      success_url: "https://api.eyes.test/topup/done",
      cancel_url: "https://api.eyes.test/topup/cancel",
    });
    expect(out).toEqual({ url: "https://checkout.stripe.com/c/cs_1", session_id: "cs_1" });
    expect(http.captured).toHaveLength(1);
    const [req] = http.captured;
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(req?.body).toEqual({
      mode: "payment",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][product_data][name]": "Eyes balance top-up",
      "line_items[0][price_data][unit_amount]": "2050",
      "line_items[0][quantity]": "1",
      "allowed_payment_method_types[0]": "card",
      client_reference_id: "agt_9",
      "metadata[agent_id]": "agt_9",
      "metadata[topup_cents]": "2050",
      "payment_intent_data[metadata][agent_id]": "agt_9",
      "payment_intent_data[transfer_group]": "topup_agt_9",
      success_url: "https://api.eyes.test/topup/done?amount_cents=2050",
      cancel_url: "https://api.eyes.test/topup/cancel",
    });
  });

  it("creates an Express-dashboard US individual account that can receive transfers, once per worker", async () => {
    http.response = { id: "acct_1", object: "account" };
    const out = await payments.createWorkerAccount({
      worker_id: "wkr_7",
      phone: "+14155550123",
      name: "Sam",
    });
    expect(out).toEqual({ account_id: "acct_1" });
    const [req] = http.captured;
    expect(req?.url).toBe("https://api.stripe.com/v1/accounts");
    expect(req?.headers["idempotency-key"]).toBe("eyes-worker-account-wkr_7");
    expect(req?.body).toEqual({
      "controller[fees][payer]": "application",
      "controller[losses][payments]": "application",
      "controller[stripe_dashboard][type]": "express",
      country: "US",
      business_type: "individual",
      "capabilities[transfers][requested]": "true",
      "individual[phone]": "+14155550123",
      "business_profile[product_description]": "Paid by Eyes for on-the-spot photo checks of public places.",
      "metadata[worker_id]": "wkr_7",
    });
  });

  it("creates an onboarding Account Link for currently due fields", async () => {
    http.response = { object: "account_link", url: "https://connect.stripe.com/setup/e/x" };
    const out = await payments.createOnboardingLink({
      account_id: "acct_1",
      refresh_url: "https://api.eyes.test/w/connect/tok",
      return_url: "https://api.eyes.test/w/connect/done",
    });
    expect(out).toEqual({ url: "https://connect.stripe.com/setup/e/x" });
    const [req] = http.captured;
    expect(req?.url).toBe("https://api.stripe.com/v1/account_links");
    expect(req?.body).toEqual({
      account: "acct_1",
      refresh_url: "https://api.eyes.test/w/connect/tok",
      return_url: "https://api.eyes.test/w/connect/done",
      type: "account_onboarding",
      "collection_options[fields]": "currently_due",
    });
  });

  const payout = {
    account_id: "acct_1",
    amount_cents: 300,
    task_id: "tsk_5",
    idempotency_key: "payout:tsk_5",
  };

  const ACTIVE = { id: "acct_1", object: "account", capabilities: { transfers: "active" } };
  const transferList = (data: Record<string, unknown>[]) => ({
    object: "list",
    url: "/v1/transfers",
    has_more: false,
    data,
  });
  const LOOKUP = "https://api.stripe.com/v1/transfers?transfer_group=task_tsk_5&limit=1";

  it("pays a worker with a Transfer carrying the caller's idempotency key once transfers are active", async () => {
    http.queue.push(ACTIVE, transferList([]), { id: "tr_1", object: "transfer" });
    const out = await payments.payoutWorker(payout);
    expect(out).toEqual({ transfer_id: "tr_1" });
    const [check, lookup, req] = http.captured;
    expect(check).toMatchObject({ method: "GET", url: "https://api.stripe.com/v1/accounts/acct_1" });
    expect(check?.headers["idempotency-key"]).toBeUndefined();
    expect(lookup).toMatchObject({ method: "GET", url: LOOKUP });
    expect(req?.url).toBe("https://api.stripe.com/v1/transfers");
    expect(req?.headers["idempotency-key"]).toBe("payout:tsk_5");
    expect(req?.body).toEqual({
      amount: "300",
      currency: "usd",
      destination: "acct_1",
      transfer_group: "task_tsk_5",
      "metadata[task_id]": "tsk_5",
    });
  });

  it("returns the Transfer an earlier attempt made for the task instead of sending another", async () => {
    http.queue.push(ACTIVE, transferList([{ id: "tr_earlier", object: "transfer" }]));
    expect(await payments.payoutWorker({ ...payout, idempotency_key: "payout:tsk_5:2" })).toEqual({
      transfer_id: "tr_earlier",
    });
    expect(http.captured.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET https://api.stripe.com/v1/accounts/acct_1",
      `GET ${LOOKUP}`,
    ]);
  });

  it("refuses an account whose transfers capability is not active without sending the idempotent Transfer", async () => {
    for (const capabilities of [{ transfers: "inactive" }, { transfers: "pending" }, {}, undefined]) {
      http.captured.length = 0;
      http.queue.push({ id: "acct_1", object: "account", capabilities });
      await expect(payments.payoutWorker(payout)).rejects.toThrow(/acct_1 cannot receive transfers yet/);
      expect(http.captured.map((r) => r.url)).toEqual(["https://api.stripe.com/v1/accounts/acct_1"]);
    }
  });
});

describe("createStripePayments().parseWebhook", () => {
  const secret = "whsec_unit_test_secret";
  const connectSecret = "whsec_unit_test_connect_secret";
  const payments = createStripePayments({
    STRIPE_SECRET_KEY: "sk_test_unit",
    STRIPE_WEBHOOK_SECRET: secret,
    STRIPE_CONNECT_WEBHOOK_SECRET: connectSecret,
  });
  const event = (type: string, object: Record<string, unknown>, account?: string) =>
    JSON.stringify({
      id: "evt_1",
      object: "event",
      ...(account && { account }),
      api_version: Stripe.API_VERSION,
      created: 1_792_000_000,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type,
      data: { object },
    });
  const session = (fields: Record<string, unknown> = {}, account?: string) =>
    event(
      "checkout.session.completed",
      {
        id: "cs_test_a1",
        object: "checkout.session",
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        currency: "usd",
        amount_total: 2000,
        client_reference_id: "agt_1",
        metadata: { agent_id: "agt_1" },
        ...fields,
      },
      account,
    );
  const sign = (payload: string, key = secret) =>
    Stripe.webhooks.generateTestHeaderString({ payload, secret: key });

  it("maps a signed, paid checkout.session.completed to topup.completed", async () => {
    const body = session();
    expect(await payments.parseWebhook(body, sign(body))).toEqual({
      type: "topup.completed",
      agent_id: "agt_1",
      amount_cents: 2000,
      ref: "cs_test_a1",
    });
  });

  it("rejects a tampered body and a missing signature", async () => {
    const body = session();
    const tampered = body.replace('"amount_total":2000', '"amount_total":999999');
    await expect(payments.parseWebhook(tampered, sign(body))).rejects.toThrow();
    await expect(payments.parseWebhook(body, null)).rejects.toThrow();
  });

  it("ignores sessions that are not paid USD top-ups on the platform account", async () => {
    for (const body of [
      session({ payment_status: "unpaid" }),
      session({ currency: "eur" }),
      session({}, "acct_connected"),
    ]) {
      expect(await payments.parseWebhook(body, sign(body))).toBeNull();
    }
  });

  it("maps a connected account's account.updated to worker.onboarded only once transfers are active", async () => {
    const account = (transfers: string, payouts_enabled: boolean, origin?: string) =>
      event(
        "account.updated",
        { id: "acct_1", object: "account", capabilities: { transfers }, payouts_enabled },
        origin,
      );
    const active = account("active", false, "acct_1");
    expect(await payments.parseWebhook(active, sign(active, connectSecret))).toEqual({
      type: "worker.onboarded",
      account_id: "acct_1",
    });
    for (const body of [account("pending", true, "acct_1"), account("active", true)]) {
      expect(await payments.parseWebhook(body, sign(body, connectSecret))).toBeNull();
    }
  });

  it("returns null for other event types", async () => {
    const body = event("payment_intent.succeeded", { id: "pi_1", object: "payment_intent" });
    expect(await payments.parseWebhook(body, sign(body))).toBeNull();
  });

  it("refuses to start without STRIPE_SECRET_KEY", () => {
    expect(() => createStripePayments({})).toThrow(/STRIPE_SECRET_KEY/);
  });

  it("refuses a live key unless EYES_TEST_MODE is exactly false", () => {
    for (const key of ["sk_live_unit", "rk_live_unit"]) {
      for (const mode of [undefined, "true", "FALSE", "0", ""]) {
        expect(() => createStripePayments({ STRIPE_SECRET_KEY: key, EYES_TEST_MODE: mode })).toThrow(
          /live key.*EYES_TEST_MODE/,
        );
      }
      expect(() => createStripePayments({ STRIPE_SECRET_KEY: key, EYES_TEST_MODE: "false" })).not.toThrow();
    }
    expect(() =>
      createStripePayments({ STRIPE_SECRET_KEY: "sk_test_unit", EYES_TEST_MODE: "true" }),
    ).not.toThrow();
  });
});
