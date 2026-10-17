import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Agent,
  AppConfig,
  type AskEyesInput,
  agentEmailAddress,
  fakeProviders,
  type LatLng,
  type SafetyVerdict,
  type VerificationResult,
} from "@eyes/core";
import { migrate } from "@eyes/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEyesService } from "./index.ts";

const url = process.env.DATABASE_URL;

const ALLOW: SafetyVerdict = { allowed: true, category: null, reason: null, fix: null, layer: null };
const PASS: VerificationResult = {
  gps_ok: true,
  fresh_ok: true,
  vision_ok: true,
  vision_reason: "Photo shows the line.",
  worker_distance_m: 0,
  confidence: 0.9,
  auto_approve: true,
};

describe.skipIf(!url)("engine on Postgres", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const providers = fakeProviders();
  const outbox = providers.messaging.outbox as {
    to: string;
    kind: string;
    payload: Record<string, unknown>;
  }[];
  let safety = ALLOW;
  const service = createEyesService({
    db: { kind: "postgres", url: url ?? "" },
    providers,
    assessTask: async () => safety,
    verifySubmission: async () => PASS,
    config: AppConfig.parse({
      public_api_url: "https://api.eyes.test",
      worker_web_url: "https://w.eyes.test",
      link_secret: "test-link-secret-0123456789",
      email_domain: "brave-otter.primitive.email",
    }),
  });

  beforeAll(() => migrate(url ?? ""));
  afterAll(() => sql.end());

  const somewhere = (): LatLng => ({ lat: 10 + Math.random() * 40, lng: -120 + Math.random() * 60 });
  const north = (p: LatLng, meters: number): LatLng => ({ lat: p.lat + meters / 111_320, lng: p.lng });

  const newPhone = () => `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;

  const connectToken = (phone: string) =>
    String(outbox.findLast((m) => m.to === phone && m.kind === "text")?.payload).split("/w/connect/")[1] ??
    "";

  async function worker(at: LatLng, optIn = true) {
    const phone = newPhone();
    const joined = await service.joinWorker({ name: "Test Worker", phone, ...at });
    if (optIn) await service.handleWorkerReply({ phone, intent: "start", text: "START" });
    return { ...joined, phone };
  }

  async function agent() {
    const { api_key } = await service.signupAgent({ name: "test-agent" });
    return (await service.authenticate(api_key)) as Agent;
  }

  const ask = (a: Agent, at: LatLng, extra: Partial<AskEyesInput> = {}) =>
    service.askEyes(a, {
      question: "Is the line long right now?",
      location: at,
      task_type: "line_length",
      bounty_usd: 3,
      deadline_minutes: 30,
      require_photo: true,
      ...extra,
    });

  const ledger = (taskId: string) =>
    sql`select type, amount_cents::int as amount, stripe_ref from ledger where task_id = ${taskId} order by type`;

  const reply = (phone: string) => service.handleWorkerReply({ phone, intent: "yes", text: "YES" });

  const claimsWaitingOnLock = async () =>
    (
      await sql`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query like '%eyes_claim(%'`
    )[0]?.n as number;

  it("dispatches to the nearest opted-in workers, lets exactly one YES win, and pays out a verified capture", async () => {
    const at = somewhere();
    const a = await agent();
    const near = await worker(north(at, 100));
    const mid = await worker(north(at, 300));
    const far = await worker(north(at, 500));
    await worker(north(at, 1000));
    await worker(north(at, 50), false);
    await worker(north(at, 5000));

    const asked = await ask(a, at);
    expect(asked).toMatchObject({ status: "dispatched", workers_notified: 3, escrowed_usd: 3.5 });
    const offers = outbox.filter((m) => m.kind === "offer" && m.payload.task_id === asked.task_id);
    expect(offers.map((o) => o.to).sort()).toEqual([near.phone, mid.phone, far.phone].sort());
    expect(offers.find((o) => o.to === near.phone)?.payload).toMatchObject({
      distance_m: 100,
      task_type: "line_length",
    });

    let race: Promise<unknown> = Promise.resolve();
    await sql.begin(async (tx) => {
      await tx`select id from tasks where id = ${asked.task_id} for update`;
      race = Promise.all([reply(near.phone), reply(mid.phone)]);
      while ((await claimsWaitingOnLock()) < 2) await sleep(10);
    });
    await race;
    const racers = [near, mid];
    const links = outbox.filter((m) => m.kind === "capture_link" && racers.some((w) => w.phone === m.to));
    const losers = outbox.filter((m) => m.kind === "already_claimed" && racers.some((w) => w.phone === m.to));
    expect(links).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const link = links[0];
    const winner = racers.find((w) => w.phone === link?.to);
    if (!link || !winner) throw new Error("no winner");

    await reply(winner.phone);
    expect(outbox.at(-1)).toEqual(link);

    const captureUrl = String(link.payload.capture_url);
    const token = new URL(captureUrl).searchParams.get("t") ?? "";
    expect(await service.getOffer(token)).toMatchObject({ task_id: asked.task_id, claimed_by_you: true });
    await service.workerConnectUrl(connectToken(winner.phone));

    const result = await service.submitCapture(
      token,
      {
        lat: at.lat,
        lng: at.lng,
        accuracy_m: 8,
        captured_at: providers.clock.now().toISOString(),
        answer_text: "Short line, about 4 people",
        answer_bool: null,
      },
      { bytes: new Uint8Array([255, 216, 255]), content_type: "image/jpeg" },
    );
    expect(result).toMatchObject({ status: "paid", verification: { gps_ok: true, vision_ok: true } });

    const awaited = await service.awaitAnswer(a, { task_id: asked.task_id, timeout_seconds: 5 });
    expect(awaited).toMatchObject({
      status: "paid",
      answered: true,
      answer: { answer_text: "Short line, about 4 people", worker_distance_m: 0, cost_usd: 3.5 },
    });
    expect(awaited.answer?.photo_url).toContain(`/photos/${asked.task_id}/`);

    expect(await ledger(asked.task_id)).toEqual([
      { type: "escrow", amount: 350, stripe_ref: null },
      { type: "fee", amount: 50, stripe_ref: null },
      { type: "payout", amount: 300, stripe_ref: expect.stringMatching(/^tr_fake_/) },
      { type: "release", amount: 300, stripe_ref: null },
    ]);
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 16.5, escrowed_usd: 0 });
    expect(outbox).toContainEqual(expect.objectContaining({ to: winner.phone, kind: "paid" }));
    await expect(service.getTask(await agent(), { task_id: asked.task_id })).rejects.toMatchObject({
      code: "task_not_found",
    });
  });

  it("never lets a repeat join rewrite an existing worker, even after STOP, and sends the payout link only by text after START", async () => {
    const at = somewhere();
    const phone = newPhone();
    const first = await service.joinWorker({ name: "Real Worker", phone, ...at });
    expect(first.connect_url).toBeNull();
    await service.handleWorkerReply({ phone, intent: "start", text: "START" });
    expect(connectToken(phone)).not.toBe("");

    const again = await service.joinWorker({ name: "Someone Else", phone, ...north(at, 2000) });
    expect(again).toEqual(first);
    await service.handleWorkerReply({ phone, intent: "stop", text: "STOP" });
    expect(await service.joinWorker({ name: "Someone Else", phone, lat: 0, lng: 0 })).toEqual(first);
    expect(await sql`select name, lat from workers where phone = ${phone}`).toEqual([
      { name: "Real Worker", lat: at.lat },
    ]);
  });

  it("gives each new agent its capability email address and mentions it in next_step", async () => {
    const signup = await service.signupAgent({ name: "email-agent" });
    expect(signup.email_address).toBe(
      agentEmailAddress("test-link-secret-0123456789", signup.agent_id, "brave-otter.primitive.email"),
    );
    expect(signup.next_step).toContain(String(signup.email_address));
  });

  it("finds an agent by id and returns null for unknown or malformed ids", async () => {
    const a = await agent();
    expect(await service.agentById(a.id)).toEqual(a);
    expect(await service.agentById(randomUUID())).toBeNull();
    expect(await service.agentById("not-a-uuid")).toBeNull();
  });

  it("charges nothing on insufficient balance and tells the agent what it can afford", async () => {
    const at = somewhere();
    await worker(north(at, 100));
    const a = await agent();
    await sql`update agents set balance_cents = 100 where id = ${a.id}`;

    await expect(ask(a, at)).rejects.toMatchObject({
      code: "insufficient_balance",
      context: { balance_usd: 1, needed_usd: 3.5, max_affordable_bounty_usd: 0.5 },
    });
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 1, escrowed_usd: 0 });
    expect(await sql`select id from tasks where agent_id = ${a.id}`).toHaveLength(0);
  });

  it("returns the same task for an idempotent retry and rejects the key with different params", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const a = await agent();
    const key = randomUUID();

    const first = await ask(a, at, { idempotency_key: key });
    const retry = await ask(a, at, { idempotency_key: key });
    expect(retry.task_id).toBe(first.task_id);
    expect((await ledger(first.task_id)).filter((r) => r.type === "escrow")).toHaveLength(1);
    expect(outbox.filter((m) => m.to === w.phone && m.kind === "offer")).toHaveLength(1);
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 16.5, escrowed_usd: 3.5 });

    await expect(
      ask(a, at, { idempotency_key: key, question: "Is it open right now?" }),
    ).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });

  it("refunds a cancelled task exactly once", async () => {
    const at = somewhere();
    await worker(north(at, 100));
    const a = await agent();
    const { task_id } = await ask(a, at);

    expect(await service.cancelTask(a, { task_id })).toEqual({
      task_id,
      status: "refunded",
      refunded_usd: 3.5,
    });
    await expect(service.cancelTask(a, { task_id })).rejects.toMatchObject({ code: "task_not_cancellable" });
    expect((await ledger(task_id)).filter((r) => r.type === "refund")).toHaveLength(1);
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 20, escrowed_usd: 0 });
  });

  it("charges nothing when no workers are nearby or the task is unsafe", async () => {
    const at = somewhere();
    const a = await agent();
    await expect(ask(a, at)).rejects.toMatchObject({ code: "no_workers_nearby" });

    await worker(north(at, 100));
    safety = {
      allowed: false,
      category: "private_residence",
      reason: "Targets a private home.",
      fix: "Ask about a public place instead.",
      layer: "rules",
    };
    try {
      await expect(ask(a, at)).rejects.toMatchObject({
        code: "unsafe_task",
        fix: "Ask about a public place instead.",
        context: { category: "private_residence" },
      });
    } finally {
      safety = ALLOW;
    }
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 20, escrowed_usd: 0 });
    expect(await sql`select id from tasks where agent_id = ${a.id}`).toHaveLength(0);
  });

  it("enforces the daily cap with the remaining amount, and refunds free the cap again", async () => {
    const at = somewhere();
    await worker(north(at, 100));
    const a = await agent();
    await sql`update agents set daily_cap_cents = 500 where id = ${a.id}`;

    const { task_id } = await ask(a, at);
    await expect(ask(a, at)).rejects.toMatchObject({
      code: "daily_cap_exceeded",
      context: { remaining_today_usd: 1.5 },
    });
    expect(await service.getSpendPolicy(a)).toMatchObject({ spent_today_usd: 3.5, remaining_today_usd: 1.5 });

    await service.cancelTask(a, { task_id });
    await expect(ask(a, at)).resolves.toMatchObject({ status: "dispatched" });
  });
});
