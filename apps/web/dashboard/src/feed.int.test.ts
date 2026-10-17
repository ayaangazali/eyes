import { randomInt, randomUUID } from "node:crypto";
import {
  type Agent,
  AppConfig,
  fakeClock,
  fakeProviders,
  type SafetyVerdict,
  type VerificationResult,
} from "@eyes/core";
import { createRpc, migrate } from "@eyes/db";
import { createEyesService } from "@eyes/engine";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.DATABASE_URL;

type FeedTask = {
  id: string;
  status: string;
  workers_notified: number;
  claimed_at: string | null;
  submitted_at: string | null;
  photo_url: string | null;
  gps_ok: boolean | null;
  fresh_ok: boolean | null;
  vision_ok: boolean | null;
  confidence: number | null;
  money_at: Record<string, string> | null;
};
type Totals = { escrowed_cents: number; released_today_cents: number; paid_out_today_cents: number };
type Feed = {
  tasks: FeedTask[];
  ledger: { type: string; amount_cents: number; task_id: string | null; created_at: string }[];
  workers: Record<string, unknown>[];
  totals: Totals;
};

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

describe.skipIf(!url)("eyes_dashboard_feed on Postgres", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const rpc = createRpc({ kind: "postgres", url: url ?? "" });
  const providers = { ...fakeProviders(), clock: fakeClock(new Date()) };
  const outbox = providers.messaging.outbox as {
    to: string;
    kind: string;
    payload: Record<string, unknown>;
  }[];
  const service = createEyesService({
    db: { kind: "postgres", url: url ?? "" },
    providers,
    assessTask: async () => ALLOW,
    verifySubmission: async () => PASS,
    config: AppConfig.parse({
      public_api_url: "https://api.eyes.test",
      worker_web_url: "https://w.eyes.test",
      link_secret: "test-link-secret-0123456789",
    }),
  });

  beforeAll(() => migrate(url ?? ""));
  afterAll(() => sql.end());

  const feed = async () => (await rpc<Feed>("eyes_dashboard_feed", { p_limit: 1000 }))[0] as Feed;
  const taskIn = async (id: string) => (await feed()).tasks.find((t) => t.id === id);
  const delta = (a: Totals, b: Totals) => ({
    escrowed_cents: b.escrowed_cents - a.escrowed_cents,
    released_today_cents: b.released_today_cents - a.released_today_cents,
    paid_out_today_cents: b.paid_out_today_cents - a.paid_out_today_cents,
  });

  it("follows a task from offers to claim, photo and payout without exposing worker phones or names", async () => {
    const at = { lat: 10 + Math.random() * 40, lng: -120 + Math.random() * 60 };
    const phones: string[] = [];
    for (const meters of [100, 200, 300]) {
      const phone = `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;
      phones.push(phone);
      await service.joinWorker({
        name: "Private Workername",
        phone,
        lat: at.lat + meters / 111_320,
        lng: at.lng,
      });
      await service.handleWorkerReply({ phone, intent: "start", text: "START" });
    }
    const { api_key } = await service.signupAgent({ name: "Private Agentname" });
    const agent = (await service.authenticate(api_key)) as Agent;
    const before = (await feed()).totals;

    const asked = await service.askEyes(agent, {
      question: "Is the line long right now?",
      location: at,
      task_type: "line_length",
      bounty_usd: 3,
      deadline_minutes: 30,
      require_photo: true,
      idempotency_key: randomUUID(),
    });
    const dispatched = await feed();
    expect(dispatched.tasks.find((t) => t.id === asked.task_id)).toMatchObject({
      status: "dispatched",
      workers_notified: 3,
      claimed_at: null,
      photo_url: null,
    });
    expect(delta(before, dispatched.totals)).toEqual({
      escrowed_cents: 350,
      released_today_cents: 0,
      paid_out_today_cents: 0,
    });

    await service.handleWorkerReply({ phone: phones[0] ?? "", intent: "yes", text: "YES" });
    expect(await taskIn(asked.task_id)).toMatchObject({ status: "claimed", claimed_at: expect.any(String) });

    const link = outbox.findLast((m) => m.kind === "capture_link" && m.payload.task_id === asked.task_id);
    const token = new URL(String(link?.payload.capture_url)).searchParams.get("t") ?? "";
    await service.workerConnectUrl(
      String(outbox.findLast((m) => m.to === phones[0] && m.kind === "text")?.payload).split(
        "/w/connect/",
      )[1] ?? "",
    );
    await service.submitCapture(
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

    const paid = await feed();
    const task = paid.tasks.find((t) => t.id === asked.task_id);
    expect(task).toMatchObject({
      status: "paid",
      submitted_at: expect.any(String),
      photo_url: expect.stringContaining(`/photos/${asked.task_id}/`),
      gps_ok: true,
      fresh_ok: true,
      vision_ok: true,
      confidence: 0.9,
    });
    expect(Object.keys(task?.money_at ?? {}).sort()).toEqual(["escrow", "fee", "payout", "release"]);
    expect(
      paid.ledger
        .filter((l) => l.task_id === asked.task_id)
        .map((l) => [l.type, l.amount_cents])
        .sort(),
    ).toEqual([
      ["escrow", 350],
      ["fee", 50],
      ["payout", 300],
      ["release", 300],
    ]);
    expect(delta(before, paid.totals)).toEqual({
      escrowed_cents: 0,
      released_today_cents: 300,
      paid_out_today_cents: 300,
    });

    for (const w of paid.workers)
      expect(Object.keys(w).sort()).toEqual(["available", "id", "lat", "lng", "opted_in"]);
    const json = JSON.stringify(paid);
    for (const secret of [
      ...phones,
      ...phones.map((p) => p.slice(2)),
      "Private Workername",
      "Private Agentname",
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it("is not executable by PUBLIC", async () => {
    const [row] =
      await sql`select has_function_privilege('public', 'eyes_dashboard_feed(integer)', 'execute') as ok`;
    expect(row?.ok).toBe(false);
  });
});
