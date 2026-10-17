import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Agent,
  AppConfig,
  type AskEyesInput,
  agentEmailAddress,
  CaptureResult,
  type EyesError,
  fakeProviders,
  JoinWorkerOutput,
  type LatLng,
  OfferView,
  OwnerConsole,
  type SafetyVerdict,
  SignupOutput,
  signToken,
  type TaskStatus,
  TOOLS,
  type VerificationResult,
} from "@eyes/core";
import { migrate } from "@eyes/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

  it("HELP says what Eyes is, how to opt out and where to read more, in one iMessage-sized text", async () => {
    const { phone } = await worker(somewhere());
    await service.handleWorkerReply({ phone, intent: "help", text: "HELP" });
    const help = String(outbox.findLast((m) => m.to === phone)?.payload);
    expect(help).toBe(
      "Eyes texts you paid tasks to check public places nearby. Reply YES to claim a task, STOP to opt out. More: https://w.eyes.test",
    );
    expect(help.length).toBeLessThanOrEqual(159);
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

  it("accepts only p: owner tokens for the owner console and policy updates", async () => {
    const a = await agent();
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
    }
    expect(await service.getSpendPolicy(a)).toMatchObject({ max_bounty_usd: 10, daily_cap_usd: 20 });
    await expect(service.ownerConsole(signToken(secret, `p:${randomUUID()}`))).rejects.toMatchObject({
      code: "owner_link_invalid",
    });
    await expect(service.updateSpendPolicy(signToken(secret, `p:${a.id}`), policy)).resolves.toMatchObject({
      max_bounty_usd: 1,
      allowed_task_types: [],
    });
  });
});
