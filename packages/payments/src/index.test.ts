import { AppConfig, EyesError, type EyesService, FAKE_STRIPE_SIGNATURE, fakeProviders } from "@eyes/core";
import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { createStripePayments, stripeRoutes } from "./index.ts";

function setup() {
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
  };
  const config = AppConfig.parse({
    public_api_url: "https://api.eyes.test",
    worker_web_url: "https://w.eyes.test",
    link_secret: "0123456789abcdef",
  });
  const app = stripeRoutes(
    { service: service as unknown as EyesService, providers: fakeProviders(), config },
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

describe("createStripePayments().parseWebhook", () => {
  const secret = "whsec_unit_test_secret";
  const connectSecret = "whsec_unit_test_connect_secret";
  const payments = createStripePayments({
    STRIPE_SECRET_KEY: "sk_test_unit",
    STRIPE_WEBHOOK_SECRET: secret,
    STRIPE_CONNECT_WEBHOOK_SECRET: connectSecret,
  });
  const event = (type: string, object: Record<string, unknown>) =>
    JSON.stringify({
      id: "evt_1",
      object: "event",
      api_version: Stripe.API_VERSION,
      created: 1_792_000_000,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type,
      data: { object },
    });
  const session = (payment_status: string) =>
    event("checkout.session.completed", {
      id: "cs_test_a1",
      object: "checkout.session",
      mode: "payment",
      status: "complete",
      payment_status,
      currency: "usd",
      amount_total: 2000,
      client_reference_id: "agt_1",
      metadata: { agent_id: "agt_1" },
    });
  const sign = (payload: string) => Stripe.webhooks.generateTestHeaderString({ payload, secret });

  it("maps a signed, paid checkout.session.completed to topup.completed", async () => {
    const body = session("paid");
    expect(await payments.parseWebhook(body, sign(body))).toEqual({
      type: "topup.completed",
      agent_id: "agt_1",
      amount_cents: 2000,
      ref: "cs_test_a1",
    });
  });

  it("rejects a tampered body and a missing signature", async () => {
    const body = session("paid");
    const tampered = body.replace('"amount_total":2000', '"amount_total":999999');
    await expect(payments.parseWebhook(tampered, sign(body))).rejects.toThrow();
    await expect(payments.parseWebhook(body, null)).rejects.toThrow();
  });

  it("ignores an unpaid session", async () => {
    const body = session("unpaid");
    expect(await payments.parseWebhook(body, sign(body))).toBeNull();
  });

  it("maps a Connect-destination account.updated to worker.onboarded once the account can receive transfers", async () => {
    const signConnect = (payload: string) =>
      Stripe.webhooks.generateTestHeaderString({ payload, secret: connectSecret });
    const account = (transfers: string, payouts_enabled: boolean) =>
      event("account.updated", {
        id: "acct_1",
        object: "account",
        capabilities: { transfers },
        payouts_enabled,
      });
    const active = account("active", false);
    const pending = account("pending", false);
    const payouts = account("pending", true);
    expect(await payments.parseWebhook(active, signConnect(active))).toEqual({
      type: "worker.onboarded",
      account_id: "acct_1",
    });
    expect(await payments.parseWebhook(payouts, signConnect(payouts))).toEqual({
      type: "worker.onboarded",
      account_id: "acct_1",
    });
    expect(await payments.parseWebhook(pending, signConnect(pending))).toBeNull();
  });

  it("returns null for other event types", async () => {
    const body = event("payment_intent.succeeded", { id: "pi_1", object: "payment_intent" });
    expect(await payments.parseWebhook(body, sign(body))).toBeNull();
  });

  it("refuses to start without STRIPE_SECRET_KEY", () => {
    expect(() => createStripePayments({})).toThrow(/STRIPE_SECRET_KEY/);
  });
});
