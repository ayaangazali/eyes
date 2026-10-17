import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Agent,
  AppConfig,
  type AskEyesInput,
  agentEmailAddress,
  CaptureResult,
  type EngineDeps,
  type EyesError,
  fakeProviders,
  JoinWorkerOutput,
  type LatLng,
  OfferView,
  OwnerConsole,
  type OwnerPolicyInput,
  type SafetyVerdict,
  SignupOutput,
  signToken,
  type TaskStatus,
  TOOLS,
  type VerificationResult,
  WorkerEarnings,
} from "@eyes/core";
import { migrate } from "@eyes/db";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  const deps: EngineDeps = {
    db: { kind: "postgres", url: url ?? "" },
    providers,
    assessTask: async () => safety,
    verifySubmission: async ({ task, submission: s, vision }) => {
      if (!s.photo_url) return PASS;
      const v = await vision.judge({ ...task, ...s, photo_url: s.photo_url });
      const vision_ok = v.answers_question && !v.prominent_faces;
      return vision_ok ? PASS : { ...PASS, vision_ok, vision_reason: v.reason, auto_approve: false };
    },
    config: AppConfig.parse({
      public_api_url: "https://api.eyes.test",
      worker_web_url: "https://w.eyes.test",
      link_secret: "test-link-secret-0123456789",
      email_domain: "brave-otter.primitive.email",
    }),
  };
  const service = createEyesService(deps);

  beforeAll(() => migrate(url ?? ""));
  afterAll(() => sql.end());
  afterEach(() => providers.vision.setVerdict({ answers_question: true, prominent_faces: false }));

  const somewhere = (): LatLng => ({ lat: 10 + Math.random() * 40, lng: -120 + Math.random() * 60 });
  const north = (p: LatLng, meters: number): LatLng => ({ lat: p.lat + meters / 111_320, lng: p.lng });

  const newPhone = () => `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;

  const connectToken = (phone: string) =>
    String(outbox.findLast((m) => m.to === phone && m.kind === "text")?.payload).split("/w/connect/")[1] ??
    "";

  const earningsToken = (url: unknown) => String(url).split("/w/earnings/")[1] ?? "";
  async function helpEarnings(phone: string) {
    await service.handleWorkerReply({ phone, intent: "help", text: "HELP" });
    return earningsToken(outbox.findLast((m) => m.to === phone)?.payload);
  }

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
      idempotency_key: randomUUID(),
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

  it("STOP gets one confirmation, then nothing until START, which confirms the worker is back in", async () => {
    const { phone } = await worker(somewhere());
    const sent = () => outbox.filter((m) => m.to === phone).map((m) => m.payload);
    const before = sent().length;
    await service.handleWorkerReply({ phone, intent: "stop", text: "STOP" });
    for (const intent of ["stop", "help", "yes", "no", "unknown"] as const) {
      await service.handleWorkerReply({ phone, intent, text: intent });
    }
    const after = sent().slice(before);
    expect(after).toEqual(["Eyes: you're opted out and won't get task texts. Text START to rejoin."]);
    expect(String(after[0]).length).toBeLessThanOrEqual(159);
    await service.handleWorkerReply({ phone, intent: "start", text: "START" });
    expect(sent().slice(before + 1)).toEqual([expect.stringMatching(/^You are in\. .*\/w\/connect\//)]);
  });

  it("HELP says what Eyes is, how to opt out, where to read more and links the worker's earnings", async () => {
    const { phone } = await worker(somewhere());
    await service.handleWorkerReply({ phone, intent: "help", text: "HELP" });
    const help = String(outbox.findLast((m) => m.to === phone)?.payload);
    const [text, url] = help.split(" Your earnings: ");
    expect(text).toBe(
      "Eyes texts you paid tasks to check public places nearby. Reply YES to claim a task, STOP to opt out. More: https://w.eyes.test",
    );
    expect(url).toMatch(/^https:\/\/api\.eyes\.test\/w\/earnings\/[\w-]+\.[\w-]+$/);
    expect(await service.workerEarnings(earningsToken(url))).toEqual({
      paid_usd: 0,
      pending_usd: 0,
      tasks: [],
    });
    expect(help.length).toBeLessThanOrEqual(1600);
  });

  it("returns outputs that parse against the frozen contract schemas on every service call", async () => {
    const at = somewhere();
    const signup = SignupOutput.parse(await service.signupAgent({ name: "contract-agent" }));
    const a = (await service.authenticate(signup.api_key)) as Agent;
    const phone = `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;
    JoinWorkerOutput.parse(await service.joinWorker({ name: "Worker", phone, ...north(at, 80) }));
    await service.handleWorkerReply({ phone, intent: "start", text: "START" });
    TOOLS.quote_task.output.parse(await service.quoteTask(a, { location: at, task_type: "line_length" }));
    const asked = TOOLS.ask_eyes.output.parse(await ask(a, at));
    TOOLS.get_task.output.parse(await service.getTask(a, { task_id: asked.task_id }));
    TOOLS.await_answer.output.parse(
      await service.awaitAnswer(a, { task_id: asked.task_id, timeout_seconds: 1 }),
    );
    await reply(phone);
    const link = outbox.findLast((m) => m.to === phone && m.kind === "capture_link");
    const token = new URL(String(link?.payload.capture_url)).searchParams.get("t") ?? "";
    OfferView.parse(await service.getOffer(token));
    await service.workerConnectUrl(connectToken(phone));
    const captured = CaptureResult.parse(
      await service.submitCapture(
        token,
        {
          lat: at.lat,
          lng: at.lng,
          accuracy_m: 5,
          captured_at: providers.clock.now().toISOString(),
          answer_text: "short",
          answer_bool: null,
        },
        { bytes: new Uint8Array([1]), content_type: "image/jpeg" },
      ),
    );
    expect(captured.status).toBe("paid");
    TOOLS.get_task.output.parse(await service.getTask(a, { task_id: asked.task_id }));
    TOOLS.await_answer.output.parse(
      await service.awaitAnswer(a, { task_id: asked.task_id, timeout_seconds: 1 }),
    );
    TOOLS.get_balance.output.parse(await service.getBalance(a));
    TOOLS.get_spend_policy.output.parse(await service.getSpendPolicy(a));
    TOOLS.dispute_answer.output.parse(
      await service.disputeAnswer(a, { task_id: asked.task_id, reason: "wrong store" }),
    );
    const second = await ask(a, at);
    TOOLS.cancel_task.output.parse(await service.cancelTask(a, { task_id: second.task_id }));
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

  it("lists only the calling agent's tasks, newest first, filtered by status and bounded by limit", async () => {
    const at = somewhere();
    await worker(north(at, 100));
    const [a, b] = [await agent(), await agent()];
    const mine: string[] = [];
    for (const question of ["Is it open right now?", "Is the line long?", "Is it busy right now?"]) {
      mine.unshift((await ask(a, at, { question })).task_id);
      providers.clock.advance(1000);
    }
    const theirs = await ask(b, at);
    await service.cancelTask(a, { task_id: mine[1] as string });
    const ids = async (who: Agent, input: { status?: TaskStatus; limit: number }) =>
      (await service.listTasks(who, input)).tasks.map((t) => t.task_id);

    const listed = TOOLS.list_tasks.output.parse(await service.listTasks(a, { limit: 20 }));
    expect(listed.tasks.map((t) => t.task_id)).toEqual(mine);
    expect(listed.tasks[0]).toMatchObject({
      question: "Is it busy right now?",
      status: "dispatched",
      bounty_usd: 3,
      answered: false,
    });
    expect(await ids(b, { limit: 20 })).toEqual([theirs.task_id]);
    expect(await ids(a, { status: "refunded", limit: 20 })).toEqual([mine[1]]);
    expect(await ids(a, { limit: 2 })).toEqual(mine.slice(0, 2));
    await expect(service.listTasks(a, { limit: 51 })).rejects.toMatchObject({ code: "invalid_input" });
  });

  describe("quote_task against the key's limits and balance", () => {
    const at = somewhere();
    beforeAll(() => worker(north(at, 100)));
    const fits = (suggested_bounty_usd: number) => ({
      allowed: true,
      reason_if_not: null,
      suggested_bounty_usd,
    });
    const blocked = (says: string) => ({ allowed: false, reason_if_not: expect.stringContaining(says) });
    const cases: [string, Partial<OwnerPolicyInput>, number | null, object][] = [
      ["suggests the default bounty when it fits", {}, null, fits(3)],
      ["caps the suggestion at max_bounty_usd", { max_bounty_usd: 2 }, null, fits(2)],
      ["caps the suggestion at the daily cap left minus the fee", { daily_cap_usd: 3 }, null, fits(2.5)],
      ["caps the suggestion at the balance minus the fee", {}, 250, fits(2)],
      [
        "blocks a task_type the key may not post",
        { allowed_task_types: ["is_open"] },
        null,
        blocked("is_open"),
      ],
      ["blocks a max_bounty_usd below the minimum bounty", { max_bounty_usd: 0.5 }, null, blocked("is 0.5")],
      [
        "blocks when the minimum does not fit the cap left",
        { daily_cap_usd: 1 },
        null,
        blocked("2026-10-18T00:00:00.000Z"),
      ],
      ["blocks when the minimum does not fit the balance", {}, 120, blocked("https://api.eyes.test/topup/")],
    ];

    it.each(cases)("%s", async (_, policy, balance_cents, expected) => {
      const a = await agent();
      await service.updateSpendPolicy(signToken("test-link-secret-0123456789", `p:${a.id}`), {
        max_bounty_usd: 10,
        daily_cap_usd: 20,
        allowed_task_types: ["line_length"],
        ...policy,
      });
      if (balance_cents !== null)
        await sql`update agents set balance_cents = ${balance_cents} where id = ${a.id}`;
      expect(await service.quoteTask(a, { location: at, task_type: "line_length" })).toMatchObject(expected);
    });
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

  it("refuses a bounty one cent over max_bounty and a task_type the key may not post, charging nothing", async () => {
    const at = somewhere();
    await worker(north(at, 100));
    const { id } = await agent();
    await sql`update agents set max_bounty_cents = 200, allowed_task_types = array['is_open'] where id = ${id}`;
    const a = (await service.agentById(id)) as Agent;

    await expect(ask(a, at, { task_type: "is_open", bounty_usd: 2.01 })).rejects.toMatchObject({
      code: "bounty_exceeds_max",
      context: { bounty_usd: 2.01, max_bounty_usd: 2 },
      fix: expect.stringContaining("2 or less"),
    });
    await expect(ask(a, at, { bounty_usd: 2 })).rejects.toMatchObject({
      code: "task_type_not_allowed",
      context: { task_type: "line_length", allowed_task_types: ["is_open"] },
    });
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 20, escrowed_usd: 0 });
    expect(await sql`select id from tasks where agent_id = ${id}`).toHaveLength(0);
    await expect(ask(a, at, { task_type: "is_open", bounty_usd: 2 })).resolves.toMatchObject({
      status: "dispatched",
      escrowed_usd: 2.5,
    });
  });

  it("emails the owner a private link that sets the limits ask_eyes enforces, and never shows it to the agent", async () => {
    const at = somewhere();
    await worker(north(at, 100));
    const ownerEmail = `owner-${randomUUID()}@example.com`;
    const signup = await service.signupAgent({ name: "owned-agent", owner_email: ownerEmail });
    const mail = providers.email.outbox.find((m) => m.to === ownerEmail);
    const ownerToken = mail?.text.match(/\/owner\/([\w.-]+)/)?.[1] ?? "";
    expect(ownerToken).not.toBe("");
    expect(signup.next_step).toContain(ownerEmail);
    const fresh = async () => (await service.authenticate(signup.api_key)) as Agent;
    const a = await fresh();
    for (const out of [signup, await service.getBalance(a), await service.getSpendPolicy(a)]) {
      expect(JSON.stringify(out)).not.toContain(ownerToken);
      expect(JSON.stringify(out)).not.toContain("/owner/");
    }

    const asked = await ask(a, at, { question: "Is the <b>line</b> long?" });
    const view = OwnerConsole.parse(await service.ownerConsole(ownerToken));
    expect(view).toMatchObject({
      agent_id: a.id,
      agent_name: "owned-agent",
      balance_usd: 16.5,
      escrowed_usd: 3.5,
      policy: { max_bounty_usd: 10, daily_cap_usd: 20, spent_today_usd: 3.5 },
      tasks: [
        { task_id: asked.task_id, question: "Is the <b>line</b> long?", status: "dispatched", bounty_usd: 3 },
      ],
      top_up_url: signup.top_up_url,
    });
    expect(view.ledger.map((l) => `${l.type}:${l.amount_usd}`).sort()).toEqual(["escrow:3.5", "topup:20"]);

    const types = ["is_open", "line_length"] as const;
    expect(
      await service.updateSpendPolicy(ownerToken, {
        max_bounty_usd: 2,
        daily_cap_usd: 20,
        allowed_task_types: [...types, "is_open"],
      }),
    ).toEqual({
      max_bounty_usd: 2,
      daily_cap_usd: 20,
      spent_today_usd: 3.5,
      remaining_today_usd: 16.5,
      allowed_task_types: types,
    });
    await expect(ask(await fresh(), at)).rejects.toMatchObject({ code: "bounty_exceeds_max" });
    await expect(ask(await fresh(), at, { bounty_usd: 2, task_type: "in_stock" })).rejects.toMatchObject({
      code: "task_type_not_allowed",
    });

    await service.updateSpendPolicy(ownerToken, {
      max_bounty_usd: 10,
      daily_cap_usd: 0,
      allowed_task_types: [...types],
    });
    await expect(ask(await fresh(), at, { bounty_usd: 2 })).rejects.toMatchObject({
      code: "daily_cap_exceeded",
    });

    await service.updateSpendPolicy(ownerToken, {
      max_bounty_usd: 100,
      daily_cap_usd: 1000,
      allowed_task_types: [...types],
    });
    const broke = await ask(await fresh(), at, { bounty_usd: 50 }).catch((err: EyesError) => err);
    expect(broke).toMatchObject({ code: "insufficient_balance" });
    const body = JSON.stringify((broke as EyesError).toBody());
    expect(body).toContain("/topup/");
    expect(body).not.toContain(ownerToken);
    expect(body).not.toContain("/owner/");
  });

  it("claims the owner email was sent only when email delivery is live", async () => {
    expect(deps.config.email_delivery).toBe(false);
    const ownerEmail = `owner-${randomUUID()}@example.com`;
    const simulated = await service.signupAgent({ name: "simulated-mail-agent", owner_email: ownerEmail });
    expect(simulated.next_step).not.toMatch(/emailed/i);
    expect(simulated.next_step).toContain(`nothing was sent to ${ownerEmail}`);
    expect(simulated.next_step).toContain(
      `Eyes operator, who creates it with pnpm owner-link ${simulated.agent_id}`,
    );
    expect(providers.email.outbox.filter((m) => m.to === ownerEmail)).toHaveLength(1);

    const delivering = createEyesService({ ...deps, config: { ...deps.config, email_delivery: true } });
    const live = await delivering.signupAgent({ name: "live-mail-agent", owner_email: ownerEmail });
    expect(live.next_step).toContain(`We emailed your user at ${ownerEmail} a private control link`);
    expect(live.next_step).not.toContain("operator");
  });

  it("still signs the agent up when the owner email fails, without logging the owner link", async () => {
    const send = providers.email.send;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    providers.email.send = async (msg) => {
      throw new Error(`relay refused: ${msg.text}`);
    };
    try {
      const signup = await service.signupAgent({ name: "unlucky-agent", owner_email: "owner@example.com" });
      expect(signup.next_step).toContain("could not email your user at owner@example.com");
      expect(error).toHaveBeenCalled();
      expect(JSON.stringify(error.mock.calls)).not.toContain("/owner/");
    } finally {
      providers.email.send = send;
      error.mockRestore();
    }
  });

  it("emails whoever pays a working owner link, credits a replayed top-up once, and never shows the link to the agent", async () => {
    const a = await agent();
    const payer = `payer-${randomUUID()}@example.com`;
    const topup = {
      agent_id: a.id,
      amount_cents: 1500,
      stripe_ref: `cs_${randomUUID()}`,
      payer_email: payer,
    };
    const before = providers.email.outbox.length;
    await service.creditTopup(topup);
    const [mail, ...rest] = providers.email.outbox.slice(before);
    expect(rest).toEqual([]);
    expect(mail?.to).toBe(payer);
    expect(mail?.subject).toBe("You added $15.00 to your AI agent's Eyes balance");
    const ownerToken = mail?.text.match(/\/owner\/([\w.-]+)/)?.[1] ?? "";
    expect(await service.ownerConsole(ownerToken)).toMatchObject({ agent_id: a.id, balance_usd: 35 });

    await service.creditTopup(topup);
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 35 });
    const replayed = providers.email.outbox.slice(before + 1);
    expect(replayed.map((m) => m.to)).toEqual([payer]);
    expect(replayed[0]?.text).toContain(`/owner/${ownerToken}`);

    await service.creditTopup({ ...topup, stripe_ref: `cs_${randomUUID()}`, payer_email: null });
    expect(providers.email.outbox).toHaveLength(before + 2);
    for (const out of [await service.getBalance(a), await service.getSpendPolicy(a)]) {
      expect(JSON.stringify(out)).not.toContain("/owner/");
    }
  });

  it("still credits a top-up when the payer email fails, without logging the owner link", async () => {
    const a = await agent();
    const send = providers.email.send;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    providers.email.send = async (msg) => {
      throw new Error(`relay refused: ${msg.text}`);
    };
    try {
      await service.creditTopup({
        agent_id: a.id,
        amount_cents: 500,
        stripe_ref: `cs_${randomUUID()}`,
        payer_email: "payer@example.com",
      });
      expect(await service.getBalance(a)).toMatchObject({ balance_usd: 25 });
      expect(error).toHaveBeenCalled();
      expect(JSON.stringify(error.mock.calls)).not.toContain("/owner/");
    } finally {
      providers.email.send = send;
      error.mockRestore();
    }
  });

  it("accepts only p: owner tokens for the owner console, policy updates and key replacement", async () => {
    const { api_key } = await service.signupAgent({ name: "test-agent" });
    const a = (await service.authenticate(api_key)) as Agent;
    const secret = "test-link-secret-0123456789";
    const policy = { max_bounty_usd: 1, daily_cap_usd: 1, allowed_task_types: [] };
    const wrong = [
      ...["t", "o", "c"].map((kind) => signToken(secret, `${kind}:${a.id}`)),
      signToken("another-secret-0123456789", `p:${a.id}`),
      `${signToken(secret, `p:${a.id}`)}.x`,
      "garbage",
    ];
    for (const token of wrong) {
      await expect(service.ownerConsole(token)).rejects.toMatchObject({ code: "owner_link_invalid" });
      await expect(service.updateSpendPolicy(token, policy)).rejects.toMatchObject({
        code: "owner_link_invalid",
      });
      await expect(service.rotateApiKey(token)).rejects.toMatchObject({
        code: "owner_link_invalid",
        status: 404,
      });
    }
    expect(await service.authenticate(api_key)).toMatchObject({ id: a.id });
    expect(await service.getSpendPolicy(a)).toMatchObject({ max_bounty_usd: 10, daily_cap_usd: 20 });
    await expect(service.ownerConsole(signToken(secret, `p:${randomUUID()}`))).rejects.toMatchObject({
      code: "owner_link_invalid",
    });
    await expect(service.rotateApiKey(signToken(secret, `p:${randomUUID()}`))).rejects.toMatchObject({
      code: "owner_link_invalid",
    });
    await expect(service.updateSpendPolicy(signToken(secret, `p:${a.id}`), policy)).resolves.toMatchObject({
      max_bounty_usd: 1,
      allowed_task_types: [],
    });
  });

  it("shows a worker what was paid and what is still owed, per task and in total, linked from the paid text", async () => {
    const at = somewhere();
    const a = await agent();
    const w = await worker(north(at, 50));
    const work = async (bounty_usd: number) => {
      const asked = await ask(a, at, { bounty_usd });
      await reply(w.phone);
      const link = outbox.findLast((m) => m.to === w.phone && m.kind === "capture_link");
      await capture(new URL(String(link?.payload.capture_url)).searchParams.get("t") ?? "", at);
      providers.clock.advance(1000);
      return asked.task_id;
    };
    const row = { place_label: expect.any(String), claimed_at: expect.any(String) };

    const first = await work(3);
    const connect = connectToken(w.phone);
    expect(await service.workerEarnings(await helpEarnings(w.phone))).toEqual({
      paid_usd: 0,
      pending_usd: 3,
      tasks: [
        {
          ...row,
          task_id: first,
          status: "verified",
          bounty_usd: 3,
          payout: "waiting_for_payout_setup",
          paid_at: null,
        },
      ],
    });

    await service.workerConnectUrl(connect);
    await service.markWorkerOnboarded(`acct_fake_${w.worker_id}`);
    const paid = outbox.findLast((m) => m.to === w.phone && m.kind === "paid");
    expect(paid?.payload).toMatchObject({ task_id: first, amount_cents: 300 });

    const payoutWorker = providers.payments.payoutWorker;
    providers.payments.payoutWorker = async () => {
      throw new Error("balance_insufficient");
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = await work(4.25).finally(() => {
      providers.payments.payoutWorker = payoutWorker;
      error.mockRestore();
    });

    const view = WorkerEarnings.parse(
      await service.workerEarnings(earningsToken(paid?.payload.earnings_url)),
    );
    expect(view).toEqual({
      paid_usd: 3,
      pending_usd: 4.25,
      tasks: [
        { ...row, task_id: second, status: "verified", bounty_usd: 4.25, payout: "pending", paid_at: null },
        {
          ...row,
          task_id: first,
          status: "paid",
          bounty_usd: 3,
          payout: "paid",
          paid_at: expect.any(String),
        },
      ],
    });
  });

  it("never shows a worker another worker's tasks or money", async () => {
    const at = somewhere();
    const a = await agent();
    const [w1, w2, idle] = [
      await worker(north(at, 50)),
      await worker(north(at, 60)),
      await worker(north(at, 70)),
    ];
    const work = async (w: { phone: string }, bounty_usd: number) => {
      const asked = await ask(a, at, { bounty_usd });
      await reply(w.phone);
      const link = outbox.findLast((m) => m.to === w.phone && m.kind === "capture_link");
      await capture(new URL(String(link?.payload.capture_url)).searchParams.get("t") ?? "", at);
      return asked.task_id;
    };
    const t1 = await work(w1, 3);
    const t2 = await work(w2, 5);
    const view = async (phone: string) => service.workerEarnings(await helpEarnings(phone));
    expect(await view(w1.phone)).toMatchObject({ pending_usd: 3, tasks: [{ task_id: t1 }] });
    expect((await view(w1.phone)).tasks).toHaveLength(1);
    expect(await view(w2.phone)).toMatchObject({ pending_usd: 5, tasks: [{ task_id: t2 }] });
    expect((await view(w2.phone)).tasks).toHaveLength(1);
    expect(await view(idle.phone)).toEqual({ paid_usd: 0, pending_usd: 0, tasks: [] });
  });

  it("opens the earnings page only with an e: token for an existing worker, signed here and under 7 days old", async () => {
    const w = await worker(somewhere());
    const secret = "test-link-secret-0123456789";
    const wrong = [
      ...["t", "o", "c", "p"].map((kind) => signToken(secret, `${kind}:${w.worker_id}`)),
      signToken("another-secret-0123456789", `e:${w.worker_id}`),
      `${signToken(secret, `e:${w.worker_id}`)}.x`,
      signToken(secret, `e:${randomUUID()}`),
      "garbage",
    ];
    for (const token of wrong) {
      await expect(service.workerEarnings(token)).rejects.toMatchObject({
        code: "offer_invalid",
        message: "This earnings link is invalid or has expired.",
      });
    }
    const token = await helpEarnings(w.phone);
    const issued = providers.clock.now();
    try {
      providers.clock.advance(7 * 24 * 60 * 60 * 1000 - 1000);
      await expect(service.workerEarnings(token)).resolves.toMatchObject({ tasks: [] });
      providers.clock.advance(2000);
      await expect(service.workerEarnings(token)).rejects.toMatchObject({ code: "offer_invalid" });
    } finally {
      providers.clock.set(issued);
    }
  });

  it("replaces a leaked API key from the owner link: the old key stops working at once and the new key appears nowhere else", async () => {
    const logs = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m));
    try {
      const { api_key: oldKey } = await service.signupAgent({
        name: "leaky-agent",
        owner_email: "o@example.com",
      });
      const a = (await service.authenticate(oldKey)) as Agent;
      const ownerToken = signToken(deps.config.link_secret, `p:${a.id}`);

      const { api_key } = await service.rotateApiKey(ownerToken);
      expect(api_key).toMatch(/^eyes_test_[\w-]{43}$/);
      expect(api_key).not.toBe(oldKey);
      expect(await service.authenticate(oldKey)).toBeNull();
      const rotated = (await service.authenticate(api_key)) as Agent;
      expect(rotated.id).toBe(a.id);
      expect(await service.getBalance(rotated)).toMatchObject({ balance_usd: 20 });

      const elsewhere = JSON.stringify([
        providers.email.outbox,
        outbox,
        logs.map((spy) => spy.mock.calls),
        await service.ownerConsole(ownerToken),
        await service.getBalance(rotated),
        await service.getSpendPolicy(rotated),
        await sql`select * from agents where id = ${a.id}`,
      ]);
      expect(elsewhere).not.toContain(api_key);
    } finally {
      for (const spy of logs) spy.mockRestore();
    }
  });

  it("leaves exactly one working key when two key replacements race", async () => {
    const { api_key: oldKey } = await service.signupAgent({ name: "raced-agent" });
    const a = (await service.authenticate(oldKey)) as Agent;
    const ownerToken = signToken(deps.config.link_secret, `p:${a.id}`);
    const keys = await Promise.all([service.rotateApiKey(ownerToken), service.rotateApiKey(ownerToken)]);
    const agents = await Promise.all(
      [oldKey, ...keys.map((k) => k.api_key)].map((k) => service.authenticate(k)),
    );
    expect(agents[0]).toBeNull();
    expect(agents.filter((x) => x !== null).map((x) => x.id)).toEqual([a.id]);
  });

  async function claimed(at: LatLng) {
    const a = await agent();
    const w = await worker(north(at, 50));
    const asked = await ask(a, at);
    await reply(w.phone);
    const link = outbox.findLast((m) => m.to === w.phone && m.kind === "capture_link");
    return {
      a,
      task_id: asked.task_id,
      token: new URL(String(link?.payload.capture_url)).searchParams.get("t") ?? "",
    };
  }

  const capture = (token: string, at: LatLng) =>
    service.submitCapture(
      token,
      {
        lat: at.lat,
        lng: at.lng,
        accuracy_m: 5,
        captured_at: providers.clock.now().toISOString(),
        answer_text: "short",
        answer_bool: null,
      },
      { bytes: new Uint8Array([1]), content_type: "image/jpeg" },
    );

  const stored = (taskId: string) =>
    [...providers.storage.objects.keys()].filter((key) => key.startsWith(`${taskId}/`));

  it("deletes a photo rejected for prominent faces and never gives the agent its URL", async () => {
    const at = somewhere();
    const { a, task_id, token } = await claimed(at);
    providers.vision.setVerdict({ prominent_faces: true });

    expect(await capture(token, at)).toMatchObject({
      status: "needs_review",
      verification: { vision_ok: false },
    });
    expect(providers.vision.calls).toContainEqual(
      expect.objectContaining({ photo_url: expect.stringContaining(`/photos/${task_id}/`) }),
    );
    expect(stored(task_id)).toEqual([]);
    expect(await service.awaitAnswer(a, { task_id, timeout_seconds: 1 })).toMatchObject({
      answered: true,
      answer: { answer_text: "short", photo_url: null },
    });
    expect((await service.getTask(a, { task_id })).answer?.photo_url).toBeNull();
  });

  it("keeps the photo of a capture without prominent faces, approved or sent to review", async () => {
    for (const answers_question of [true, false]) {
      providers.vision.setVerdict({ answers_question });
      const at = somewhere();
      const { a, task_id, token } = await claimed(at);
      await capture(token, at);
      const [key] = stored(task_id);
      expect((await service.getTask(a, { task_id })).answer?.photo_url).toBe(
        `https://storage.fake.test/photos/${key}`,
      );
    }
  });

  it("accepts the capture and hides the URL when deleting a face photo fails, logging only the task id", async () => {
    const at = somewhere();
    const { a, task_id, token } = await claimed(at);
    providers.vision.setVerdict({ prominent_faces: true });
    const remove = vi
      .spyOn(providers.storage, "deletePhoto")
      .mockRejectedValueOnce(new Error("storage down at https://storage.fake.test/photos/secret"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await capture(token, at)).toMatchObject({ status: "needs_review" });
      expect(remove).toHaveBeenCalledOnce();
      expect(error.mock.calls).toEqual([[`photo delete for task ${task_id} failed`]]);
      expect((await service.getTask(a, { task_id })).answer).toMatchObject({
        answer_text: "short",
        photo_url: null,
      });
    } finally {
      remove.mockRestore();
      error.mockRestore();
    }
  });

  it("a NO after YES gives the task back to the next YES, while a NO without a claim or after the photo changes nothing", async () => {
    const at = somewhere();
    const a = await agent();
    const first = await worker(north(at, 50));
    const second = await worker(north(at, 100));
    const { task_id } = await ask(a, at);
    const no = (phone: string) => service.handleWorkerReply({ phone, intent: "no", text: "NO" });
    const last = (phone: string) => outbox.findLast((m) => m.to === phone);
    const token = (phone: string) =>
      new URL(
        String(outbox.findLast((m) => m.to === phone && m.kind === "capture_link")?.payload.capture_url),
      ).searchParams.get("t") ?? "";
    const skipped = "No problem, we will text you the next task nearby.";

    await reply(first.phone);
    await reply(second.phone);
    await no(second.phone);
    expect(last(second.phone)?.payload).toBe(skipped);
    expect(await service.getTask(a, { task_id })).toMatchObject({ status: "claimed" });

    const firstToken = token(first.phone);
    await no(first.phone);
    const released = String(last(first.phone)?.payload);
    expect(released).toBe("Got it, the task is released. Thanks.");
    expect(released.length).toBeLessThanOrEqual(159);
    expect(await service.getTask(a, { task_id })).toMatchObject({ status: "dispatched", claimed_at: null });
    expect(await service.awaitAnswer(a, { task_id, timeout_seconds: 1 })).toMatchObject({
      status: "dispatched",
      answered: false,
    });

    await reply(second.phone);
    expect(last(second.phone)).toMatchObject({ kind: "capture_link", payload: { task_id } });
    await expect(capture(firstToken, at)).rejects.toMatchObject({ code: "task_already_claimed" });
    await capture(token(second.phone), at);
    await no(second.phone);
    expect(last(second.phone)?.payload).toBe(skipped);
    expect(await service.getTask(a, { task_id })).toMatchObject({
      status: "verified",
      answer: { answer_text: "short" },
    });
  });

  it("a released task is offered again to idle workers it was offered to, never the busy or the releaser, and their YES claims it", async () => {
    const at = somewhere();
    const a = await agent();
    const releaser = await worker(north(at, 50));
    const idle = await worker(north(at, 100));
    const busy = await worker(north(at, 2900));
    const { task_id, workers_notified } = await ask(a, at);
    expect(workers_notified).toBe(3);

    providers.clock.advance(1000);
    const elsewhere = await ask(a, north(at, 5000));
    await reply(busy.phone);
    expect(outbox.findLast((m) => m.to === busy.phone)).toMatchObject({
      kind: "capture_link",
      payload: { task_id: elsewhere.task_id },
    });
    await reply(releaser.phone);
    providers.clock.advance(1000);
    await ask(a, north(at, 100));
    providers.clock.advance(1000);

    const before = outbox.length;
    await service.handleWorkerReply({ phone: releaser.phone, intent: "no", text: "NO" });
    expect(outbox.slice(before).filter((m) => m.kind === "offer")).toEqual([
      { to: idle.phone, kind: "offer", payload: expect.objectContaining({ task_id, distance_m: 100 }) },
    ]);

    await reply(idle.phone);
    expect(outbox.findLast((m) => m.to === idle.phone)).toMatchObject({
      kind: "capture_link",
      payload: { task_id },
    });
    expect(await service.getTask(a, { task_id })).toMatchObject({ status: "claimed" });
  });
});
