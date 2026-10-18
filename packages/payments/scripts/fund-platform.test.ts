import Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { defaultStripe, type FundClient, fundPlatform, KEY_HELP, Refusal } from "./fund-platform.ts";

const env = { STRIPE_SECRET_KEY: "sk_test_fake" } as NodeJS.ProcessEnv;

type Opts = {
  livemode?: boolean;
  available?: { amount: number; currency: string }[];
  status?: string;
  createError?: Error;
};

function fake(opts: Opts = {}) {
  const create = vi.fn(async (_params: object) => {
    if (opts.createError) throw opts.createError;
    return { id: "pi_1", status: opts.status ?? "succeeded" };
  });
  const retrieve = vi.fn(async () => ({
    livemode: opts.livemode ?? false,
    available: opts.available ?? [{ amount: 10000, currency: "usd" }],
  }));
  const client: FundClient = { balance: { retrieve }, paymentIntents: { create } };
  const makeStripe = vi.fn((_key: string) => client);
  return { makeStripe, create, retrieve };
}

describe("fundPlatform", () => {
  it("funds 100 USD by default and reports the intent and balance", async () => {
    const { makeStripe, create } = fake();
    const out = await fundPlatform([], env, makeStripe);
    expect(makeStripe).toHaveBeenCalledWith("sk_test_fake");
    expect(create).toHaveBeenCalledWith({
      amount: 10000,
      currency: "usd",
      payment_method: "pm_card_bypassPending",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      confirm: true,
      description: "Eyes platform pre-funding so test payouts have available balance",
    });
    expect(out).toBe("pi_1 succeeded. Platform available balance: 100.00 USD");
  });

  it("converts the amount argument to cents", async () => {
    const { makeStripe, create } = fake();
    await fundPlatform(["25.5"], env, makeStripe);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ amount: 2550 }));
  });

  it("lists every available currency with two decimals", async () => {
    const { makeStripe } = fake({
      available: [
        { amount: 10000, currency: "usd" },
        { amount: 500, currency: "eur" },
      ],
    });
    await expect(fundPlatform([], env, makeStripe)).resolves.toBe(
      "pi_1 succeeded. Platform available balance: 100.00 USD, 5.00 EUR",
    );
  });

  it("prints an empty balance list when nothing is available", async () => {
    const { makeStripe } = fake({ available: [] });
    await expect(fundPlatform([], env, makeStripe)).resolves.toBe(
      "pi_1 succeeded. Platform available balance: ",
    );
  });

  it("prints the intent status exactly as Stripe returns it", async () => {
    const { makeStripe } = fake({ status: "requires_action" });
    await expect(fundPlatform([], env, makeStripe)).resolves.toMatch(/^pi_1 requires_action\. /);
  });

  it("refuses to run without a key, before calling Stripe", async () => {
    const { makeStripe } = fake();
    await expect(fundPlatform([], {}, makeStripe)).rejects.toThrow(KEY_HELP);
    expect(makeStripe).not.toHaveBeenCalled();
  });

  it("treats an empty key as missing", async () => {
    const { makeStripe } = fake();
    await expect(fundPlatform([], { STRIPE_SECRET_KEY: "" }, makeStripe)).rejects.toBeInstanceOf(Refusal);
    expect(makeStripe).not.toHaveBeenCalled();
  });

  it("refuses a live-mode key before creating any charge", async () => {
    const { makeStripe, create } = fake({ livemode: true });
    const err = await fundPlatform([], env, makeStripe).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Refusal);
    expect((err as Error).message).toMatch(/live-mode key/);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a non-numeric amount before any charge", async () => {
    const { makeStripe, create } = fake();
    await expect(fundPlatform(["twelve"], env, makeStripe)).rejects.toThrow(
      'Amount must be a positive number of USD, got "twelve".',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it.each([["0"], ["-5"], ["Infinity"], ["12abc"]])(
    "refuses the amount %s before any charge",
    async (raw) => {
      const { makeStripe, create } = fake();
      await expect(fundPlatform([raw], env, makeStripe)).rejects.toBeInstanceOf(Refusal);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("passes Stripe API errors through unchanged and does not label them as refusals", async () => {
    const stripeErr = new Error("card_declined");
    const { makeStripe } = fake({ createError: stripeErr });
    const err = await fundPlatform([], env, makeStripe).catch((e: unknown) => e);
    expect(err).toBe(stripeErr);
    expect(err).not.toBeInstanceOf(Refusal);
  });
});

describe("defaultStripe", () => {
  it("builds a real Stripe client for the key without contacting the API", () => {
    expect(defaultStripe("sk_test_fake")).toBeInstanceOf(Stripe);
  });
});
