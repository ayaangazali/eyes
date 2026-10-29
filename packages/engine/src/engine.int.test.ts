import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Agent,
  AppConfig,
  type AskEyesInput,
  agentEmailAddress,
  CaptureResult,
  type EngineDeps,
  ERRORS,
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
  WorkerSetup,
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
    verifySubmission: async ({ submission: s, vision }) => {
      if (!s.photo_url) return PASS;
      const v = await vision.judge({ photo_url: s.photo_url });
      const vision_ok = v.allowed && !v.prominent_faces;
      return vision_ok ? PASS : { ...PASS, vision_ok, vision_reason: v.reason, auto_approve: false };
    },
    config: AppConfig.parse({
      public_api_url: "https://api.eyes.test",
      worker_web_url: "https://w.eyes.test",
      link_secret: "test-link-secret-0123456789",
      email_domain: "brave-otter.primitive.email",
      live_payouts: true,
    }),
  };
  const service = createEyesService(deps);

  beforeAll(() => migrate(url ?? ""));
  afterAll(() => sql.end());
  afterEach(() => providers.vision.setVerdict({ allowed: true, prominent_faces: false }));

  const somewhere = (): LatLng => ({ lat: 10 + Math.random() * 40, lng: -120 + Math.random() * 60 });
  const north = (p: LatLng, meters: number): LatLng => ({ lat: p.lat + meters / 111_320, lng: p.lng });

  const newPhone = () => `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;

  // START now ends with the setup link, so a token runs to the next space.
  const connectToken = (phone: string) =>
    /\/w\/connect\/(\S+)/.exec(
      String(outbox.findLast((m) => m.to === phone && String(m.payload).includes("/w/connect/"))?.payload),
    )?.[1] ?? "";

  const earningsToken = (url: unknown) => String(url).split("/w/earnings/")[1] ?? "";
  // START and HELP link the setup page (ADR-028); its code is the same "e:" token as the earnings link.
  const meToken = (text: unknown) => /\/me#c=(\S+)/.exec(String(text))?.[1] ?? "";
  async function helpEarnings(phone: string) {
    await service.handleWorkerReply({ phone, intent: "help", text: "HELP" });
    return meToken(outbox.findLast((m) => m.to === phone)?.payload);
  }

  async function worker(at: LatLng, optIn = true) {
    const phone = newPhone();
    const joined = await service.joinWorker({ name: "Test Worker", phone, ...at });
    if (optIn) await service.handleWorkerReply({ phone, intent: "start", text: "START" });
    const [row] = await sql`select id from workers where phone = ${phone}`;
    return { ...joined, worker_id: String(row?.id), phone };
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

  it("logs each offer that fails to send by its error name and counts only delivered offers", async () => {
    const at = somewhere();
    const a = await agent();
    await worker(north(at, 100));
    await worker(north(at, 200));
    const failure = Object.assign(new Error("send failed for +14155550100"), {
      name: "InkboxSendError(403 recipient_not_connected)",
    });
    const send = vi.spyOn(providers.messaging, "sendOffer").mockRejectedValueOnce(failure);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const asked = await ask(a, at);
      expect(asked.workers_notified).toBe(1);
      expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
        `offer for task ${asked.task_id} failed: InkboxSendError(403 recipient_not_connected)`,
      ]);
    } finally {
      send.mockRestore();
      error.mockRestore();
    }
  });

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
      fix: expect.stringContaining("Call list_tasks"),
    });
  });

  it("never lets a repeat join rewrite an existing worker or tell the caller it exists, even after STOP, and sends the payout link only by text after START", async () => {
    const at = somewhere();
    const phone = newPhone();
    const first = await service.joinWorker({ name: "Real Worker", phone, ...at });
    expect(first.connect_url).toBeNull();
    await service.handleWorkerReply({ phone, intent: "start", text: "START" });
    expect(connectToken(phone)).not.toBe("");

    const again = await service.joinWorker({ name: "Someone Else", phone, ...north(at, 2000) });
    expect(again).toEqual(first);
    expect(again).toEqual(await service.joinWorker({ name: "Someone Else", phone: newPhone(), ...at }));
    await service.handleWorkerReply({ phone, intent: "stop", text: "STOP" });
    expect(await service.joinWorker({ name: "Someone Else", phone, lat: 0, lng: 0 })).toEqual(first);
    // STOP deleted the location (ADR-024); the repeat join did not write its own.
    expect(await sql`select name, lat from workers where phone = ${phone}`).toEqual([
      { name: "Real Worker", lat: null },
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
    // STOP reset the app link (it deleted every code), so START also texts a fresh one.
    expect(sent().slice(before + 1)).toEqual([
      // STOP also cleared the spot, so the welcome carries the HERE link before the setup link.
      expect.stringMatching(
        /^You are in\. .*\/w\/connect\/.*\/here\.html\?t=\S+ Your setup: https:\/\/w\.eyes\.test\/me#c=[\w-]+\.[\w-]+$/,
      ),
      expect.stringMatching(/^Get the Eyes app so tasks find you: https:\/\/w\.eyes\.test\/app#c=/),
    ]);
  });

  it("HELP says what Eyes is, how to opt out, where to read more and links the worker's setup page", async () => {
    const { phone } = await worker(somewhere());
    await service.handleWorkerReply({ phone, intent: "help", text: "HELP" });
    const help = String(outbox.findLast((m) => m.to === phone)?.payload);
    const [text, url] = help.split(" Your setup: ");
    expect(text).toBe(
      "Eyes texts you paid tasks to check public places nearby. Reply YES to claim a task, TASK for your task link, APP for your Eyes app link, INSTALL for the iPhone app, STOP to opt out. More: https://w.eyes.test",
    );
    expect(url).toMatch(/^https:\/\/w\.eyes\.test\/me#c=[\w-]+\.[\w-]+$/);
    expect(await service.workerSetup(meToken(url))).toMatchObject({ opted_in: true, tasks: [] });
    expect(help.length).toBeLessThanOrEqual(1600);
  });

  describe("worker setup page (ADR-028)", () => {
    const setupToken = (phone: string) =>
      meToken(outbox.findLast((m) => m.to === phone && String(m.payload).startsWith("You are in."))?.payload);
    const fixToken = (workerId: string) =>
      signToken(deps.config.link_secret, `l:${workerId}`, new Date(providers.clock.now().getTime() + 60_000));
    const refused = {
      code: "unauthorized",
      message: "This link is invalid or has expired.",
      fix: "Text HELP to the Eyes number for a fresh link.",
    };

    it("shows the spot's age, whether the app sends it, payout setup and the 5 newest tasks", async () => {
      const at = somewhere();
      const agents = [await agent(), await agent()];
      const w = await worker(north(at, 50));
      const token = setupToken(w.phone);
      const [joined] = await sql<
        { created_at: Date }[]
      >`select created_at from workers where id = ${w.worker_id}`;
      expect(WorkerSetup.parse(await service.workerSetup(token))).toEqual({
        opted_in: true,
        spot: { at: joined?.created_at.toISOString(), fresh: true, max_age_h: 24 },
        app: { last_at: null, sending: false },
        payouts: {
          set_up: false,
          live: true,
          setup_url: expect.stringMatching(/^https:\/\/api\.eyes\.test\/w\/connect\/[\w-]+\.[\w-]+$/),
        },
        here_url: expect.stringMatching(/^https:\/\/w\.eyes\.test\/here\.html\?t=[\w-]+\.[\w-]+$/),
        earnings_url: expect.stringMatching(/^https:\/\/api\.eyes\.test\/w\/earnings\/[\w-]+\.[\w-]+$/),
        tasks: [],
      });

      // Six claims from two agents (each stays within its $20 grant); the page lists the 5 newest.
      const questions: string[] = [];
      for (let i = 1; i <= 6; i++) {
        const question = `Is the line longer than ${i} people?`;
        await ask(agents[i % 2] as Agent, at, { question });
        await reply(w.phone);
        const link = outbox.findLast((m) => m.to === w.phone && m.kind === "capture_link");
        await capture(new URL(String(link?.payload.capture_url)).searchParams.get("t") ?? "", at);
        questions.unshift(question);
        providers.clock.advance(1000);
      }
      const rows = (payout: string) =>
        questions.slice(0, 5).map((question) => ({
          question,
          place_label: expect.any(String),
          status: "verified",
          bounty_usd: 3,
          payout,
          claimed_at: expect.any(String),
        }));
      expect(WorkerSetup.parse(await service.workerSetup(token)).tasks).toEqual(
        rows("waiting_for_payout_setup"),
      );
      await service.workerConnectUrl(connectToken(w.phone));
      expect(await service.workerSetup(token)).toMatchObject({
        payouts: { set_up: true, live: true, setup_url: null },
        tasks: rows("pending"),
      });

      const start = providers.clock.now();
      try {
        providers.clock.advance(31_000); // past the capture's fix and the 30 s fix interval
        await service.updateWorkerLocation(fixToken(w.worker_id), { ...north(at, 60), source: "app" });
        const appAt = providers.clock.now().toISOString();
        expect(await service.workerSetup(token)).toMatchObject({
          spot: { at: appAt, fresh: true },
          app: { last_at: appAt, sending: true },
        });
        providers.clock.advance(24 * 3_600_000 + 1000);
        expect(await service.workerSetup(token)).toMatchObject({
          spot: { at: appAt, fresh: false },
          app: { last_at: appAt, sending: false },
        });
        await service.updateWorkerLocation(fixToken(w.worker_id), { ...north(at, 50), source: "here_link" });
        expect(await service.workerSetup(token)).toMatchObject({
          spot: { at: providers.clock.now().toISOString(), fresh: true },
          app: { last_at: null, sending: false },
        });
      } finally {
        providers.clock.set(start);
      }
    });

    it("refuses a missing, garbage, tampered, wrong-kind or expired code and an unknown worker", async () => {
      const w = await worker(somewhere());
      const token = setupToken(w.phone);
      const secret = deps.config.link_secret;
      for (const bad of [
        "",
        "garbage",
        `${token}x`,
        signToken(secret, `l:${w.worker_id}`),
        signToken(secret, `e:${randomUUID()}`),
      ]) {
        await expect(service.workerSetup(bad)).rejects.toMatchObject(refused);
        await expect(service.workerInstallLink(bad)).rejects.toMatchObject(refused);
      }
      const issued = providers.clock.now();
      try {
        providers.clock.advance(7 * 24 * 3_600_000 + 1000);
        await expect(service.workerSetup(token)).rejects.toMatchObject(refused);
      } finally {
        providers.clock.set(issued);
      }
    });

    it("install mints a working location code, as the /app link with TestFlight, never for an opted-out worker", async () => {
      const w = await worker(somewhere());
      const token = setupToken(w.phone);
      const { install_url } = await service.workerInstallLink(token);
      expect(install_url).toMatch(/^https:\/\/w\.eyes\.test\/install#c=[\w-]{43}$/);
      await expect(service.workerDevice(install_url.split("#c=")[1] ?? "")).resolves.toMatchObject({
        registered: false,
      });
      const withLink = createEyesService({
        ...deps,
        config: AppConfig.parse({
          ...deps.config,
          testflight_url: "https://testflight.apple.com/join/TESTLINK1",
        }),
      });
      expect((await withLink.workerInstallLink(token)).install_url).toMatch(
        /^https:\/\/w\.eyes\.test\/app#c=[\w-]{43}$/,
      );
      await service.handleWorkerReply({ phone: w.phone, intent: "stop", text: "STOP" });
      await expect(service.workerInstallLink(token)).rejects.toMatchObject(refused);
      expect(await service.workerSetup(token)).toMatchObject({
        opted_in: false,
        spot: { at: null, fresh: false },
        app: { last_at: null, sending: false },
      });
    });
  });

  it("INSTALL without TestFlight texts the /install link with a fresh app code; APP adds it as a second line", async () => {
    const { phone } = await worker(somewhere());
    await service.handleWorkerReply({ phone, intent: "install", text: "INSTALL" });
    const install = String(outbox.findLast((m) => m.to === phone)?.payload);
    expect(install).toMatch(/^Get the Eyes app: https:\/\/w\.eyes\.test\/install#c=[\w-]{43}$/);
    const code = install.slice(-43);
    expect(await service.workerDevice(code)).toMatchObject({ registered: false, ready: false });
    await service.handleWorkerReply({ phone, intent: "app", text: "APP" });
    const [first, second, ...rest] = String(outbox.findLast((m) => m.to === phone)?.payload).split("\n");
    const appCode = /\/app#c=([\w-]{43})$/.exec(first ?? "")?.[1];
    expect(appCode).toMatch(/^[\w-]{43}$/);
    expect(appCode).not.toBe(code);
    expect([second, rest]).toEqual([`Don't have the app? https://w.eyes.test/install#c=${appCode}`, []]);
  });

  it("INSTALL texts the TestFlight link and steps when EYES_TESTFLIGHT_URL is set", async () => {
    const link = "https://testflight.apple.com/join/TESTLINK1";
    const withLink = createEyesService({
      ...deps,
      config: AppConfig.parse({ ...deps.config, testflight_url: link }),
    });
    const { phone } = await worker(somewhere());
    await withLink.handleWorkerReply({ phone, intent: "install", text: "INSTALL" });
    expect(String(outbox.findLast((m) => m.to === phone)?.payload)).toBe(
      `Get the Eyes iPhone app: 1) Install TestFlight and Eyes here: ${link} 2) Then text APP to connect it.`,
    );
  });

  it("APP adds a second line with the TestFlight link when EYES_TESTFLIGHT_URL is set", async () => {
    const link = "https://testflight.apple.com/join/TESTLINK1";
    const withLink = createEyesService({
      ...deps,
      config: AppConfig.parse({ ...deps.config, testflight_url: link }),
    });
    const { phone } = await worker(somewhere());
    await withLink.handleWorkerReply({ phone, intent: "app", text: "APP" });
    const lines = String(outbox.findLast((m) => m.to === phone)?.payload).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^Get the Eyes app so tasks find you: https:\/\/w\.eyes\.test\/app#c=[\w-]{43}$/,
    );
    expect(lines[1]).toBe(`Don't have the app? ${link}`);
  });

  it("START puts the TestFlight install link before the app link when EYES_TESTFLIGHT_URL is set", async () => {
    const link = "https://testflight.apple.com/join/TESTLINK1";
    const withLink = createEyesService({
      ...deps,
      config: AppConfig.parse({ ...deps.config, testflight_url: link }),
    });
    const { phone } = await worker(somewhere());
    await withLink.handleWorkerReply({ phone, intent: "start", text: "START" });
    const lines = String(outbox.findLast((m) => m.to === phone)?.payload).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`Install the Eyes iPhone app first: ${link}`);
    expect(lines[1]).toMatch(
      /^Get the Eyes app so tasks find you: https:\/\/w\.eyes\.test\/app#c=[\w-]{43}$/,
    );
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
      [
        "says a key with a daily cap of 0 is frozen by its user",
        { daily_cap_usd: 0 },
        null,
        blocked("froze"),
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

  it("charges nothing on insufficient balance and tells the agent what it can afford, with or without workers nearby", async () => {
    const at = somewhere();
    const a = await agent();
    await sql`update agents set balance_cents = 100 where id = ${a.id}`;
    const broke = {
      code: "insufficient_balance",
      context: { balance_usd: 1, needed_usd: 3.5, max_affordable_bounty_usd: 0.5 },
    };

    await expect(ask(a, at)).rejects.toMatchObject(broke);
    await worker(north(at, 100));
    await expect(ask(a, at)).rejects.toMatchObject(broke);
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
    expect(mail?.text).toContain(`An AI agent (Eyes agent id ${signup.agent_id})`);
    expect(mail?.text).not.toContain("owned-agent");
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
    const frozen = await ask(await fresh(), at, { bounty_usd: 2 }).catch((err: EyesError) => err);
    expect(frozen).toMatchObject({ code: "daily_cap_exceeded", fix: expect.stringContaining("froze") });
    expect((frozen as EyesError).fix).not.toMatch(/tomorrow|Lower bounty_usd/);

    await service.updateSpendPolicy(ownerToken, {
      max_bounty_usd: 50,
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

  it("tells workers payouts are simulated and never texts a payout link when payouts are not live", async () => {
    const simulated = "This is a test server and payouts are simulated, so no real money is paid.";
    const sim = createEyesService({ ...deps, config: { ...deps.config, live_payouts: false } });
    const at = somewhere();
    const phone = newPhone();
    const last = (kind: string) => outbox.findLast((m) => m.to === phone && m.kind === kind)?.payload;
    const capture = async (extra: Partial<AskEyesInput> = {}) => {
      const asked = await sim.askEyes(await agent(), {
        question: "Is the line long right now?",
        location: at,
        task_type: "line_length",
        bounty_usd: 3,
        deadline_minutes: 30,
        require_photo: true,
        idempotency_key: randomUUID(),
        ...extra,
      });
      expect(last("offer")).toMatchObject({ task_id: asked.task_id, live_payouts: false });
      await sim.handleWorkerReply({ phone, intent: "yes", text: "YES" });
      const token = new URL(String(last("capture_link")?.capture_url)).searchParams.get("t") ?? "";
      const result = await sim.submitCapture(
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
      return { task_id: asked.task_id, result };
    };

    await sim.handleWorkerReply({ phone, intent: "start", text: "START" });
    expect(last("text")).toBe(
      `You are not signed up for Eyes yet. Join at https://w.eyes.test to get paid tasks near you. ${simulated}`,
    );
    const joined = await sim.joinWorker({ name: "Test Worker", phone, ...at });
    expect(joined.opt_in_instructions).toBe(
      `Text START to the Eyes number to start getting paid tasks near you. When a task text arrives, reply YES to claim it. Text STOP any time to pause. ${simulated}`,
    );
    await sim.handleWorkerReply({ phone, intent: "start", text: "START" });
    const texts = outbox.filter((m) => m.to === phone && m.kind === "text").map((m) => m.payload);
    const [welcome, setup] = String(texts.at(-2)).split(" Your setup: ");
    expect(welcome).toBe(`You are in. Eyes will text you paid tasks nearby. ${simulated}`);
    expect(await sim.workerSetup(meToken(setup))).toMatchObject({
      payouts: { set_up: false, live: false, setup_url: null },
    });
    expect(String(texts.at(-1))).toMatch(/^Get the Eyes app so tasks find you: /);
    await sim.handleWorkerReply({ phone, intent: "help", text: "HELP" });
    expect(String(last("text"))).toContain(`STOP to opt out. ${simulated} More: `);

    const verified = await capture();
    expect(verified.result).toMatchObject({ status: "verified", message: `Verified. ${simulated}` });
    expect(last("paid")).toMatchObject({ task_id: verified.task_id, live_payouts: false });

    providers.vision.setVerdict({ allowed: false, reason: "A screen shows personal details." });
    const review = await capture();
    expect(review.result).toMatchObject({
      status: "needs_review",
      message: `Thanks, we got it. Your answer needs a quick manual check (A screen shows personal details.). ${simulated} To request a manual review, reply HELP to the Eyes text.`,
    });
    expect(outbox.some((m) => m.to === phone && JSON.stringify(m.payload).includes("/w/connect/"))).toBe(
      false,
    );
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

  it("emails only the first payer a working owner link, once, and never shows the link to the agent", async () => {
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
    expect(providers.email.outbox).toHaveLength(before + 1);

    const later = `later-${randomUUID()}@example.com`;
    await service.creditTopup({ ...topup, stripe_ref: `cs_${randomUUID()}`, payer_email: later });
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 50 });
    expect(providers.email.outbox).toHaveLength(before + 1);
    for (const out of [await service.getBalance(a), await service.getSpendPolicy(a)]) {
      expect(JSON.stringify(out)).not.toContain("/owner/");
    }
  });

  it("emails one owner link when first payments for an agent arrive at the same time", async () => {
    const overlapping = async (agentId: string, calls: () => Promise<unknown>[]) => {
      const lock = await sql.reserve();
      await lock`begin`;
      await lock`select 1 from agents where id = ${agentId} for update`;
      const running = Promise.all(calls());
      await sleep(500);
      await lock`commit`;
      lock.release();
      await running;
    };
    const topup = (agentId: string, stripe_ref: string, payer_email: string) =>
      service.creditTopup({ agent_id: agentId, amount_cents: 1500, stripe_ref, payer_email });

    const a = await agent();
    const payer = `payer-${randomUUID()}@example.com`;
    const ref = `cs_${randomUUID()}`;
    const before = providers.email.outbox.length;
    await overlapping(a.id, () => Array.from({ length: 5 }, () => topup(a.id, ref, payer)));
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 35 });
    expect(providers.email.outbox.slice(before).map((m) => m.to)).toEqual([payer]);

    const b = await agent();
    const payers = [`first-${randomUUID()}@example.com`, `second-${randomUUID()}@example.com`];
    const start = providers.email.outbox.length;
    await overlapping(b.id, () => payers.map((p) => topup(b.id, `cs_${randomUUID()}`, p)));
    expect(await service.getBalance(b)).toMatchObject({ balance_usd: 50 });
    const sent = providers.email.outbox.slice(start);
    expect(sent).toHaveLength(1);
    expect(payers).toContain(sent[0]?.to);
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
    const row = {
      question: expect.any(String),
      task_type: expect.any(String),
      place_label: expect.any(String),
      claimed_at: expect.any(String),
    };

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

  it("points a bad payout setup link at START for a fresh one, not at tasks", async () => {
    await expect(service.workerConnectUrl("garbage")).rejects.toMatchObject({
      code: "offer_invalid",
      message: "This payout setup link is invalid or has expired.",
      fix: "Text START to the Eyes number for a fresh payout setup link.",
    });
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
      w,
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

  it("keeps the photo without prominent faces, delivering it only when moderation allows it", async () => {
    for (const allowed of [true, false]) {
      providers.vision.setVerdict({ allowed });
      const at = somewhere();
      const { a, task_id, token } = await claimed(at);
      const { status } = await capture(token, at);
      expect(status === "needs_review").toBe(!allowed);
      const [key] = stored(task_id);
      expect(key).toBeDefined();
      expect((await service.getTask(a, { task_id })).answer?.photo_url).toBe(
        allowed ? `https://storage.fake.test/photos/${key}` : null,
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

  const tickets = (taskId: string) =>
    sql`select id::int, status, message, note from tickets where task_id = ${taskId}`;

  it("HELP after a held answer opens a ticket, a free-text reply adds to it, and resolving it texts the worker", async () => {
    const at = somewhere();
    providers.vision.setVerdict({ allowed: false, reason: "A screen shows personal details." });
    const { task_id, token, w } = await claimed(at);
    expect(await capture(token, at)).toMatchObject({
      status: "needs_review",
      message:
        "Thanks, we got it. Your answer needs a quick manual check (A screen shows personal details.). You will be paid once it is approved. To request a manual review, reply HELP to the Eyes text.",
    });
    const last = () => outbox.findLast((m) => m.to === w.phone)?.payload;

    await service.handleWorkerReply({ phone: w.phone, intent: "help", text: "HELP" });
    const [opened] = await tickets(task_id);
    const id = Number(opened?.id);
    expect(opened).toMatchObject({ status: "open", message: "HELP" });
    expect(last()).toBe(
      `Eyes: ticket #${id} opened. Someone will check your answer by hand and text you the outcome. Reply here to add details.`,
    );

    await service.handleWorkerReply({
      phone: w.phone,
      intent: "unknown",
      text: "The line is round the corner",
    });
    expect(last()).toBe(`Eyes: added to ticket #${id}. We will text you the outcome.`);
    expect(await tickets(task_id)).toEqual([
      { id, status: "open", message: "HELP\nThe line is round the corner", note: null },
    ]);

    const note = "The line is visible at the left edge.";
    expect(await service.resolveTicket({ ticket_id: id, outcome: "release", note })).toEqual({
      ticket_id: id,
      task_id,
      status: "resolved",
    });
    expect(last()).toBe(
      `Eyes: ticket #${id} is resolved. Your answer was approved and you are being paid. Note: ${note}`,
    );
    expect(await tickets(task_id)).toMatchObject([{ id, status: "resolved", note }]);
    await expect(service.resolveTicket({ ticket_id: id, outcome: "close", note })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("HELP without a held answer from the last 48 hours keeps the usual replies and opens no ticket", async () => {
    const at = somewhere();
    const verified = await claimed(at);
    await capture(verified.token, at);
    providers.vision.setVerdict({ allowed: false });
    const oldAt = somewhere();
    const old = await claimed(oldAt);
    await capture(old.token, oldAt);
    const start = providers.clock.now();
    providers.clock.advance(48 * 60 * 60 * 1000 + 1);
    try {
      for (const { w, task_id } of [verified, old]) {
        await service.handleWorkerReply({ phone: w.phone, intent: "help", text: "HELP" });
        expect(String(outbox.findLast((m) => m.to === w.phone)?.payload)).toMatch(
          /^Eyes texts you paid tasks to check public places nearby\. .* Your setup: /,
        );
        await service.handleWorkerReply({ phone: w.phone, intent: "unknown", text: "hello?" });
        expect(outbox.findLast((m) => m.to === w.phone)?.payload).toBe(
          "Sorry, we did not get that. Reply YES to claim the task, NO to skip it, or HELP for help.",
        );
        expect(await tickets(task_id)).toEqual([]);
      }
    } finally {
      providers.clock.set(start);
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

  it("TASK texts the live capture link for the worker's open claim, and the no-task text when none is open, submitted or expired", async () => {
    const at = somewhere();
    const a = await agent();
    const w = await worker(north(at, 50));
    const none = "You have no open task right now. We'll text you when one is near.";
    const task = async () => {
      await service.handleWorkerReply({ phone: w.phone, intent: "task", text: "TASK" });
      return outbox.findLast((m) => m.to === w.phone)?.payload;
    };
    const claimLink = async () => {
      await reply(w.phone);
      return String(
        outbox.findLast((m) => m.to === w.phone && m.kind === "capture_link")?.payload.capture_url,
      );
    };

    expect(await task()).toBe(none);

    await ask(a, at);
    const link = await claimLink();
    expect(await task()).toBe(`Eyes: here is the link for your task: ${link}`);
    await capture(new URL(link).searchParams.get("t") ?? "", at);
    expect(await task()).toBe(none);

    const { task_id } = await ask(a, at);
    const next = await claimLink();
    expect(next).not.toBe(link);
    expect(await task()).toBe(`Eyes: here is the link for your task: ${next}`);
    const past = new Date(providers.clock.now().getTime() - 60_000);
    await sql`update tasks set deadline_at = ${past} where id = ${task_id}`;
    expect(await task()).toBe(none);
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

  it("offers a released task again to each worker at most once, however often it is claimed and released", async () => {
    const at = somewhere();
    const a = await agent();
    const releaser = await worker(north(at, 50));
    const other = await worker(north(at, 100));
    const { task_id } = await ask(a, at);
    const offersTo = (phone: string) =>
      outbox.filter((m) => m.to === phone && m.kind === "offer" && m.payload.task_id === task_id);

    for (let i = 0; i < 2; i++) {
      providers.clock.advance(1000);
      await reply(releaser.phone);
      expect(await service.getTask(a, { task_id })).toMatchObject({ status: "claimed" });
      await service.handleWorkerReply({ phone: releaser.phone, intent: "no", text: "NO" });
    }
    expect(offersTo(other.phone)).toHaveLength(2);
    expect(offersTo(releaser.phone)).toHaveLength(1);
  });

  describe("disputes (ADR-026)", () => {
    // A paid task: the worker finished payout setup, so the capture pays out a fake transfer.
    async function paidTask() {
      const at = somewhere();
      const { a, w, task_id, token } = await claimed(at);
      await service.workerConnectUrl(connectToken(w.phone));
      expect(await capture(token, at)).toMatchObject({ status: "paid" });
      return { a, w, task_id, at };
    }
    const balance = async (a: Agent) => (await service.getBalance(a)).balance_usd;
    const disputeTicket = async (task_id: string) =>
      Number((await sql`select id from tickets where task_id = ${task_id} and kind = 'dispute'`)[0]?.id);

    it("dispute_answer opens a dispute ticket that get_task reports as open", async () => {
      const { a, task_id } = await paidTask();
      await service.disputeAnswer(a, { task_id, reason: "The photo shows a different cafe." });
      const [t] =
        await sql`select kind, status, dispute_status, message from tickets where task_id = ${task_id}`;
      expect(t).toMatchObject({
        kind: "dispute",
        status: "open",
        dispute_status: "open",
        message: "The photo shows a different cafe.",
      });
      expect((await service.getTask(a, { task_id })).dispute).toEqual({ status: "open", refunded_usd: null });
    });

    it("confirm fraud refunds bounty + fee, reverses the transfer once, bans the worker; a double click moves nothing", async () => {
      const { a, w, task_id, at } = await paidTask();
      await service.disputeAnswer(a, { task_id, reason: "Fake: the cafe was closed." });
      const before = await balance(a);
      const ticket_id = await disputeTicket(task_id);
      const results = (
        await Promise.all([
          service.confirmFraud({ ticket_id, note: "fake photo" }),
          service.confirmFraud({ ticket_id, note: "fake photo" }),
        ])
      ).sort((x, y) => Number(x.already_resolved) - Number(y.already_resolved));
      expect(results[0]).toMatchObject({
        dispute_status: "upheld",
        agent_refund_cents: 350,
        reversal: "reversed",
        worker_banned: true,
        already_resolved: false,
      });
      expect(results[1]).toMatchObject({
        dispute_status: "upheld",
        agent_refund_cents: 0,
        already_resolved: true,
      });
      expect(await balance(a)).toBeCloseTo(before + 3.5);
      expect(
        providers.payments.reversals.filter((r) => r.idempotency_key === `reverse-${task_id}`),
      ).toHaveLength(1);
      expect(await ledger(task_id)).toContainEqual(
        expect.objectContaining({ type: "fraud_refund", amount: 350 }),
      );
      expect((await service.getBalance(a)).escrowed_usd).toBeGreaterThanOrEqual(0);
      expect((await service.getTask(a, { task_id })).dispute).toEqual({
        status: "upheld",
        refunded_usd: 3.5,
      });
      const [banned] = await sql`select banned, opted_in from workers where id = ${w.worker_id}`;
      expect(banned).toMatchObject({ banned: true, opted_in: false });
      expect(await sql`select 1 from worker_location_tokens where worker_id = ${w.worker_id}`).toHaveLength(
        0,
      );
      await service.handleWorkerReply({ phone: w.phone, intent: "start", text: "START" });
      expect(outbox.findLast((m) => m.to === w.phone)?.payload).toBe("This number can't take Eyes tasks.");
      expect((await sql`select opted_in from workers where id = ${w.worker_id}`)[0]?.opted_in).toBe(false);
      // The banned worker was the only one here: no offer goes out, the new task finds nobody.
      await expect(ask(a, at)).rejects.toMatchObject({ code: "no_workers_nearby" });
    });

    it("records the reversal as owed when the connected account has no balance", async () => {
      const { a, task_id } = await paidTask();
      await service.disputeAnswer(a, { task_id, reason: "Fake answer, wrong place." });
      const ticket_id = await disputeTicket(task_id);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      providers.payments.failReversals("balance_insufficient");
      try {
        expect(await service.confirmFraud({ ticket_id, note: "fake" })).toMatchObject({
          reversal: "owed",
          reversal_owed_cents: 300,
        });
      } finally {
        providers.payments.failReversals(null);
        error.mockRestore();
      }
      const [row] = await sql`select reversal_owed_cents::int as owed from tickets where id = ${ticket_id}`;
      expect(row?.owed).toBe(300);
      expect(await service.confirmFraud({ ticket_id, note: "again" })).toMatchObject({
        reversal: "owed",
        reversal_owed_cents: 300,
        already_resolved: true,
      });
    });

    it("reject dispute closes the ticket once and the worker keeps the pay", async () => {
      const { a, task_id } = await paidTask();
      await service.disputeAnswer(a, { task_id, reason: "I think the line was longer." });
      const before = await balance(a);
      const ticket_id = await disputeTicket(task_id);
      expect(await service.rejectDispute({ ticket_id, note: "photo matches" })).toMatchObject({
        dispute_status: "rejected",
        already_resolved: false,
      });
      expect(await service.rejectDispute({ ticket_id, note: "photo matches" })).toMatchObject({
        already_resolved: true,
      });
      expect(await service.getTask(a, { task_id })).toMatchObject({
        status: "paid",
        dispute: { status: "rejected", refunded_usd: null },
      });
      expect(await balance(a)).toBe(before);
      expect(providers.payments.reversals.some((r) => r.idempotency_key === `reverse-${task_id}`)).toBe(
        false,
      );
    });

    it("confirm fraud on an unpaid needs_review answer refunds through escrow and reverses nothing", async () => {
      const at = somewhere();
      const { a, task_id, token } = await claimed(at);
      providers.vision.setVerdict({ allowed: false });
      await capture(token, at);
      await service.disputeAnswer(a, { task_id, reason: "Fake answer, wrong place." });
      const r = await service.confirmFraud({ ticket_id: await disputeTicket(task_id), note: "fake" });
      expect(r).toMatchObject({ agent_refund_cents: 350, reversal: "none" });
      expect(await ledger(task_id)).toContainEqual(expect.objectContaining({ type: "refund", amount: 350 }));
      expect((await service.getBalance(a)).escrowed_usd).toBe(0);
    });
  });

  describe("edge paths", () => {
    const secret = deps.config.link_secret;

    it("geocodes a string location, refuses an unknown place, and gives no ETA with nobody nearby", async () => {
      const a = await agent();
      const at = somewhere();
      const quote = await service.quoteTask(a, { location: `${at.lat},${at.lng}`, task_type: "line_length" });
      expect(quote).toMatchObject({
        workers_nearby: 0,
        est_minutes_to_answer: null,
        resolved_location: { lat: at.lat, lng: at.lng, label: `${at.lat},${at.lng}` },
      });
      await expect(
        service.quoteTask(a, { location: "Nowhere Street 1, Atlantis", task_type: "line_length" }),
      ).rejects.toMatchObject({ code: "location_not_found" });
    });

    it("explains an unsafe quote with the classifier text or the default message, and refuses ask_eyes", async () => {
      const a = await agent();
      const at = somewhere();
      const refusals: [string | null, string][] = [
        ["Weapons are off limits.", "Weapons are off limits."],
        [null, ERRORS.unsafe_task.message],
      ];
      try {
        for (const [reason, expected] of refusals) {
          safety = { allowed: false, category: "illegal_or_dangerous", reason, fix: null, layer: "rules" };
          expect(await service.quoteTask(a, { location: at, task_type: "line_length" })).toMatchObject({
            allowed: false,
            reason_if_not: expected,
          });
        }
        await expect(ask(a, at)).rejects.toMatchObject({ code: "unsafe_task" });
      } finally {
        safety = ALLOW;
      }
    });

    it("names 'none' for a key allowed no task types, and an owner link for a missing agent is invalid", async () => {
      const a = await agent();
      await service.updateSpendPolicy(signToken(secret, `p:${a.id}`), {
        max_bounty_usd: 5,
        daily_cap_usd: 50,
        allowed_task_types: [],
      });
      const quote = await service.quoteTask(a, { location: somewhere(), task_type: "line_length" });
      expect(quote.reason_if_not).toContain("its allowed_task_types are none.");
      await expect(
        service.updateSpendPolicy(signToken(secret, `p:${randomUUID()}`), {
          max_bounty_usd: 5,
          daily_cap_usd: 50,
          allowed_task_types: ["line_length"],
        }),
      ).rejects.toMatchObject({ code: "owner_link_invalid" });
    });

    it("refuses an ask without an idempotency key before charging", async () => {
      const at = somewhere();
      const a = await agent();
      await worker(north(at, 100));
      await expect(ask(a, at, { idempotency_key: undefined })).rejects.toMatchObject({
        code: "invalid_input",
      });
      expect(await service.getBalance(a)).toMatchObject({ balance_usd: 20, escrowed_usd: 0 });
    });

    it("tells an agent with no tasks how to start, or to drop the status filter", async () => {
      const a = await agent();
      expect(await service.listTasks(a, { limit: 20 })).toEqual({
        tasks: [],
        next_step: "You have no tasks yet. Call quote_task, then ask_eyes to create one.",
      });
      expect((await service.listTasks(a, { status: "paid", limit: 20 })).next_step).toBe(
        "You have no tasks with status paid. Call list_tasks without status to see all your tasks.",
      );
    });

    it("opens a $20 top-up checkout only for a t: token", async () => {
      const a = await agent();
      const checkout = vi.spyOn(providers.payments, "createTopupCheckout");
      try {
        expect(await service.topupCheckoutUrl(signToken(secret, `t:${a.id}`))).toBe(
          "https://api.eyes.test/topup/done?simulated=1",
        );
        expect(checkout).toHaveBeenCalledWith(
          expect.objectContaining({ agent_id: a.id, amount_cents: 2000 }),
        );
        for (const token of ["nope", signToken(secret, `p:${a.id}`)])
          await expect(service.topupCheckoutUrl(token)).rejects.toMatchObject({
            code: "unauthorized",
            message: "This top-up link is invalid.",
          });
      } finally {
        checkout.mockRestore();
      }
    });

    it("live mode issues eyes_live_ keys with no grant, and owner email failures log a redacted reason", async () => {
      const live = createEyesService({ ...deps, config: { ...deps.config, test_mode: false } });
      const send = vi
        .spyOn(providers.email, "send")
        .mockRejectedValueOnce("smtp down")
        .mockRejectedValueOnce(
          Object.assign(new Error("rejected owner@example.com, see https://smtp.example/x"), { status: 550 }),
        );
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const first = await live.signupAgent({ name: "live-agent", owner_email: "owner@example.com" });
        expect(first.api_key).toMatch(/^eyes_live_/);
        expect(first.balance_usd).toBe(0);
        expect(first.next_step).toContain("We could not email your user at owner@example.com");
        const second = await live.signupAgent({ name: "live-agent", owner_email: "owner@example.com" });
        expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
          `owner email for agent ${first.agent_id} failed: unknown`,
          `owner email for agent ${second.agent_id} failed: Error status 550: rejected <redacted> see <redacted>`,
        ]);
      } finally {
        send.mockRestore();
        error.mockRestore();
      }
    });

    it("ignores STOP from an unknown number and anything but START from a banned worker", async () => {
      const before = outbox.length;
      await service.handleWorkerReply({ phone: newPhone(), intent: "stop", text: "STOP" });
      const w = await worker(somewhere());
      await sql`update workers set banned = true where id = ${w.worker_id}`;
      const sent = outbox.length;
      await service.handleWorkerReply({ phone: w.phone, intent: "help", text: "HELP" });
      expect(outbox.length).toBe(sent);
      expect(outbox.slice(before).some((m) => m.to !== w.phone)).toBe(false);
    });

    it("reuses the worker's Stripe account on a second payout setup link", async () => {
      const w = await worker(somewhere());
      const create = vi.spyOn(providers.payments, "createWorkerAccount");
      try {
        const token = connectToken(w.phone);
        const first = await service.workerConnectUrl(token);
        expect(await service.workerConnectUrl(token)).toBe(first);
        expect(create).toHaveBeenCalledTimes(1);
      } finally {
        create.mockRestore();
      }
    });

    it("needs the photo a task requires, answers Yes/No from answer_bool, and shows no payout before release", async () => {
      for (const answer_bool of [true, false]) {
        const at = somewhere();
        const { a, w, task_id, token } = await claimed(at);
        const fields = {
          lat: at.lat,
          lng: at.lng,
          accuracy_m: 5,
          captured_at: providers.clock.now().toISOString(),
          answer_text: null,
          answer_bool,
        };
        await expect(service.submitCapture(token, fields, null)).rejects.toMatchObject({
          code: "invalid_input",
          fix: "Take a photo with the capture page camera and submit again.",
        });
        const earnings = await service.workerEarnings(await helpEarnings(w.phone));
        expect(earnings.tasks.find((t) => t.task_id === task_id)).toMatchObject({
          status: "claimed",
          payout: null,
        });
        await service.submitCapture(token, fields, {
          bytes: new Uint8Array([1]),
          content_type: "image/jpeg",
        });
        expect((await service.getTask(a, { task_id })).answer).toMatchObject({
          answer_text: answer_bool ? "Yes" : "No",
          answer_bool,
        });
      }
    });

    it("pings stale workers, re-offers after 30 s, and logs ping and re-offer failures by name", async () => {
      const pinging = createEyesService({ ...deps, config: { ...deps.config, location_ping: true } });
      const places = [somewhere(), somewhere(), somewhere(), somewhere()];
      const stale: { phone: string; worker_id: string }[] = [];
      for (const p of places) stale.push(await worker(north(p, 200)));
      providers.clock.advance(25 * 3_600_000);
      await worker(north(places[0] as LatLng, 100));
      await worker(north(places[1] as LatLng, 100));
      await worker(north(places[3] as LatLng, 100));
      const a = await agent();
      const askAt = (at: LatLng | undefined) =>
        pinging.askEyes(a, {
          question: "Is the line long right now?",
          location: at as LatLng,
          task_type: "line_length",
          bounty_usd: 3,
          deadline_minutes: 30,
          require_photo: true,
          idempotency_key: randomUUID(),
        });
      // The pinged worker taps the HERE link from its ping text.
      const answerPing = (i: number) => {
        const ping = outbox.findLast(
          (m) => m.to === stale[i]?.phone && /^Eyes ping /.test(String(m.payload)),
        );
        const link = /https:\S+/.exec(String(ping?.payload))?.[0] ?? "x:";
        return service.updateWorkerLocation(new URL(link).searchParams.get("t") ?? "", {
          ...north(places[i] as LatLng, 150),
          source: "here_link",
        });
      };
      const timers: (() => Promise<unknown>)[] = [];
      const realSetTimeout = globalThis.setTimeout;
      const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: () => Promise<unknown>,
        ms?: number,
        ...rest: unknown[]
      ) => {
        // postgres also arms 30 s timers; hold back only the engine's re-offer.
        if (ms !== 30_000 || !String(fn).includes("offerMore")) return realSetTimeout(fn, ms, ...rest);
        timers.push(fn);
        return { unref: () => {} };
      }) as unknown as typeof setTimeout);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        // Ping delivered: after 30 s the task goes to the pinged worker, now fresh.
        const first = await askAt(places[0]);
        expect(first.workers_notified).toBe(1);
        await answerPing(0);
        await timers[0]?.();
        expect(
          outbox.some(
            (m) => m.to === stale[0]?.phone && m.kind === "offer" && m.payload.task_id === first.task_id,
          ),
        ).toBe(true);

        // The re-offer itself fails: logged by error name, never thrown.
        const second = await askAt(places[1]);
        await answerPing(1);
        const offerFail = vi.spyOn(providers.messaging, "sendOffer").mockImplementationOnce(() => {
          throw new TypeError("bad offer");
        });
        await timers[1]?.();
        offerFail.mockRestore();

        // Nobody fresh: the ping still goes out (here it fails to send), then no_workers_nearby.
        vi.spyOn(providers.messaging, "sendText").mockRejectedValueOnce("carrier down");
        await expect(askAt(places[2])).rejects.toMatchObject({ code: "no_workers_nearby" });

        // Pinging itself throws: the ask still succeeds, with no re-offer timer.
        vi.spyOn(providers.messaging, "sendText").mockImplementationOnce(() => {
          throw new RangeError("bad ping");
        });
        expect((await askAt(places[3])).workers_notified).toBe(1);
        expect(timers).toHaveLength(2);
        expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
          `re-offer for task ${second.task_id} failed: TypeError`,
          "ping failed: string",
          "location pings failed: RangeError",
        ]);
      } finally {
        timer.mockRestore();
        error.mockRestore();
        vi.restoreAllMocks();
      }
    });
  });
});
