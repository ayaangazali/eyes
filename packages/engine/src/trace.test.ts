import { AppConfig, fakeProviders, type Providers } from "@eyes/core";
import { afterEach, expect, it, vi } from "vitest";
import { createEyesService } from "./index.ts";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@eyes/db", () => ({ createRpc: () => rpc }));
const task = { id: "11111111-2222-4333-8444-555555555555", status: "verified", bounty_cents: 300 };
const worker = {
  id: "worker",
  phone: "+15555550100",
  email: null,
  opted_in: true,
  stripe_account_id: "acct_private",
};
const makeService = (providers: Providers) =>
  createEyesService({
    db: { kind: "postgres", url: "unused" },
    providers,
    config: AppConfig.parse({
      public_api_url: "https://api.test",
      worker_web_url: "https://worker.test",
      link_secret: "test-secret-0123456789",
    }),
    assessTask: async () => ({ allowed: true, category: null, reason: null, fix: null, layer: null }),
    verifySubmission: vi.fn(),
  });

afterEach(() => vi.restoreAllMocks());

it.each(["payout", "notification"])(
  "keeps the task trace when a %s fails during a payout retry",
  async (failure) => {
    const providers = fakeProviders();
    const error = new Error("private provider response");
    if (failure === "payout")
      providers.payments.payoutWorker = async () => {
        throw error;
      };
    else
      providers.messaging.sendPaid = async () => {
        throw error;
      };
    rpc.mockImplementation(async (name: string) => {
      if (name === "eyes_payouts_due") return [{ task, worker }];
      if (name === "eyes_payout_begin") return [{ stripe_ref: "lease_private" }];
      if (name === "eyes_record_payout") return [{ ...task, status: "paid" }];
      return [];
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const service = makeService(providers);

    await expect(service.retryPayouts()).resolves.toEqual({ paid: failure === "payout" ? 0 : 1 });

    expect(errors.mock.calls).toContainEqual([expect.any(String), { task_id: task.id }]);
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/private|15555550100/);
  },
);

it("keeps the task trace when every offer fails without changing dispatch results", async () => {
  const providers = fakeProviders();
  providers.messaging.sendOffer = async () => {
    throw new TypeError("private provider response");
  };
  const offered = { ...task, status: "dispatched", lat: 10, lng: 20, deadline_at: "2026-10-28T00:00:00Z" };
  rpc.mockImplementation(async (name: string) => {
    if (name === "eyes_nearby_workers") return [{ ...worker, worker_id: worker.id, distance_m: 1 }];
    if (name === "eyes_dispatchable_workers") return [worker.id];
    if (name === "eyes_post_task") return [{ task: offered, created: true }];
    return [];
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  const result = await makeService(providers).askEyes(
    { id: "agent", allowed_task_types: ["is_open"], max_bounty_cents: 500 } as never,
    {
      question: "Is the cafe open?",
      location: { lat: 10, lng: 20 },
      task_type: "is_open",
      bounty_usd: 3,
      deadline_minutes: 10,
      require_photo: false,
      idempotency_key: "trace-offer",
    },
  );

  expect(result).toMatchObject({ task_id: task.id, workers_notified: 0, status: "dispatched" });
  expect(errors.mock.calls).toContainEqual([expect.any(String), { task_id: task.id }]);
  expect(JSON.stringify(errors.mock.calls)).not.toMatch(/private|15555550100/);
});
