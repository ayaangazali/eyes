import type { Rpc } from "@eyes/db";
import { createEventLog } from "@eyes/web-dashboard";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { OpsEnv } from "./ops-auth.ts";
import { decodeCursor, encodeCursor, opsLists } from "./ops-lists.ts";

const TASK = "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b";
const pass: MiddlewareHandler<OpsEnv> = async (_c, next) => next();

function setup(reply: (fn: string, args: Record<string, unknown>) => unknown) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const events = createEventLog();
  const rpc = (async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return reply(fn, args);
  }) as Rpc;
  const app = opsLists({ rpc, events, operator: pass });
  const get = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: await res.json(), cache: res.headers.get("cache-control") };
  };
  return { get, calls, events };
}

describe("cursors", () => {
  it("round-trips (created_at, id) and only under the same filters", () => {
    const f = { q: "gate", kind: null };
    const c = encodeCursor("2026-10-17T12:00:00.123456+00:00", 42, f);
    expect(c).toMatch(/^[\w-]+$/);
    expect(decodeCursor(c, f)).toEqual({ at: "2026-10-17T12:00:00.123456+00:00", id: "42" });
    expect(decodeCursor(c, { kind: null, q: "gate" })).toEqual({
      at: "2026-10-17T12:00:00.123456+00:00",
      id: "42",
    });
    expect(decodeCursor(c, { q: "other", kind: null })).toBe("bad");
    expect(decodeCursor(undefined, f)).toBeNull();
    expect(decodeCursor("", f)).toBeNull();
    const raw = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const bad of [
      "%%%",
      raw({ at: 1 }),
      raw(["nope", "1", "k"]),
      raw(["2026-10-17", 1, "k"]),
      raw([1, 2]),
    ])
      expect(decodeCursor(bad, f), bad).toBe("bad");
  });
});

describe("GET /ops/events", () => {
  const row = (id: number, at: string) => ({
    id,
    at,
    kind: "http",
    level: "info",
    summary: `e${id}`,
    total: 7,
  });

  it("pages newest first with filters in SQL, a next cursor on a full page, and the newest cursor", async () => {
    const { get, calls } = setup(() => [row(9, "2026-10-17T12:00:02Z"), row(8, "2026-10-17T12:00:01Z")]);
    const first = await get(`/ops/events?limit=2&kind=http&level=warn&q=%20boom%20&task_id=${TASK}`);
    expect(first.status).toBe(200);
    expect(first.cache).toBe("no-store");
    expect(first.body).toMatchObject({ source: "database" });
    expect(first.body.events).toEqual([
      { id: 9, at: "2026-10-17T12:00:02Z", kind: "http", level: "info", summary: "e9" },
      { id: 8, at: "2026-10-17T12:00:01Z", kind: "http", level: "info", summary: "e8" },
    ]);
    expect(calls[0]).toEqual({
      fn: "eyes_events_page",
      args: {
        p_limit: 2,
        p_kind: "http",
        p_level: "warn",
        p_q: "boom",
        p_task_id: TASK,
        p_before_at: null,
        p_before_id: null,
        p_after_at: null,
        p_after_id: null,
      },
    });
    const filters = `kind=http&level=warn&q=boom&task_id=${TASK}`;
    await get(`/ops/events?limit=2&${filters}&cursor=${first.body.next_cursor}`);
    expect(calls[1]?.args).toMatchObject({ p_before_at: "2026-10-17T12:00:01Z", p_before_id: 8 });
    await get(`/ops/events?${filters}&since=${first.body.newest_cursor}`);
    expect(calls[2]?.args).toMatchObject({ p_limit: 100, p_after_at: "2026-10-17T12:00:02Z", p_after_id: 9 });
  });

  it("has no next cursor on a short page or when polling, keeps since when nothing is new, and sanitises filters", async () => {
    let rows: unknown[] = [row(5, "2026-10-17T12:00:00Z")];
    const { get, calls } = setup(() => rows);
    const short = await get("/ops/events?limit=0&level=loud&task_id=nope&q=%20%20");
    expect(short.body.next_cursor).toBeNull();
    expect(calls[0]?.args).toMatchObject({
      p_limit: 100,
      p_level: null,
      p_task_id: null,
      p_q: null,
      p_kind: null,
    });
    const since = encodeCursor("2026-10-17T12:00:00Z", 5, {
      kind: null,
      level: null,
      q: null,
      task_id: null,
    });
    rows = [row(6, "2026-10-17T12:00:03Z")];
    const fresh = await get(`/ops/events?limit=1&since=${since}`);
    expect(fresh.body.next_cursor).toBeNull();
    rows = [];
    const none = await get(`/ops/events?since=${since}`);
    expect(none.body).toMatchObject({ events: [], newest_cursor: since, next_cursor: null });
    const empty = await get("/ops/events?limit=999");
    expect(empty.body.newest_cursor).toBeNull();
    expect(calls.at(-1)?.args.p_limit).toBe(200);
  });

  it("refuses a cursor from other filters or a malformed one", async () => {
    const { get, calls } = setup(() => []);
    const other = encodeCursor("2026-10-17T12:00:00Z", 5, {
      kind: "sms",
      level: null,
      q: null,
      task_id: null,
    });
    for (const query of [`cursor=${other}`, `since=${other}`, "cursor=zzz"]) {
      const res = await get(`/ops/events?${query}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_cursor");
    }
    expect(calls).toEqual([]);
  });

  it("falls back to the in-memory ring, filtered, when the database read fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { get, events } = setup(() => {
      throw new Error("db down");
    });
    events.log({ kind: "call", level: "warn", task_id: TASK, summary: "get_task task_not_found" });
    events.log({ kind: "call", level: "info", task_id: TASK, summary: "get_task ok", data: { Needle: 1 } });
    events.log({ kind: "text", level: "info", task_id: null, summary: "offer sent" });
    const summaries = async (query: string) => {
      const { body } = await get(`/ops/events${query}`);
      expect(body).toMatchObject({ source: "memory", next_cursor: null, newest_cursor: null });
      return body.events.map((e: { summary: string }) => e.summary).sort();
    };
    expect(await summaries("")).toEqual(["get_task ok", "get_task task_not_found", "offer sent"]);
    expect(await summaries("?kind=call&level=warn")).toEqual(["get_task task_not_found"]);
    expect(await summaries(`?task_id=${TASK}&q=NEEDLE`)).toEqual(["get_task ok"]);
    expect(await summaries("?limit=1")).toHaveLength(1);
    const since = encodeCursor("2026-10-17T12:00:00Z", 1, {
      kind: null,
      level: null,
      q: null,
      task_id: null,
    });
    expect(await summaries(`?since=${since}`)).toEqual([]);
    expect(errors).toHaveBeenCalledWith("ops events: database read failed:", "db down");
    const raw = setup(() => Promise.reject("raw"));
    expect((await raw.get("/ops/events")).body.events).toEqual([]);
    expect(errors).toHaveBeenCalledWith("ops events: database read failed:", "raw");
    errors.mockRestore();
  });

  it("serves the memory fallback without an event log too", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = opsLists({ rpc: (async () => Promise.reject(new Error("x"))) as Rpc, operator: pass });
    expect(await (await app.request("/ops/events")).json()).toMatchObject({ source: "memory", events: [] });
    errors.mockRestore();
  });
});

describe("GET /ops/tickets, /ops/tasks, /ops/ledger", () => {
  const T = { lat: 37.78, lng: -122.4, created_at: "2026-10-17T12:00:00Z", total: "3" };

  it("pages tickets with state, kind and search, without worker ids, with the answer distance", async () => {
    const { get, calls } = setup(() => [
      { ...T, id: 3, worker_id: "w1", submission_lat: 37.78, submission_lng: -122.4 },
      { ...T, id: 2, worker_id: "w2", submission_lat: null, submission_lng: -122.4 },
    ]);
    const first = await get("/ops/tickets?limit=2&state=open&kind=dispute&q=gate");
    expect(first.body.tickets).toEqual([
      { lat: 37.78, lng: -122.4, created_at: T.created_at, id: 3, distance_m: 0 },
      { lat: 37.78, lng: -122.4, created_at: T.created_at, id: 2, distance_m: null },
    ]);
    expect(first.body.total).toBe(3);
    expect(calls[0]).toEqual({
      fn: "eyes_tickets_page",
      args: {
        p_limit: 2,
        p_q: "gate",
        p_state: "open",
        p_kind: "dispute",
        p_before_at: null,
        p_before_id: null,
      },
    });
    await get(`/ops/tickets?limit=2&state=open&kind=dispute&q=gate&cursor=${first.body.next_cursor}`);
    expect(calls[1]?.args).toMatchObject({ p_before_at: T.created_at, p_before_id: 2 });
    await get("/ops/tickets?state=closed&kind=spam");
    expect(calls[2]?.args).toMatchObject({ p_limit: 50, p_state: null, p_kind: null, p_q: null });
    expect((await get(`/ops/tickets?cursor=${first.body.next_cursor}`)).status).toBe(400);
  });

  it("pages tasks by uuid cursor with status and search, and adds the answer distance", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const { get, calls } = setup(() => [
      { ...T, id, agent: "bot", submission_lat: 37.781, submission_lng: -122.4 },
    ]);
    const first = await get("/ops/tasks?limit=1&status=paid&q=bot");
    expect(first.body.tasks[0]).toMatchObject({ id, agent: "bot", distance_m: 111 });
    expect(first.body.tasks[0]).not.toHaveProperty("submission_lat");
    await get(`/ops/tasks?limit=1&status=paid&q=bot&cursor=${first.body.next_cursor}`);
    expect(calls[1]).toEqual({
      fn: "eyes_tasks_page",
      args: { p_limit: 1, p_q: "bot", p_status: "paid", p_before_at: T.created_at, p_before_id: id },
    });
    const notUuid = encodeCursor(T.created_at, 7, { q: null, status: null });
    expect((await get(`/ops/tasks?cursor=${notUuid}`)).status).toBe(400);
    expect((await get("/ops/tasks?cursor=zzz")).status).toBe(400);
  });

  it("pages the ledger with type and search, and returns the filtered count and sum", async () => {
    const id = "22222222-2222-4333-8444-555555555555";
    let rows: unknown[] = [
      { id, type: "fee", amount_cents: 50, created_at: T.created_at, total: 4, total_cents: "250" },
    ];
    const { get, calls } = setup(() => rows);
    const first = await get("/ops/ledger?limit=1&type=fee&q=gate");
    expect(first.body).toMatchObject({ total: 4, total_cents: 250 });
    expect(first.body.ledger).toEqual([{ id, type: "fee", amount_cents: 50, created_at: T.created_at }]);
    await get(`/ops/ledger?limit=1&type=fee&q=gate&cursor=${first.body.next_cursor}`);
    expect(calls[1]?.args).toMatchObject({ p_type: "fee", p_q: "gate", p_before_id: id });
    rows = [];
    expect((await get("/ops/ledger")).body).toEqual({
      ledger: [],
      total: 0,
      total_cents: 0,
      next_cursor: null,
    });
    const notUuid = encodeCursor(T.created_at, 7, { q: null, type: null });
    expect((await get(`/ops/ledger?cursor=${notUuid}`)).status).toBe(400);
    expect((await get("/ops/ledger?cursor=zzz")).status).toBe(400);
  });
});
