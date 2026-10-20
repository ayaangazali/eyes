import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";
import { createRpc } from "./rpc.ts";

const url = process.env.DATABASE_URL;

type Task = { id: string; status: string; claimed_by: string | null };

describe.skipIf(!url)("dispatch and YES claims for workers who already hold a task", () => {
  const rpc = createRpc({ kind: "postgres", url: url ?? "" });
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const t0 = Date.now();
  const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString();

  beforeAll(() => migrate(url ?? ""));
  afterAll(() => sql.end());

  const somewhere = () => ({ lat: 10 + Math.random() * 40, lng: -120 + Math.random() * 60 });
  type Place = ReturnType<typeof somewhere>;

  async function worker(place: Place, metersNorth: number) {
    const phone = `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;
    const [w] = await rpc<{ id: string }>("eyes_join_worker", {
      p_name: "Worker",
      p_phone: phone,
      p_lat: place.lat + metersNorth / 111_320,
      p_lng: place.lng,
      p_now: at(0),
    });
    await rpc("eyes_set_worker_opt_in", { p_phone: phone, p_opted_in: true });
    return w?.id as string;
  }

  async function agent() {
    const [a] = await rpc<{ id: string }>("eyes_signup", {
      p_name: "dispatch-test",
      p_api_key_hash: randomUUID(),
      p_grant_cents: 2000,
      p_now: at(0),
    });
    return a?.id as string;
  }

  const nearby = async (place: Place) =>
    (
      await rpc<{ worker_id: string }>("eyes_nearby_workers", {
        p_lat: place.lat,
        p_lng: place.lng,
        p_radius_m: 1000,
        p_limit: 10,
      })
    ).map((w) => w.worker_id);

  async function post(agentId: string, place: Place, workerIds: string[], seconds: number) {
    const [posted] = await rpc<{ task: Task }>("eyes_post_task", {
      p_agent_id: agentId,
      p_question: "Is the line long?",
      p_task_type: "line_length",
      p_place_label: "Ferry Building",
      p_lat: place.lat,
      p_lng: place.lng,
      p_radius_m: 150,
      p_bounty_cents: 300,
      p_fee_cents: 50,
      p_require_photo: true,
      p_deadline_minutes: 30,
      p_idempotency_key: null,
      p_worker_ids: workerIds,
      p_now: at(seconds),
    });
    return posted?.task.id as string;
  }

  const yes = async (workerId: string, seconds: number) =>
    (
      await rpc<{ outcome: string; task: Task }>("eyes_claim", { p_worker_id: workerId, p_now: at(seconds) })
    ).map((r) => ({ outcome: r.outcome, task_id: r.task.id }));

  const settle = (taskId: string, workerId: string, place: Place, seconds: number) =>
    rpc("eyes_submit", {
      p_task_id: taskId,
      p_worker_id: workerId,
      p_photo_url: "https://photos.test/p.jpg",
      p_answer_text: "Short line",
      p_answer_bool: null,
      p_lat: place.lat,
      p_lng: place.lng,
      p_captured_at: at(seconds),
      p_gps_ok: true,
      p_fresh_ok: true,
      p_vision_ok: true,
      p_vision_reason: "ok",
      p_confidence: 0.9,
      p_auto_approve: true,
      p_now: at(seconds),
    });

  const task = async (taskId: string) => {
    const [row] = await rpc<{ task: Task }>("eyes_task_detail", { p_task_id: taskId });
    return { status: row?.task.status, claimed_by: row?.task.claimed_by };
  };

  it("does not offer a new nearby task to a worker who holds a claim, and offers again once it settles", async () => {
    const place = somewhere();
    const busy = await worker(place, 50);
    const idle = await worker(place, 100);
    const a = await agent();
    const first = await post(a, place, await nearby(place), 0);
    expect(await yes(busy, 1)).toEqual([{ outcome: "won", task_id: first }]);

    expect(await nearby(place)).toEqual([idle]);

    await settle(first, busy, place, 2);
    expect(await nearby(place)).toEqual([busy, idle]);
  });

  it("a YES after the worker's first task settled claims nothing, and leaves both tasks as they were", async () => {
    const place = somewhere();
    const busy = await worker(place, 50);
    await worker(place, 100);
    const a = await agent();
    const first = await post(a, place, await nearby(place), 0);
    await yes(busy, 1);
    const second = await post(a, place, await nearby(place), 2);
    await settle(first, busy, place, 3);

    expect(await yes(busy, 4)).toEqual([]);
    expect(await task(first)).toEqual({ status: "verified", claimed_by: busy });
    expect(await task(second)).toEqual({ status: "dispatched", claimed_by: null });
  });

  it("rejects a stale worker list after a claim without charging the next task", async () => {
    const place = somewhere();
    const busy = await worker(place, 50);
    const a = await agent();
    const candidates = await nearby(place);
    const first = await post(a, place, candidates, 0);
    await yes(busy, 1);
    await expect(post(a, place, candidates, 2)).rejects.toMatchObject({ code: "no_workers_nearby" });
    expect(await yes(busy, 3)).toEqual([{ outcome: "already_yours", task_id: first }]);
    expect((await sql`select balance_cents::int as balance from agents where id = ${a}`)[0]?.balance).toBe(
      1650,
    );
  });

  it("rejects a second open offer and accepts one after the first task expires", async () => {
    const place = somewhere();
    const w = await worker(place, 50);
    const a = await agent();
    const first = await post(a, place, [w], 0);
    await expect(post(a, place, [w], 1)).rejects.toMatchObject({ code: "no_workers_nearby" });
    const next = await post(a, place, [w], 30 * 60);
    expect(await yes(w, 30 * 60 + 1)).toEqual([{ outcome: "won", task_id: next }]);
    expect(await task(first)).toEqual({ status: "dispatched", claimed_by: null });
  });

  it("two YES replies with overlapping offers retain one claim when the first commits mid-claim", async () => {
    const place = somewhere();
    const w = await worker(place, 50);
    const other = await worker(place, 100);
    const a = await agent();
    const older = await post(a, place, [w], 0);
    const newer = await post(a, place, [other], 1);
    await sql`insert into offers (task_id, worker_id, sent_at) values (${newer}, ${w}, ${at(1)})`;
    const key = randomInt(1_000_000_000);
    const [fn] = await sql<{ def: string }[]>`
      select pg_get_functiondef('eyes_claim(uuid, timestamptz)'::regprocedure) as def`;
    const paused = String(fn?.def)
      .replace("eyes_claim(", "eyes_claim_paused(")
      .replace("select t.* into v_task", `perform pg_advisory_xact_lock(${key});\n  select t.* into v_task`);
    await sql.unsafe(paused);
    const gate = await sql.reserve();
    const otherConnection = await sql.reserve();
    const claims = (rows: postgres.RowList<postgres.Row[]>) =>
      Array.from(rows, (r) => ({ outcome: r.outcome, task_id: r.task_id }));
    try {
      await gate`select pg_advisory_lock(${key}::bigint)`;
      let second: Promise<postgres.RowList<postgres.Row[]>> = Promise.resolve([] as never);
      const first = await sql.begin(async (tx) => {
        const won = await tx`select outcome, (task).id as task_id from eyes_claim(${w}, ${at(2)})`;
        second =
          otherConnection`select outcome, (task).id as task_id from eyes_claim_paused(${w}, ${at(2)})`.execute();
        let blocked = 0;
        for (let i = 0; i < 500 && !blocked; i++) {
          await sleep(10);
          const [row] = await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and query like '%eyes_claim_paused(%'`;
          blocked = row?.n ?? 0;
        }
        expect(blocked).toBe(1);
        return won;
      });
      await gate`select pg_advisory_unlock(${key}::bigint)`;
      expect(claims(first)).toEqual([{ outcome: "won", task_id: newer }]);
      expect(claims(await second)).toEqual([{ outcome: "already_yours", task_id: newer }]);
      expect(await task(older)).toEqual({ status: "dispatched", claimed_by: null });
    } finally {
      gate.release();
      otherConnection.release();
      await sql`drop function eyes_claim_paused(uuid, timestamptz)`;
    }
  });

  it("a NO gives the claim back only before the deadline, and a NO racing the photo never both releases and keeps it", async () => {
    const place = somewhere();
    const lockWaits = async () =>
      (
        await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and (query like '%eyes_release_claim(%' or query like '%eyes_submit(%')`
      )[0]?.n ?? 0;

    for (let rep = 0; rep < 20; rep++) {
      const w = await worker(place, 50);
      const taskId = await post(await agent(), place, [w], 0);
      await yes(w, 1);
      expect(await rpc("eyes_release_claim", { p_worker_id: w, p_now: at(30 * 60) })).toEqual([]);

      const noFirst = rep % 2 === 1;
      const no = () =>
        rpc<Task>("eyes_release_claim", { p_worker_id: w, p_now: at(2) }).then((r) => r.length);
      const photo = () =>
        settle(taskId, w, place, 2).then(
          () => "sent",
          (e: { code?: string }) => e.code,
        );
      let released: Promise<number> = Promise.resolve(-1);
      let sent: Promise<string | undefined> = Promise.resolve("unset");
      await sql.begin(async (tx) => {
        await tx`select id from tasks where id = ${taskId} for update`;
        if (noFirst) released = no();
        else sent = photo();
        while ((await lockWaits()) < 1) await sleep(5);
        if (noFirst) sent = photo();
        else released = no();
        while ((await lockWaits()) < 2) await sleep(5);
      });

      const outcome = { released: await released, sent: await sent };
      const [submissions] = await sql<{ n: number }[]>`
        select count(*)::int as n from submissions where task_id = ${taskId}`;
      expect({ ...outcome, submissions: submissions?.n, ...(await task(taskId)) }).toEqual(
        noFirst
          ? {
              released: 1,
              sent: "task_already_claimed",
              submissions: 0,
              status: "dispatched",
              claimed_by: null,
            }
          : { released: 0, sent: "sent", submissions: 1, status: "verified", claimed_by: w },
      );
    }
  });
});
