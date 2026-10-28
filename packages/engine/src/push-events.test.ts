import { AppConfig, EyesError, fakeProviders, signToken } from "@eyes/core";
import { afterEach, expect, it, vi } from "vitest";
import { createEyesService } from "./index.ts";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@eyes/db", () => ({ createRpc: () => rpc }));

const SECRET = "test-secret-0123456789";
const TASK = "11111111-2222-4333-8444-555555555555";
const sent = vi.fn();
const expo = async (_url: unknown, init?: RequestInit) => {
  sent(JSON.parse(String(init?.body)));
  return new Response(JSON.stringify({ data: [{ status: "ok" }] }));
};
const service = () =>
  createEyesService({
    db: { kind: "postgres", url: "unused" },
    providers: fakeProviders(),
    config: AppConfig.parse({
      public_api_url: "https://api.test",
      worker_web_url: "https://w.test",
      link_secret: SECRET,
    }),
    assessTask: async () => ({ allowed: true, category: null, reason: null, fix: null, layer: null }),
    verifySubmission: vi.fn(),
    fetch: expo as typeof fetch,
  });
// Answers the rpc calls a flow makes; the token lookup returns one device token.
const stub = (rows: Record<string, unknown[]>) =>
  rpc.mockImplementation(async (name: string) =>
    name === "eyes_push_tokens" ? [{ token: "ExponentPushToken[x]" }] : (rows[name] ?? []),
  );
const titles = () => sent.mock.calls.map((c) => c[0][0].title);

afterEach(() => {
  sent.mockClear();
  rpc.mockReset();
});

it("stores a worker token for a live code and an owner token for a live link", async () => {
  stub({ eyes_worker: [{ id: "w1" }], eyes_agent: [{ id: "a1", owner_link_version: 0 }] });
  const s = service();
  await s.workerPushToken(signToken(SECRET, "e:w1"), "ExponentPushToken[w]");
  await s.ownerPushToken(signToken(SECRET, "p:a1"), "ExponentPushToken[o]");
  expect(rpc).toHaveBeenCalledWith("eyes_add_push_token", {
    p_token: "ExponentPushToken[w]",
    p_worker_id: "w1",
    p_agent_id: null,
  });
  expect(rpc).toHaveBeenCalledWith("eyes_add_push_token", {
    p_token: "ExponentPushToken[o]",
    p_worker_id: null,
    p_agent_id: "a1",
  });
});

it("pushes the claiming worker when an owner disputes, and nobody when no one claimed", async () => {
  stub({ eyes_dispute: [{ id: TASK, claimed_by: "w1", bounty_cents: 100, fee_cents: 0 }] });
  await service().disputeAnswer({ id: "a1" } as never, { task_id: TASK, reason: "fake photo of a wall" });
  await vi.waitFor(() => expect(titles()).toEqual(["Your answer was disputed"]));
  sent.mockClear();
  stub({ eyes_dispute: [{ id: TASK, claimed_by: null, bounty_cents: 100, fee_cents: 0 }] });
  await service().disputeAnswer({ id: "a1" } as never, { task_id: TASK, reason: "fake photo of a wall" });
  expect(sent).not.toHaveBeenCalled();
});

it.each([
  ["rejected", true, ["Review decided", "Review decided"]],
  ["rejected", false, ["Review decided"]],
])("a %s dispute pushes the worker, and the owner when the task is found: %s", async (_n, found, want) => {
  stub({
    eyes_reject_dispute: [{ ticket: { id: 1, worker_id: "w1", task_id: TASK }, already: false }],
    eyes_resolve_task: [{ id: TASK, claimed_by: "w1", status: "paid", bounty_cents: 100, fee_cents: 0 }],
    eyes_worker: [{ id: "w1", opted_in: false }],
    eyes_task_detail: found ? [{ task: { id: TASK, agent_id: "a1" } }] : [],
  });
  await service().rejectDispute({ ticket_id: 1, note: "photo is real" });
  await vi.waitFor(() => expect(titles()).toEqual(want));
});

it("an upheld dispute pushes the worker and the owner", async () => {
  stub({
    eyes_confirm_fraud: [
      {
        ticket: { id: 1, worker_id: "w1", task_id: TASK, reversal_owed_cents: null },
        already: false,
        transfer_id: null,
        payout_cents: null,
        refund_cents: 100,
      },
    ],
    eyes_task_detail: [{ task: { id: TASK, agent_id: "a1" } }],
  });
  await service().confirmFraud({ ticket_id: 1, note: "fake photo confirmed" });
  await vi.waitFor(() => expect(titles()).toEqual(["Review decided", "Review decided"]));
});

it.each([
  ["ask", true],
  ["pause", false],
])("a spend cap with at_limit %s pushes the owner: %s", async (at_limit, pushed) => {
  const cap = new EyesError("daily_cap_exceeded", {
    daily_cap_cents: 100,
    spent_today_cents: 100,
    cap_period: "day",
    at_limit,
  });
  rpc.mockImplementation(async (name: string) => {
    if (name === "eyes_push_tokens") return [{ token: "ExponentPushToken[x]" }];
    if (name === "eyes_post_task") throw cap;
    return [];
  });
  await expect(
    service().askEyes(
      { id: "a1", allowed_task_types: ["is_open"], max_bounty_cents: 500 } as never,
      {
        question: "Is the cafe open?",
        location: { lat: 10, lng: 20 },
        task_type: "is_open",
        bounty_usd: 3,
        deadline_minutes: 10,
        idempotency_key: "k1",
      } as never,
    ),
  ).rejects.toMatchObject({ code: "daily_cap_exceeded" });
  if (pushed) await vi.waitFor(() => expect(titles()).toEqual(["Spend limit reached"]));
  else expect(sent).not.toHaveBeenCalled();
});
