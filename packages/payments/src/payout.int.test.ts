import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { type Agent, AppConfig, fakeProviders, type VerificationResult } from "@eyes/core";
import type Stripe from "stripe";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { migrate } from "../../db/src/index.ts";
import { createEyesService } from "../../engine/src/index.ts";
import { createStripePayments } from "./index.ts";

const RUNS_LATE_MS = 2500;

const stripe = vi.hoisted(() => ({
  accounts: [] as string[],
  transfers: [] as { id: string; group: string }[],
  results: new Map<string, { id: string }>(),
  script: [] as ("late" | { status: number; body: unknown; should_retry: boolean })[],
}));

vi.mock("stripe", async (importOriginal) => {
  const mod = await importOriginal<{ default: typeof Stripe }>();
  const json = (status: number, body: unknown, should_retry = false) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "stripe-should-retry": String(should_retry) },
    });
  const execute = (key: string, group: string) => {
    const done = stripe.results.get(key);
    if (done) return done;
    const transfer = { id: `tr_s8_${stripe.transfers.length + 1}`, group };
    stripe.transfers.push(transfer);
    stripe.results.set(key, { id: transfer.id });
    return { id: transfer.id };
  };
  const stubFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const post = init?.method === "POST";
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (post && url.pathname === "/v1/accounts") {
      stripe.accounts.push(`acct_s8_${randomUUID()}`);
      return json(200, { id: stripe.accounts.at(-1), object: "account" });
    }
    if (post && url.pathname === "/v1/account_links") {
      return json(200, { object: "account_link", url: "https://connect.stripe.test/s8" });
    }
    if (url.pathname.startsWith("/v1/accounts/")) {
      return json(200, {
        id: url.pathname.split("/")[3],
        object: "account",
        capabilities: { transfers: "active" },
      });
    }
    const group = post ? (form.get("transfer_group") ?? "") : (url.searchParams.get("transfer_group") ?? "");
    if (!post) {
      const data = stripe.transfers
        .filter((t) => t.group === group)
        .map((t) => ({ ...t, object: "transfer" }));
      return json(200, { object: "list", url: "/v1/transfers", has_more: false, data });
    }
    const key = new Headers(init?.headers).get("idempotency-key") ?? "";
    const step = stripe.script.shift();
    if (step === "late") {
      setTimeout(() => execute(key, group), RUNS_LATE_MS);
      throw new TypeError("fetch failed: timed out");
    }
    if (step) return json(step.status, step.body, step.should_retry);
    return json(200, { ...execute(key, group), object: "transfer" });
  };
  class StubbedStripe extends mod.default {
    constructor(key: string, config?: Stripe.StripeConfig) {
      super(key, { ...config, httpClient: mod.default.createFetchHttpClient(stubFetch) });
    }
  }
  return { ...mod, default: StubbedStripe };
});

const url = process.env.DATABASE_URL ?? "";
const PASS: VerificationResult = {
  gps_ok: true,
  fresh_ok: true,
  vision_ok: true,
  vision_reason: "ok",
  worker_distance_m: 0,
  confidence: 0.9,
  auto_approve: true,
};

describe.skipIf(!url)("a payout whose first try Stripe runs late while a retry is rate limited", () => {
  beforeAll(() => migrate(url));

  const providers = {
    ...fakeProviders(),
    payments: createStripePayments({ STRIPE_SECRET_KEY: "sk_test_s8" }),
  };
  const service = createEyesService({
    db: { kind: "postgres", url },
    providers,
    assessTask: async () => ({ allowed: true, category: null, reason: null, fix: null, layer: null }),
    verifySubmission: async () => PASS,
    config: AppConfig.parse({
      public_api_url: "https://api.eyes.test",
      worker_web_url: "https://w.eyes.test",
      link_secret: "test-link-secret-0123456789",
      live_payouts: true,
    }),
  });
  const outbox = providers.messaging.outbox as { to: string; kind: string; payload: unknown }[];
  const rateLimited = (should_retry: boolean) => ({
    status: 429,
    should_retry,
    body: { error: { type: "rate_limit_error", code: "rate_limit", message: "Too many requests" } },
  });

  for (const [label, retries] of [
    ["S8: one retry answered 429", [rateLimited(false)]],
    ["S8c: two retries answered 429 with Stripe-Should-Retry", [rateLimited(true), rateLimited(true)]],
  ] as const) {
    it(`${label}: the onboarding webhook cannot pay the task a second time`, async () => {
      const at = { lat: 10 + Math.random() * 40, lng: -120 + Math.random() * 60 };
      const phone = `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;
      await service.joinWorker({ name: "Worker", phone, lat: at.lat + 0.0005, lng: at.lng });
      await service.handleWorkerReply({ phone, intent: "start", text: "START" });
      const start = String(
        outbox.findLast((m) => m.to === phone && String(m.payload).includes("/w/connect/"))?.payload,
      );
      // START ends with the setup link (ADR-028), so the token stops at the next space.
      await service.workerConnectUrl(/\/w\/connect\/(\S+)/.exec(start)?.[1] ?? "");
      const account = stripe.accounts.at(-1) ?? "";
      const agent = (await service.authenticate(
        (
          await service.signupAgent({ name: "s8" })
        ).api_key,
      )) as Agent;
      const { task_id } = await service.askEyes(agent, {
        question: "Is the line long?",
        location: at,
        task_type: "line_length",
        bounty_usd: 3,
        deadline_minutes: 30,
        require_photo: true,
        idempotency_key: randomUUID(),
      });
      await service.handleWorkerReply({ phone, intent: "yes", text: "YES" });
      const link = outbox.findLast((m) => m.to === phone && m.kind === "capture_link");
      const token =
        new URL(
          String((link?.payload as { capture_url?: string } | undefined)?.capture_url),
        ).searchParams.get("t") ?? "";

      stripe.script = ["late", ...retries];
      const capture = await service.submitCapture(
        token,
        {
          lat: at.lat,
          lng: at.lng,
          accuracy_m: 8,
          captured_at: providers.clock.now().toISOString(),
          answer_text: "short",
          answer_bool: null,
        },
        { bytes: new Uint8Array([255, 216, 255]), content_type: "image/jpeg" },
      );
      expect(capture.status).toBe("verified");
      expect(stripe.script).toEqual([]);

      await service.markWorkerOnboarded(account);
      await sleep(RUNS_LATE_MS + 300);
      expect(stripe.transfers.filter((t) => t.group === `task_${task_id}`)).toHaveLength(1);
      expect((await service.getTask(agent, { task_id })).status).toBe("verified");
    }, 15_000);
  }
});
