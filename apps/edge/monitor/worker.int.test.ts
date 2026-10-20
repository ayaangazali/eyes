import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppConfig, fakeProviders } from "../../../packages/core/src/index.ts";
import { migrate } from "../../../packages/db/src/index.ts";
import { createEyesService } from "../../../packages/engine/src/index.ts";
// @ts-expect-error untyped worker module; the Workers types are not in this package.
import monitor from "./worker.js";

const url = process.env.DATABASE_URL ?? "";

describe.skipIf(!url)("monitor expiry with Postgres", () => {
  const sql = postgres(url, { onnotice: () => {}, max: 4 });
  const providers = fakeProviders();
  const service = createEyesService({
    db: { kind: "postgres", url },
    providers,
    assessTask: async () => ({ allowed: true, category: null, reason: null, fix: null, layer: null }),
    verifySubmission: async () => {
      throw new Error("unused");
    },
    config: AppConfig.parse({
      public_api_url: "https://api.test",
      worker_web_url: "https://worker.test",
      link_secret: "test-link-secret-0123456789",
    }),
  });
  const env = {
    HEALTH_URL: "https://api.test/healthz",
    INSFORGE_BASE_URL: "https://db.test/",
    INSFORGE_API_KEY: "test-key",
    EYES_MONITOR: { get: async () => null, put: async () => {} },
  };

  beforeAll(() => migrate(url));
  afterAll(() => sql.end());
  afterEach(() => vi.unstubAllGlobals());

  it.each([false, true])("refunds once with the server sweep running: %s", async (concurrent) => {
    const [agent] = await sql`insert into agents (name, api_key_hash, balance_cents)
      values ('expiry', gen_random_uuid()::text, 1010) returning id`;
    const tasks = await sql`insert into tasks
      (agent_id, question, task_type, place_label, lat, lng, bounty_cents, fee_cents, deadline_at, status)
      select ${agent?.id}, 'Open?', 'is_open', 'Cafe', 1, 1, 300, 30,
        now() + make_interval(mins => mins), status
      from (values (-1, 'dispatched'), (-1, 'claimed'), (60, 'dispatched')) as t(mins, status)
      returning id, status, deadline_at`;
    await sql`insert into ledger (agent_id, task_id, type, amount_cents)
      select agent_id, id, 'escrow', bounty_cents + fee_cents from tasks where agent_id = ${agent?.id}`;
    const expiredIds = tasks
      .filter((t) => t.deadline_at < new Date())
      .map((t) => t.id)
      .sort();

    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (input === env.HEALTH_URL) return new Response("down", { status: 503 });
      expect(input).toBe("https://db.test/api/database/rpc/eyes_expire_overdue");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      const { p_now } = JSON.parse(String(init?.body));
      const rows = await sql`select * from eyes_expire_overdue(${p_now})`;
      return Response.json(rows);
    });

    providers.clock.set(new Date());
    let sweeps: Promise<unknown> = Promise.resolve();
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('eyes_expire_overdue'))`;
      sweeps = Promise.all([monitor.scheduled({}, env), ...(concurrent ? [service.expireOverdue()] : [])]);
      await vi.waitFor(
        async () => {
          const [waiting] = await sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
          and query like '%from eyes_expire_overdue(%'`;
          expect(waiting?.n).toBe(concurrent ? 2 : 1);
        },
        { timeout: 10_000 },
      );
    });
    await sweeps;
    await monitor.scheduled({}, env);

    const refunds = await sql`select task_id, amount_cents::int as amount from ledger
      where agent_id = ${agent?.id} and type = 'refund' order by task_id`;
    expect(refunds).toEqual(expiredIds.map((task_id) => ({ task_id, amount: 330 })));
    expect((await sql`select balance_cents::int as balance from agents where id = ${agent?.id}`)[0]).toEqual({
      balance: 1670,
    });
    const remaining = await sql`select id from tasks where agent_id = ${agent?.id} and status = 'dispatched'`;
    expect(remaining.map((t) => t.id)).toEqual(
      tasks.filter((t) => !expiredIds.includes(t.id)).map((t) => t.id),
    );
    expect(
      (await sql`select id from tasks where agent_id = ${agent?.id} and status = 'expired'`)
        .map((t) => t.id)
        .sort(),
    ).toEqual(expiredIds);
  });
});
