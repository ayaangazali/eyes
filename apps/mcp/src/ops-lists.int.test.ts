import { randomUUID } from "node:crypto";
import { createRpc, migrate } from "@eyes/db";
import type { MiddlewareHandler } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpsEnv } from "./ops-auth.ts";
import { opsLists } from "./ops-lists.ts";

const url = process.env.DATABASE_URL;
const pass: MiddlewareHandler<OpsEnv> = async (_c, next) => next();

describe.skipIf(!url)("ops lists on Postgres (keyset paging)", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const app = opsLists({ rpc: createRpc({ kind: "postgres", url: url ?? "" }), operator: pass });
  // Every row this test makes carries the marker, and every query searches for it, so other rows
  // in the shared database never show up.
  // No 17 or 18 in it: the shown-only search cases below must not hit the marker.
  const marker = `pg${randomUUID()
    .slice(0, 8)
    .replace(/1(?=[78])/g, "a")}`;
  const AT = "2026-10-17T12:00:00.123456+00:00";
  // Only this test's rows: a microsecond-wide window around AT (the ledger shows no marker to search).
  const AT_WINDOW = "from=2026-10-17T12:00:00.123Z&to=2026-10-17T12:00:00.124Z";
  // Task ids whose shown 8-char prefix has no 17 or 18, so the search cases below cannot hit them.
  const taskId = (): string => {
    const id = randomUUID();
    return /1[78]/.test(id.slice(0, 8)) ? taskId() : id;
  };
  const get = async (path: string) => (await app.request(path)).json();

  async function all(path: string, key: string) {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const body = await get(`${path}${cursor ? `&cursor=${cursor}` : ""}`);
      ids.push(...body[key].map((r: { id: string | number }) => String(r.id)));
      cursor = body.next_cursor;
      if (!cursor) return { ids, total: body.total };
    }
    throw new Error("paging did not end");
  }

  let agent = "";
  let worker = "";
  const tasks: string[] = [];
  beforeAll(async () => {
    await migrate(url ?? "");
    [{ id: agent }] =
      (await sql`insert into agents (name, api_key_hash) values (${`bot ${marker}`}, ${marker})
      returning id`) as unknown as [{ id: string }];
    [{ id: worker }] = (await sql`insert into workers (phone, name, lat, lng, opted_in)
      values (${`+1555${Date.now() % 10_000_000}`}, ${marker}, 37.78, -122.4, true) returning id`) as unknown as [
      { id: string },
    ];
    // Seven of each, all at the same instant: only the id breaks ties.
    for (let i = 0; i < 7; i++) {
      const [task] =
        await sql`insert into tasks (id, agent_id, question, task_type, place_label, lat, lng, bounty_cents,
          fee_cents, deadline_at, status, created_at)
        values (${taskId()}, ${agent}, ${`q${i} ${marker}`}, 'is_open', 'Mint Plaza', 37.78, -122.4, ${100 + i}, 50,
          now() + interval '1 hour', ${i % 2 ? "paid" : "needs_review"}, ${AT}) returning id`;
      tasks.push(task?.id);
      await sql`insert into ledger (agent_id, task_id, type, amount_cents, created_at)
        values (${agent}, ${task?.id}, 'escrow', ${150 + i}, ${AT})`;
      await sql`insert into tickets (worker_id, task_id, kind, status, message, created_at, resolved_at)
        values (${worker}, ${task?.id}, 'manual_review', ${i < 3 ? "open" : "resolved"}, ${`help ${marker}`}, ${AT},
          ${i < 3 ? null : AT})`;
      await sql`insert into events (at, kind, level, summary) values (${AT}, 'http', ${i === 0 ? "error" : "info"},
        ${`e${i} ${marker}`})`;
    }
  });
  afterAll(async () => {
    await sql`delete from events where summary like ${`%${marker}`}`;
    await sql`delete from tickets where worker_id = ${worker}`;
    await sql`delete from ledger where agent_id = ${agent}`;
    await sql`delete from tasks where agent_id = ${agent}`;
    await sql`delete from workers where id = ${worker}`;
    await sql`delete from agents where id = ${agent}`;
    await sql.end();
  });

  it("pages events with equal timestamps without skipping or repeating, newest id first", async () => {
    const { ids } = await all(`/ops/events?limit=3&q=${marker}`, "events");
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    expect(ids).toEqual([...ids].sort((a, b) => Number(b) - Number(a)));
    const errors = await all(`/ops/events?limit=3&q=${marker}&level=error`, "events");
    expect(errors.ids).toHaveLength(1);
  });

  it("returns only newer events after a since cursor", async () => {
    const first = await get(`/ops/events?q=${marker}`);
    expect((await get(`/ops/events?q=${marker}&since=${first.newest_cursor}`)).events).toEqual([]);
    await sql`insert into events (at, kind, level, summary) values (${AT}, 'http', 'info', ${`late ${marker}`})`;
    const fresh = await get(`/ops/events?q=${marker}&since=${first.newest_cursor}`);
    expect(fresh.events.map((e: { summary: string }) => e.summary)).toEqual([`late ${marker}`]);
    expect(fresh.newest_cursor).not.toBe(first.newest_cursor);
  });

  it("pages tickets, tasks and the ledger the same way, with filters and the filtered sum", async () => {
    const tickets = await all(`/ops/tickets?limit=2&q=${marker}`, "tickets");
    expect([tickets.total, new Set(tickets.ids).size]).toEqual([7, 7]);
    expect((await all(`/ops/tickets?limit=2&q=${marker}&state=open`, "tickets")).ids).toHaveLength(3);
    expect((await all(`/ops/tickets?limit=2&q=${marker}&state=resolved`, "tickets")).ids).toHaveLength(4);

    const found = await all(`/ops/tasks?limit=3&q=${marker}`, "tasks");
    expect([found.total, new Set(found.ids).size]).toEqual([7, 7]);
    expect(new Set(found.ids)).toEqual(new Set(tasks));
    expect((await all(`/ops/tasks?limit=3&q=${marker}&status=paid`, "tasks")).ids).toHaveLength(3);
    const task = (await get(`/ops/tasks?limit=1&q=${marker}`)).tasks[0];
    expect(task).toMatchObject({ agent: `bot ${marker}`, distance_m: null, workers_notified: 0 });

    const ledger = await all(`/ops/ledger?limit=4&${AT_WINDOW}`, "ledger");
    expect([ledger.total, new Set(ledger.ids).size]).toEqual([7, 7]);
    const sum = await get(`/ops/ledger?limit=1&${AT_WINDOW}&type=escrow`);
    expect(sum.total_cents).toBe(150 * 7 + 21);
    expect(sum.ledger[0]).toMatchObject({ type: "escrow", place_label: "Mint Plaza" });
  });

  it("searches only what a row shows: the date in the browser's zone, labels, amounts and short ids", async () => {
    const count = async (path: string) => (await get(path)).total;
    // Everything is Oct 17 (amounts $1.50 to $1.56, ids without 17 or 18): "18" shows nowhere.
    expect(await count(`/ops/ledger?q=18&tz=UTC&${AT_WINDOW}`)).toBe(0);
    expect(await count(`/ops/ledger?q=Oct%2017&tz=UTC&${AT_WINDOW}`)).toBe(7);
    expect(await count(`/ops/ledger?q=17&tz=UTC&${AT_WINDOW}`)).toBe(7);
    expect(await count(`/ops/ledger?q=%241.53&tz=UTC&${AT_WINDOW}`)).toBe(1);
    expect(await count(`/ops/ledger?q=escrow&${AT_WINDOW}`)).toBe(7);
    // Noon UTC is 05:00 AM in Los Angeles: the date matches as that browser shows it.
    expect(await count(`/ops/ledger?q=05%3A00%3A00%20AM&tz=America%2FLos_Angeles&${AT_WINDOW}`)).toBe(7);
    expect(await count(`/ops/ledger?q=05%3A00%3A00%20AM&tz=Not%2FAZone&${AT_WINDOW}`)).toBe(0);
    const id = tasks[3] as string;
    expect((await get(`/ops/tasks?q=${id.slice(0, 8)}`)).tasks.map((t: { id: string }) => t.id)).toEqual([
      id,
    ]);
    // The full id is not shown, so it does not match.
    expect(await count(`/ops/tasks?q=${id}`)).toBe(0);
    expect(await count(`/ops/tasks?q=Oct%2017&tz=UTC&${AT_WINDOW}`)).toBe(7);
    expect(await count(`/ops/tasks?q=18&tz=UTC&${AT_WINDOW}`)).toBe(0);
    expect((await all(`/ops/events?q=18&tz=UTC&${AT_WINDOW}`, "events")).ids).toEqual([]);
    expect(
      (await all(`/ops/events?q=Oct%2017&tz=UTC&${AT_WINDOW}`, "events")).ids.length,
    ).toBeGreaterThanOrEqual(7);
  });
});
