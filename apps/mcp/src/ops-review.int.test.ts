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
import { createEventLog } from "@eyes/web-dashboard";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./server.ts";

const url = process.env.DATABASE_URL;
const ORIGIN = "https://api.eyes.test";
// The dashboard's own host: `/x` there is `/ops/x`.
const OPS = "https://internal.eyes.test";
const OPS_KEY = `ops-${randomUUID()}`;
const ALLOW: SafetyVerdict = { allowed: true, category: null, reason: null, fix: null, layer: null };
// The photo check fails, so the answer waits in needs_review for an operator.
const HELD: VerificationResult = {
  gps_ok: true,
  fresh_ok: true,
  vision_ok: false,
  vision_reason: "Photo shows a face.",
  worker_distance_m: 0,
  confidence: 0.5,
  auto_approve: false,
};

describe.skipIf(!url)("ops review panel on Postgres", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const rpc = createRpc({ kind: "postgres", url: url ?? "" });
  const providers = { ...fakeProviders(), clock: fakeClock(new Date()) };
  const outbox = providers.messaging.outbox as {
    to: string;
    kind: string;
    payload: Record<string, unknown>;
  }[];
  const config = AppConfig.parse({
    public_api_url: ORIGIN,
    worker_web_url: "https://w.eyes.test",
    link_secret: "test-link-secret-0123456789",
  });
  const service = createEyesService({
    db: { kind: "postgres", url: url ?? "" },
    providers,
    assessTask: async () => ALLOW,
    verifySubmission: async () => HELD,
    config,
  });
  const events = createEventLog();
  const server = createServer({ service, providers, config, env: { EYES_OPS_KEY: OPS_KEY }, rpc, events });
  const call = (path: string, init: RequestInit = {}) =>
    server.fetch(new Request(`${OPS}${path.replace(/^\/ops(?=\/|$)/, "")}`, init));

  beforeAll(() => migrate(url ?? ""));
  afterAll(() => sql.end());

  async function heldTask() {
    const at = { lat: 10 + Math.random() * 40, lng: -120 + Math.random() * 60 };
    const phone = `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;
    await service.joinWorker({ name: "Review Worker", phone, lat: at.lat, lng: at.lng });
    await service.handleWorkerReply({ phone, intent: "start", text: "START" });
    const { api_key } = await service.signupAgent({ name: "Review Agent" });
    const agent = (await service.authenticate(api_key)) as Agent;
    const { task_id } = await service.askEyes(agent, {
      question: "Is the cafe open right now?",
      location: at,
      task_type: "is_open",
      bounty_usd: 3,
      deadline_minutes: 30,
      require_photo: true,
      idempotency_key: randomUUID(),
    });
    await service.handleWorkerReply({ phone, intent: "yes", text: "YES" });
    const link = outbox.findLast((m) => m.kind === "capture_link" && m.payload.task_id === task_id);
    const token = new URL(String(link?.payload.capture_url)).searchParams.get("t") ?? "";
    await service.submitCapture(
      token,
      {
        lat: at.lat,
        lng: at.lng,
        accuracy_m: 8,
        captured_at: providers.clock.now().toISOString(),
        answer_text: "Open, lights on",
        answer_bool: true,
      },
      { bytes: new Uint8Array([255, 216, 255]), content_type: "image/jpeg" },
    );
    return { task_id, agent };
  }

  it("shows a held task, releases it once, and logs who did it", async () => {
    const { task_id, agent } = await heldTask();
    const resolve = (outcome: string, headers: Record<string, string>) =>
      call(`/ops/tasks/${task_id}/resolve`, {
        method: "POST",
        headers: { origin: OPS, "content-type": "application/json", ...headers },
        body: JSON.stringify({ outcome }),
      });

    expect((await call(`/ops/tasks/${task_id}`)).status).toBe(401);
    expect((await resolve("release", {})).status).toBe(401);
    const login = await call(`/ops/${OPS_KEY}`);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await resolve("release", { cookie, origin: "https://evil.test" })).status).toBe(403);

    const detail = await call(`/ops/tasks/${task_id}`, { headers: { cookie } });
    expect(await detail.json()).toMatchObject({
      id: task_id,
      status: "needs_review",
      answer_text: "Open, lights on",
      gps_ok: true,
      vision_ok: false,
      vision_reason: "Photo shows a face.",
      distance_m: 0,
    });

    const before = (await service.getBalance(agent)).balance_usd;
    const first = await resolve("release", { cookie });
    expect(await first.json()).toMatchObject({ task_id, already_resolved: false });
    const second = await resolve("refund", { cookie });
    expect(await second.json()).toMatchObject({ task_id, already_resolved: true });
    expect((await service.getBalance(agent)).balance_usd).toBe(before);

    const ledger = await sql<
      { type: string }[]
    >`select type from ledger where task_id = ${task_id} order by id`;
    expect(ledger.map((r) => r.type)).not.toContain("refund");
    expect(ledger.map((r) => r.type)).toContain("release");
    expect(events.recent()).toContainEqual(
      expect.objectContaining({ kind: "ops", task_id, summary: "task release by break-glass" }),
    );
  });
});
