import { type AssessTask, EyesError, type EyesService, fakeProviders } from "@eyes/core";
import type { OpsEvent } from "@eyes/web-dashboard";
import { describe, expect, it } from "vitest";
import { instrumentAssess, instrumentProviders, instrumentService } from "./instrument.ts";

const TASK = "11111111-2222-4333-8444-555555555555";
const sink = () => {
  const events: OpsEvent[] = [];
  return { events, log: (e: OpsEvent) => events.push(e) };
};

describe("instrumentProviders", () => {
  it("logs each outbound text and email by kind and task, never the recipient or body", async () => {
    const { events, log } = sink();
    const p = instrumentProviders(fakeProviders(), log);
    const offer = { task_id: TASK } as never;
    await p.messaging.sendOffer("+15550000000", offer);
    await p.messaging.sendCaptureLink("+15550000000", offer);
    await p.messaging.sendAlreadyClaimed("+15550000000", offer);
    await p.messaging.sendPaid("+15550000000", offer);
    await p.messaging.sendText("+15550000000", "secret body");
    await p.email.send({ to: "a@b.test", subject: "s", text: "t" } as never);
    expect(events).toEqual([
      { kind: "text", task_id: TASK, summary: "offer sent" },
      { kind: "text", task_id: TASK, summary: "capture link sent" },
      { kind: "text", task_id: null, summary: "already claimed sent" },
      { kind: "text", task_id: TASK, summary: "paid sent" },
      { kind: "text", task_id: null, summary: "text sent" },
      { kind: "email", task_id: null, summary: "email sent" },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/5550000000|secret body|a@b\.test/);
  });

  it("logs a failed send as an error with the error name and rethrows", async () => {
    const { events, log } = sink();
    const base = fakeProviders();
    base.messaging.sendText = async () => {
      throw new TypeError("boom");
    };
    base.email.send = () => Promise.reject("nope");
    const p = instrumentProviders(base, log);
    await expect(p.messaging.sendText("+1", "x")).rejects.toThrow("boom");
    await expect(p.email.send({} as never)).rejects.toBe("nope");
    expect(events).toEqual([
      { kind: "text", level: "error", task_id: null, summary: "text failed: TypeError" },
      { kind: "email", level: "error", task_id: null, summary: "email failed: string" },
    ]);
  });

  it("logs payouts with amount and outcome", async () => {
    const { events, log } = sink();
    const base = fakeProviders();
    const p = instrumentProviders(base, log);
    const payout = { account_id: "acct", amount_cents: 350, task_id: TASK, idempotency_key: "k" };
    await expect(p.payments.payoutWorker(payout)).resolves.toMatchObject({ transfer_id: expect.any(String) });
    base.payments.payoutWorker = async () => {
      throw new RangeError("stripe down");
    };
    await expect(p.payments.payoutWorker(payout)).rejects.toThrow("stripe down");
    expect(events).toEqual([
      { kind: "payout", task_id: TASK, summary: "payout 350c ok", data: { ok: true } },
      {
        kind: "payout",
        level: "error",
        task_id: TASK,
        summary: "payout 350c failed: RangeError",
        data: { ok: false },
      },
    ]);
    // Other payment methods pass straight through.
    expect(p.payments.reverseTransfer).toBe(base.payments.reverseTransfer);
  });

  it("logs vision verdicts as info when allowed and warn when blocked", async () => {
    const { events, log } = sink();
    const base = fakeProviders();
    const p = instrumentProviders(base, log);
    await p.vision.judge({} as never);
    base.vision.setVerdict({ allowed: false, reason: "faces", prominent_faces: true, confidence: 0.456 });
    await expect(p.vision.judge({} as never)).resolves.toMatchObject({ allowed: false });
    expect(events).toEqual([
      {
        kind: "vision",
        level: "info",
        summary: "safe to share (90%): The photo is safe to share.",
        data: { allowed: true, confidence: 0.9, prominent_faces: false },
      },
      {
        kind: "vision",
        level: "warn",
        summary: "blocked (46%): faces",
        data: { allowed: false, confidence: 0.456, prominent_faces: true },
      },
    ]);
  });
});

describe("instrumentAssess", () => {
  it("logs allowed and refused verdicts with layer and task type", async () => {
    const { events, log } = sink();
    const verdicts = [
      { allowed: true, category: null, reason: null, fix: null, layer: null },
      { allowed: false, category: "weapons", reason: "r", fix: "f", layer: "rules" },
    ] as const;
    let i = 0;
    const assess = instrumentAssess((async () => verdicts[i++]) as unknown as AssessTask, log);
    await assess({ task_type: "photo" } as never);
    await expect(assess({ task_type: "check" } as never)).resolves.toBe(verdicts[1]);
    expect(events).toEqual([
      {
        kind: "safety",
        level: "info",
        summary: "allowed by none",
        data: { allowed: true, layer: null, category: null, task_type: "photo" },
      },
      {
        kind: "safety",
        level: "warn",
        summary: "refused (weapons) by rules",
        data: { allowed: false, layer: "rules", category: "weapons", task_type: "check" },
      },
    ]);
  });
});

describe("instrumentService", () => {
  const agent = { id: "agent-1", allowed_task_types: ["photo"] };
  const make = <K extends string>(impl: Record<K, unknown>) => {
    const { events, log } = sink();
    const s = instrumentService(impl as unknown as EyesService, log);
    return { events, s: s as unknown as Record<K, (...a: unknown[]) => Promise<unknown>> };
  };

  it("passes authenticate and non-functions through untouched", () => {
    const authenticate = async () => agent;
    const { s } = make({ authenticate, version: 3 });
    expect(s.authenticate).toBe(authenticate);
    expect(s.version).toBe(3);
  });

  it("logs agent calls with agent id, task id, intent and snake_case method, never other args", async () => {
    const { events, s } = make({
      createTask: async () => ({ task_id: TASK }),
      getTask: async (_a: unknown, i: { task_id: string }) => ({ id: i.task_id }),
    });
    await s.createTask(agent, { intent: "check queue", lat: 1, lng: 2 });
    await s.getTask(agent, { task_id: TASK, intent: 7 });
    expect(events).toEqual([
      {
        kind: "call",
        task_id: TASK,
        summary: "create_task ok",
        data: { method: "create_task", ok: true, agent_id: "agent-1", intent: "check queue" },
      },
      {
        kind: "call",
        task_id: TASK,
        summary: "get_task ok",
        data: { method: "get_task", ok: true, agent_id: "agent-1" },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('"lat"');
  });

  it("takes the task id from a bare uuid argument and records resolve decisions and location source", async () => {
    const { events, s } = make({
      resolveTask: async () => null,
      updateWorkerLocation: async () => "ok",
      lookup: async () => ({}),
    });
    await s.resolveTask(TASK, "approve");
    await s.updateWorkerLocation("worker-1", { source: "gps", lat: 1, lng: 2 });
    await s.lookup("not-a-uuid");
    expect(events.map((e) => [e.task_id, e.data])).toEqual([
      [TASK, { method: "resolve_task", ok: true, decision: "approve" }],
      [null, { method: "update_worker_location", ok: true, source: "gps" }],
      [null, { method: "lookup", ok: true }],
    ]);
  });

  it("only logs quiet sweeps when they changed something", async () => {
    let expired = 0;
    const { events, s } = make({
      expireOverdue: async () => ({ expired }),
      retryPayouts: async () => ({ retried: 0, note: "x" }),
    });
    await s.expireOverdue();
    await s.retryPayouts();
    expired = 2;
    await s.expireOverdue();
    expect(events).toEqual([
      {
        kind: "call",
        task_id: null,
        summary: "expire_overdue ok",
        data: { method: "expire_overdue", ok: true },
      },
    ]);
  });

  it("logs failures with the EyesError code (warn under 500, error otherwise) and rethrows", async () => {
    const errors = [new EyesError("task_not_found"), new EyesError("not_implemented"), new SyntaxError("x")];
    let i = 0;
    const { events, s } = make({
      cancelTask: async () => {
        throw errors[i++];
      },
    });
    for (const err of errors) await expect(s.cancelTask(agent, { task_id: TASK })).rejects.toBe(err);
    expect(events.map((e) => [e.level, e.summary, e.task_id])).toEqual([
      ["warn", "cancel_task task_not_found", TASK],
      ["error", "cancel_task not_implemented", TASK],
      ["error", "cancel_task SyntaxError", TASK],
    ]);
    expect(events[0]?.data).toEqual({
      method: "cancel_task",
      ok: false,
      error: "task_not_found",
      agent_id: "agent-1",
    });
  });
});
