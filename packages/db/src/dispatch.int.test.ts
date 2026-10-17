import { randomInt, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";
import { createRpc } from "./rpc.ts";

const url = process.env.DATABASE_URL;

type Task = { id: string; status: string; claimed_by: string | null };

describe.skipIf(!url)("dispatch and YES claims for workers who already hold a task", () => {
  const rpc = createRpc({ kind: "postgres", url: url ?? "" });
  const t0 = Date.now();
  const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString();

  beforeAll(() => migrate(url ?? ""));

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

  it("a YES from a worker who holds a claim returns their own task even if an offer reached them in the dispatch race", async () => {
    const place = somewhere();
    const busy = await worker(place, 50);
    const a = await agent();
    const first = await post(a, place, await nearby(place), 0);
    const readBeforeTheClaim = await nearby(place);
    await yes(busy, 1);
    const second = await post(a, place, readBeforeTheClaim, 2);

    expect(await yes(busy, 3)).toEqual([{ outcome: "already_yours", task_id: first }]);
    expect(await task(second)).toEqual({ status: "dispatched", claimed_by: null });
  });
});
