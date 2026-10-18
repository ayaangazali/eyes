import type { Rpc } from "@eyes/db";
import { describe, expect, it } from "vitest";
import {
  buildSeries,
  type ClickHouseConfig,
  clickHouseConfig,
  createClickHouseSink,
  fallbackRows,
  mirrorTriggerEvents,
  readClickHouseSeries,
  toRow,
} from "./clickhouse.ts";
import { createEventLog, type LoggedEvent } from "./ops.ts";

const CFG: ClickHouseConfig = { url: "http://ch.test:8123", user: "eyes", password: "pw", database: "eyes" };
const AGENT = "0b6c8f9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const TASK = "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b";
const event = (over: Partial<LoggedEvent> = {}): LoggedEvent => ({
  at: "2026-10-17T20:00:00.000Z",
  kind: "http",
  level: "info",
  task_id: null,
  summary: "GET /healthz 200 3 ms",
  data: { method: "GET", path: "/healthz", status: 200, ms: 3 },
  ...over,
});

/** A fake ClickHouse HTTP endpoint: records each request, answers 500 while `down`. */
function fakeClickHouse() {
  const requests: { url: URL; body: string; auth: string | null }[] = [];
  const state = { down: false };
  const fetch = (async (url: string, init?: RequestInit) => {
    requests.push({
      url: new URL(url),
      body: String(init?.body),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return state.down ? new Response("Connection refused", { status: 500 }) : new Response("");
  }) as typeof globalThis.fetch;
  return { fetch, requests, state };
}

/** Collects what the code under test writes to stderr, so a test can assert the exact log line. */
function captureStderr() {
  const lines: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stderr.write = write;
    },
  };
}

describe("clickhouse config", () => {
  it("is off without CLICKHOUSE_URL and defaults user and database", () => {
    expect(clickHouseConfig({})).toBeNull();
    expect(clickHouseConfig({ CLICKHOUSE_URL: "http://ch:8123/" })).toEqual({
      url: "http://ch:8123",
      user: "default",
      password: "",
      database: "eyes",
    });
  });
});

describe("toRow", () => {
  it("maps requests, calls, task transitions and payouts to name and status", () => {
    expect(toRow(event())).toMatchObject({
      kind: "http",
      name: "/healthz",
      status: "200",
      ms: 3,
      task_id: null,
    });
    expect(
      toRow(
        event({
          kind: "call",
          task_id: TASK,
          summary: "ask_eyes insufficient_balance",
          data: { method: "ask_eyes", ok: false, error: "insufficient_balance", agent_id: AGENT },
        }),
      ),
    ).toMatchObject({
      name: "ask_eyes",
      status: "insufficient_balance",
      task_id: TASK,
      agent_id: AGENT,
      ms: 0,
    });
    expect(toRow(event({ kind: "call", data: { method: "quote_task", ok: true } }))).toMatchObject({
      status: "ok",
    });
    expect(
      toRow(
        event({ kind: "task", summary: "claimed -> submitted", data: { from: "claimed", to: "submitted" } }),
      ),
    ).toMatchObject({ status: "submitted" });
    expect(
      toRow(event({ kind: "payout", summary: "payout 300c failed", data: { ok: false } })),
    ).toMatchObject({
      name: "payout 300c failed",
      status: "failed",
    });
    expect(toRow(event({ data: { agent_id: "not-a-uuid" } })).agent_id).toBeNull();
  });

  it("only ever sees events the event log already redacted", async () => {
    const rows: string[] = [];
    const log = createEventLog(undefined, 10, 60_000, [(e) => rows.push(toRow(e).detail)]);
    log.log({
      kind: "log",
      level: "error",
      summary: "send to +15555550100 failed for ops@example.com",
      data: { authorization: "Bearer abc.def", url: "postgres://admin:hunter2@db" },
    });
    expect(rows[0]).not.toMatch(/15555550100|ops@example\.com|abc\.def|hunter2/);
    expect(JSON.parse(rows[0] ?? "")).toMatchObject({ summary: "send to [phone] failed for [email]" });
  });
});

describe("clickhouse sink", () => {
  it("batches rows into one JSONEachRow insert with basic auth", async () => {
    const ch = fakeClickHouse();
    const sink = createClickHouseSink(CFG, { fetch: ch.fetch, flushMs: 60_000 });
    sink.push(event());
    sink.push(event({ kind: "call", data: { method: "quote_task", ok: true } }));
    expect(ch.requests).toHaveLength(0);
    await sink.flush();
    sink.stop();
    expect(ch.requests).toHaveLength(1);
    const [req] = ch.requests;
    expect(req?.url.searchParams.get("query")).toBe("INSERT INTO events FORMAT JSONEachRow");
    expect(req?.url.searchParams.get("database")).toBe("eyes");
    expect(req?.auth).toBe(`Basic ${Buffer.from("eyes:pw").toString("base64")}`);
    expect(req?.body.split("\n").map((l) => JSON.parse(l).name)).toEqual(["/healthz", "quote_task"]);
  });

  it("flushes on its own once 500 rows wait, 500 rows per insert", async () => {
    const ch = fakeClickHouse();
    const sink = createClickHouseSink(CFG, { fetch: ch.fetch, flushMs: 60_000 });
    for (let i = 0; i < 1200; i++) sink.push(event());
    expect(ch.requests).toHaveLength(1);
    await sink.flush();
    await sink.flush();
    sink.stop();
    expect(ch.requests.map((r) => r.body.split("\n").length)).toEqual([500, 500, 200]);
  });

  it("keeps rows while ClickHouse is down, backs off, then delivers them", async () => {
    const ch = fakeClickHouse();
    let t = 0;
    const sink = createClickHouseSink(CFG, { fetch: ch.fetch, flushMs: 1000, now: () => t });
    const stderr = process.stderr.write;
    process.stderr.write = () => true;
    ch.state.down = true;
    sink.push(event());
    await sink.flush(); // fails: retry in 2 s
    t = 1999;
    await sink.flush(); // still backing off: no request
    expect(ch.requests).toHaveLength(1);
    t = 2000;
    await sink.flush(); // fails again: retry in 4 s
    t = 5999;
    await sink.flush();
    expect(ch.requests).toHaveLength(2);
    ch.state.down = false;
    t = 6000;
    await sink.flush();
    process.stderr.write = stderr;
    sink.stop();
    expect(ch.requests).toHaveLength(3);
    expect(ch.requests[2]?.body.split("\n")).toHaveLength(1);
    expect(sink.dropped()).toBe(0);
  });

  it("drops the oldest rows past maxQueue and counts them", async () => {
    const ch = fakeClickHouse();
    const sink = createClickHouseSink(CFG, { fetch: ch.fetch, flushMs: 60_000, maxQueue: 3 });
    for (const path of ["/a", "/b", "/c", "/d", "/e"]) sink.push(event({ data: { path, status: 200 } }));
    expect(sink.dropped()).toBe(2);
    await sink.flush();
    sink.stop();
    expect(ch.requests[0]?.body.split("\n").map((l) => JSON.parse(l).name)).toEqual(["/c", "/d", "/e"]);
  });

  it("logs a failed insert when fetch throws a plain value rather than an Error", async () => {
    const fetch = (async () => {
      throw "dns failure";
    }) as typeof globalThis.fetch;
    const cap = captureStderr();
    const sink = createClickHouseSink(CFG, { fetch, flushMs: 60_000 });
    sink.push(event());
    await sink.flush();
    cap.restore();
    sink.stop();
    expect(cap.lines).toEqual(["clickhouse insert failed (1): dns failure\n"]);
    expect(sink.dropped()).toBe(0);
  });

  it("query posts the SQL, parses one JSON row per line, and surfaces HTTP errors", async () => {
    const seen: { url: URL; body: string }[] = [];
    let status = 200;
    const fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url: new URL(url), body: String(init?.body) });
      return status === 200
        ? new Response(
            '{"minute":"2026-10-17 20:30:00","requests":4}\n{"minute":"2026-10-17 20:31:00","requests":1}\n',
          )
        : new Response("Code: 62. Syntax error", { status });
    }) as typeof globalThis.fetch;
    const sink = createClickHouseSink(CFG, { fetch, flushMs: 60_000 });
    const rows = await sink.query<{ minute: string; requests: number }>(
      "select minute, requests from requests_per_minute",
    );
    expect(rows).toEqual([
      { minute: "2026-10-17 20:30:00", requests: 4 },
      { minute: "2026-10-17 20:31:00", requests: 1 },
    ]);
    expect(seen[0]?.url.searchParams.get("default_format")).toBe("JSONEachRow");
    expect(seen[0]?.url.searchParams.get("database")).toBe("eyes");
    expect(seen[0]?.body).toBe("select minute, requests from requests_per_minute");
    status = 500;
    await expect(sink.query("select 1")).rejects.toThrow("ClickHouse 500: Code: 62. Syntax error");
    sink.stop();
  });
});

describe("mirrorTriggerEvents", () => {
  it("starts at the newest row, then pushes only new task, ledger and ticket rows, oldest first", async () => {
    let rows: (LoggedEvent & { id: number })[] = [{ ...event({ kind: "task" }), id: 7 }];
    const rpc = (async () => rows) as Rpc;
    const pushed: LoggedEvent[] = [];
    const mirror = mirrorTriggerEvents(rpc, (e) => pushed.push(e), 60_000);
    await mirror.tick();
    expect(pushed).toEqual([]);
    rows = [
      { ...event({ kind: "ledger", summary: "escrow 300c" }), id: 10 },
      { ...event({ kind: "http" }), id: 9 },
      { ...event({ kind: "task", summary: "dispatched" }), id: 8 },
      { ...event({ kind: "task" }), id: 7 },
    ];
    await mirror.tick();
    await mirror.tick();
    mirror.stop();
    expect(pushed.map((e) => e.summary)).toEqual(["dispatched", "escrow 300c"]);
    expect(pushed[0]).not.toHaveProperty("id");
  });

  it("keeps a trigger row with null data as an empty object", async () => {
    let rows: (LoggedEvent & { id: number })[] = [{ ...event({ kind: "task" }), id: 1 }];
    const rpc = (async () => rows) as Rpc;
    const pushed: LoggedEvent[] = [];
    const mirror = mirrorTriggerEvents(rpc, (e) => pushed.push(e), 60_000);
    await mirror.tick();
    rows = [{ ...event({ kind: "ledger" }), id: 2, data: null }] as unknown as typeof rows;
    await mirror.tick();
    mirror.stop();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.data).toEqual({});
  });

  it("logs a failed read for an Error or a plain value, then resumes from the same cursor", async () => {
    const state = { rows: [{ ...event({ kind: "task" }), id: 1 }], fail: null as unknown };
    const rpc = (async () => {
      if (state.fail !== null) throw state.fail;
      return state.rows;
    }) as Rpc;
    const pushed: LoggedEvent[] = [];
    const cap = captureStderr();
    const mirror = mirrorTriggerEvents(rpc, (e) => pushed.push(e), 60_000);
    await mirror.tick();
    state.fail = new Error("connection reset");
    await mirror.tick();
    state.fail = "socket hang up";
    await mirror.tick();
    state.fail = null;
    state.rows = [{ ...event({ kind: "task", summary: "dispatched" }), id: 2 }];
    await mirror.tick();
    cap.restore();
    mirror.stop();
    expect(cap.lines).toEqual([
      "clickhouse mirror read failed: connection reset\n",
      "clickhouse mirror read failed: socket hang up\n",
    ]);
    expect(pushed.map((e) => e.summary)).toEqual(["dispatched"]);
  });
});

describe("series", () => {
  const now = new Date("2026-10-17T20:30:30.000Z");

  it("fills 120 minutes and 24 hours with zeros where nothing happened", () => {
    const s = buildSeries(
      {
        requests: [{ minute: "2026-10-17 20:30:00", requests: 4, errors: 1 }],
        latency: [{ minute: "2026-10-17 20:30:00", p95: 120 }],
        tasks: [{ hour: "2026-10-17 20:00:00", status: "paid", tasks: 2 }],
        payouts: [{ hour: "2026-10-17 19:00:00", ok: 1, failed: 1 }],
      },
      now,
      "clickhouse",
    );
    expect(s.minutes).toHaveLength(120);
    expect(s.minutes.at(-1)).toBe("2026-10-17 20:30:00");
    expect([s.requests.at(-1), s.errors.at(-1), s.p95_ms.at(-1), s.requests.at(-2)]).toEqual([4, 1, 120, 0]);
    expect(s.hours).toHaveLength(24);
    expect(s.tasks.paid?.at(-1)).toBe(2);
    expect([s.payouts.ok.at(-2), s.payouts.failed.at(-2)]).toEqual([1, 1]);
  });

  it("falls back to the memory ring and the Postgres feed", () => {
    const rows = fallbackRows(
      [
        event({ at: "2026-10-17T20:30:05.000Z", data: { path: "/a", status: 200, ms: 10 } }),
        event({ at: "2026-10-17T20:30:09.000Z", data: { path: "/a", status: 502, ms: 900 } }),
        event({ at: "2026-10-17T20:30:09.000Z", kind: "call", data: {} }),
      ],
      {
        tasks: [{ status: "paid", created_at: "2026-10-17T20:10:00.000Z" }],
        ledger: [
          { type: "payout", created_at: "2026-10-17T20:11:00.000Z" },
          { type: "escrow", created_at: "2026-10-17T20:11:00.000Z" },
        ],
      },
    );
    const s = buildSeries(rows, now, "postgres");
    expect([s.requests.at(-1), s.errors.at(-1), s.p95_ms.at(-1)]).toEqual([2, 1, 900]);
    expect(s.tasks.paid?.at(-1)).toBe(1);
    expect(s.payouts.ok.at(-1)).toBe(1);
  });

  it("counts an http event with no ms, and reports p95 0 when the minute has no timing", () => {
    const rows = fallbackRows(
      [event({ at: "2026-10-17T20:30:20.000Z", data: { path: "/b", status: 200 } })],
      {
        tasks: [],
        ledger: [],
      },
    );
    const s = buildSeries(rows, now, "postgres");
    expect([s.requests.at(-1), s.errors.at(-1), s.p95_ms.at(-1)]).toEqual([1, 0, 0]);
  });

  it("reads the four views with one query each and returns their rows", async () => {
    const sql: string[] = [];
    const rowsFor = (q: string): unknown[] => {
      if (q.includes("from requests_per_minute"))
        return [{ minute: "2026-10-17 20:30:00", requests: 4, errors: 1 }];
      if (q.includes("from latency_per_minute")) return [{ minute: "2026-10-17 20:30:00", p95: 120 }];
      if (q.includes("from tasks_per_hour"))
        return [{ hour: "2026-10-17 20:00:00", status: "paid", tasks: 2 }];
      return [{ hour: "2026-10-17 19:00:00", ok: 1, failed: 1 }];
    };
    const rows = await readClickHouseSeries({
      query: async <T>(q: string) => {
        sql.push(q);
        return rowsFor(q) as T[];
      },
    });
    expect(sql).toHaveLength(4);
    expect(rows.requests).toEqual([{ minute: "2026-10-17 20:30:00", requests: 4, errors: 1 }]);
    expect(rows.latency).toEqual([{ minute: "2026-10-17 20:30:00", p95: 120 }]);
    expect(rows.tasks).toEqual([{ hour: "2026-10-17 20:00:00", status: "paid", tasks: 2 }]);
    expect(rows.payouts).toEqual([{ hour: "2026-10-17 19:00:00", ok: 1, failed: 1 }]);
  });
});
