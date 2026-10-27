import type { Rpc } from "@eyes/db";
import { describe, expect, it } from "vitest";
import { captureConsole, createEventLog, redact, summarize } from "./ops.ts";

const NOW = new Date("2026-10-17T20:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const ID = "6f1c2a9e-1b2c-4d3e-8f90-123456789abc";

describe("redact", () => {
  it.each([
    ["key=value", "INKBOX_API_KEY=ik_live_abc123 failed", "INKBOX_API_KEY=[redacted] failed"],
    ["JSON secret", '{"api_key":"eyes_abc"}', '{"api_key":"[redacted]"}'],
    ["bearer", "Authorization: Bearer abc.def.ghi", "Authorization: [redacted] [redacted]"],
    ["URL credentials", "postgres://admin:hunter2@db.internal", "postgres://[redacted]@db.internal"],
    ["email", "send to ops@example.com failed", "send to [email] failed"],
    ["E.164 phone", "text to +15555550100 failed", "text to [phone] failed"],
    ["US phone", "call (555) 555-0100", "call [phone]"],
    ["Stripe key", "sk_test_51Habc", "[secret]"],
    ["long token", `/ops/${"a1".repeat(32)}`, "/ops/[secret]"],
  ])("masks %s", (_, input, out) => expect(redact(input)).toBe(out));

  it("keeps task ids, dates and amounts", () => {
    const line = `task ${ID} at 2026-10-17 20:51:00 paid 350 cents`;
    expect(redact(line)).toBe(line);
  });

  it("keeps long snake_case identifiers such as gate names, still masks mixed-case or digit tokens", () => {
    const line = "gates denied: send_to_primitive_managed_domains, send_to_confirmed_domains";
    expect(redact(line)).toBe(line);
    expect(redact("send_to_Primitive_managed_domains_x")).toBe("[secret]");
    expect(redact("abcdefgh_ijklmnop_qrstuvwx_yz012345")).toBe("[secret]");
  });
});

describe("summarize", () => {
  const task = (status: string, h: number, id = ID) => ({ id, status, created_at: hoursAgo(h) });
  it("counts the last 24 h, money by type, workers, and the review queue with settle commands", () => {
    const s = summarize(
      {
        tasks: [task("needs_review", 1), task("paid", 2), task("paid", 30)],
        ledger: [
          { type: "release", amount_cents: 300, created_at: hoursAgo(1) },
          { type: "fee", amount_cents: 50, created_at: hoursAgo(1) },
          { type: "refund", amount_cents: 350, created_at: hoursAgo(40) },
        ],
        workers: [
          { lat: 1, lng: 1, available: true, opted_in: true },
          { lat: 1, lng: 1, available: false, opted_in: true },
          { lat: 1, lng: 1, available: true, opted_in: false },
        ],
        totals: { escrowed_cents: 0 },
      },
      500,
      NOW,
    );
    expect(s.statuses).toMatchObject({ needs_review: 1, paid: 1, dispatched: 0 });
    expect(s.money_24h).toMatchObject({ release: 300, fee: 50, refund: 0 });
    expect(s.workers).toEqual({ total: 3, opted_in: 2, online: 1 });
    expect(s.queue.map((t) => t.commands.refund)).toEqual([`pnpm resolve-task ${ID} refund "<note>"`]);
    expect(s.partial).toEqual({ tasks: false, ledger: false, workers: false });
  });

  it("leaves test runs and test workers out of counts, money and the review queue", () => {
    const s = summarize(
      {
        tasks: [
          task("needs_review", 1),
          { ...task("needs_review", 1, "test-task"), test: true },
          { ...task("paid", 1), test: true },
        ],
        ledger: [
          { type: "release", amount_cents: 300, created_at: hoursAgo(1) },
          { type: "release", amount_cents: 300, created_at: hoursAgo(1), test: true },
        ],
        workers: [
          { lat: 1, lng: 1, available: true, opted_in: true },
          { lat: null, lng: null, available: false, opted_in: true, test: true },
        ],
        totals: {},
      },
      500,
      NOW,
    );
    expect(s.statuses).toMatchObject({ needs_review: 1, paid: 0 });
    expect(s.money_24h.release).toBe(300);
    expect(s.workers).toEqual({ total: 1, opted_in: 1, online: 1 });
    expect(s.queue.map((t) => t.id)).toEqual([ID]);
  });

  it("flags partial counts when every fetched row is inside the window", () => {
    const s = summarize({ tasks: [task("paid", 1)], ledger: [], workers: [], totals: {} }, 1, NOW);
    expect(s.partial.tasks).toBe(true);
  });

  it("counts unknown task statuses and ledger types instead of dropping them", () => {
    const s = summarize(
      {
        tasks: [task("legacy_status", 1)],
        ledger: [{ type: "bonus", amount_cents: 75, created_at: hoursAgo(1) }],
        workers: [],
        totals: {},
      },
      10,
      NOW,
    );
    expect(s.statuses.legacy_status).toBe(1);
    expect(s.money_24h.bonus).toBe(75);
  });

  it("marks the ledger partial only when it is full and every row is inside the window", () => {
    const row = (h: number) => ({ type: "fee", amount_cents: 1, created_at: hoursAgo(h) });
    const inside = summarize({ tasks: [], ledger: [row(1), row(2)], workers: [], totals: {} }, 2, NOW);
    expect(inside.partial.ledger).toBe(true);
    const older = summarize({ tasks: [], ledger: [row(1), row(30)], workers: [], totals: {} }, 2, NOW);
    expect(older.partial.ledger).toBe(false);
  });
});

describe("event log", () => {
  it("redacts, keeps newest first in memory, and writes batches to the database", async () => {
    const writes: unknown[] = [];
    const rpc = (async (fn: string, args: Record<string, unknown>) => {
      writes.push({ fn, args });
      return [1];
    }) as Rpc;
    const events = createEventLog(rpc, 2, 60_000);
    events.log({ kind: "text", summary: "offer to +15555550100 sent" });
    events.log({ kind: "auth", summary: "code", data: { who: "ops@example.com" } });
    events.log({ kind: "http", level: "warn", summary: "GET /x 404" });
    expect(events.recent().map((e) => e.summary)).toEqual(["GET /x 404", "code"]);
    expect(events.recent()[1]?.data).toEqual({ who: "[email]" });
    await events.flush();
    expect(writes).toHaveLength(1);
    const [write] = writes as { fn: string; args: { p_events: { summary: string }[] } }[];
    expect(write?.fn).toBe("eyes_log_events");
    expect(write?.args.p_events.map((e) => e.summary)).toEqual([
      "offer to [phone] sent",
      "code",
      "GET /x 404",
    ]);
  });

  it("keeps events in memory when the database write fails", async () => {
    const events = createEventLog((async () => {
      throw new Error("down");
    }) as Rpc);
    const write = process.stderr.write;
    process.stderr.write = () => true;
    events.log({ kind: "http", summary: "GET / 200" });
    await events.flush();
    process.stderr.write = write;
    expect(events.recent()).toHaveLength(1);
  });

  it("captures console.error and console.warn as redacted log events", () => {
    const events = createEventLog();
    const target: Pick<Console, "error" | "warn"> = { error: () => {}, warn: () => {} };
    captureConsole(events.log, target);
    target.error("send failed for", "+15555550100", new Error("boom"));
    target.warn("slow");
    const [warn, error] = events.recent();
    expect(warn).toMatchObject({ kind: "log", level: "warn", summary: "slow" });
    expect(error?.summary).toContain("send failed for [phone] Error: boom");
  });

  it.each([ID, null, "not-a-uuid"])("stores only valid task context (%s)", async (task_id) => {
    const written: unknown[] = [];
    const events = createEventLog((async (_name, args) => {
      written.push(args);
      return [];
    }) as Rpc);
    const target: Pick<Console, "error" | "warn"> = { error: () => {}, warn: () => {} };
    captureConsole(events.log, target);

    target.error("dispatch failed", { task_id });
    await events.flush();

    const expected = task_id === ID ? ID : null;
    expect(events.recent()[0]).toMatchObject({ level: "error", task_id: expected });
    expect(written).toEqual([{ p_events: [expect.objectContaining({ task_id: expected })] }]);
  });
});
