import { createHmac, randomInt, randomUUID } from "node:crypto";
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
  WorkerSetup,
  WorkerTasks,
} from "@eyes/core";
import { createRpc, migrate } from "@eyes/db";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../../../apps/mcp/src/server.ts";
import { withShortLinks } from "../../../apps/mcp/src/short-links.ts";
import { inkboxRoutes, parseReplyIntent } from "../../comms/src/inkbox.ts";
import { withWorkerEmail } from "../../comms/src/primitive.ts";
import { UNAVAILABLE } from "../../safety/src/index.ts";
import { checkRules } from "../../safety/src/rules.ts";
import { verifySubmission } from "../../verify/src/index.ts";
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

const commands = [
  "YES",
  "NO",
  "TASK",
  "HERE",
  "APP",
  "INSTALL",
  "SHORTCUT",
  "EMAIL",
  "EMAIL OFF",
  "START",
  "STOP",
  "HELP",
];

// Check the runtime message contract, not the wording of each short description.
function hubLines(payload: unknown): string[] {
  const text = String(payload);
  const [setup, menu, inputs, ...rest] = text.split("\n\n");
  expect(rest).toEqual([]);
  const lines = menu?.split("\n") ?? [];
  expect(lines.map((line) => line.split(" — ")[0])).toEqual(commands);
  for (const line of lines) expect(line).toMatch(/^[A-Z]+(?: OFF)? — [^();\n]{1,55}$/);
  expect(text).not.toMatch(/aliases|\bYEP\b|\bUNSTOP\b|\bSTOPALL\b|\bE-MAIL\b/);
  expect(inputs).toMatch(/Maps link, coordinates or email address/);
  return setup?.split("\n") ?? [];
}

describe.skipIf(!url)("engine on Postgres", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const providers = fakeProviders();
  const outbox = providers.messaging.outbox as {
    to: string;
    kind: string;
    payload: Record<string, unknown>;
  }[];
  let safety = ALLOW;
  const notices: { kind: string; summary: string }[] = [];
  const deps: EngineDeps = {
    db: { kind: "postgres", url: url ?? "" },
    providers,
    assessTask: async () => safety,
    verifySubmission: async ({ submission: s, vision }) => {
      if (!s.photo_url) return PASS;
      const v = await vision.judge({ photo_url: s.photo_url });
      const vision_ok = v.allowed;
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
  const service = createEyesService(deps, (e) => notices.push(e));

  beforeAll(() => migrate(url ?? ""));
  afterAll(() => sql.end());
  afterEach(() => providers.vision.setVerdict({ allowed: true }));

  const somewhere = (): LatLng => ({ lat: 10 + Math.random() * 40, lng: -120 + Math.random() * 60 });
  const north = (p: LatLng, meters: number): LatLng => ({ lat: p.lat + meters / 111_320, lng: p.lng });

  const newPhone = () => `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;

  // START now ends with the setup link, so a token runs to the next space.
  const connectToken = (phone: string) =>
    /\/w\/connect\/(\S+)/.exec(
      String(outbox.findLast((m) => m.to === phone && String(m.payload).includes("/w/connect/"))?.payload),
    )?.[1] ?? "";

  // START, HELP and the paid text link the setup page (ADR-028) with the worker's "e:" token as its code.
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

  async function textWebhook(phone: string, content: string, media: unknown[] = []) {
    const key = "worker-replies-signing-key";
    const app = inkboxRoutes(
      { service, providers, config: deps.config },
      { INKBOX_WEBHOOK_SIGNING_KEY: key },
    );
    const body = JSON.stringify({
      event_type: "imessage.received",
      data: { message: { id: randomUUID(), remote_number: phone, content, media } },
    });
    const id = randomUUID();
    const timestamp = String(Math.floor(providers.clock.now().getTime() / 1000));
    const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("hex");
    expect(
      (
        await app.request("/", {
          method: "POST",
          body,
          headers: {
            "x-inkbox-request-id": id,
            "x-inkbox-timestamp": timestamp,
            "x-inkbox-signature": `sha256=${signature}`,
          },
        })
      ).status,
    ).toBe(200);
  }

  it.each(["STOP", "cancel", "NO"])("%s releases the held task for another worker", async (text) => {
    const at = somewhere();
    const a = await agent();
    const first = await worker(at);
    const next = await worker(north(at, 100));
    const { task_id } = await ask(a, at);
    await textWebhook(first.phone, "YES");
    expect((await service.getTask(a, { task_id })).status).toBe("claimed");
    const before = outbox.length;
    await textWebhook(first.phone, text);
    expect(await service.getTask(a, { task_id })).toMatchObject({ status: "dispatched", claimed_at: null });
    expect((await sql`select opted_in from workers where id = ${first.worker_id}`)[0]?.opted_in).toBe(
      text === "NO",
    );
    expect(outbox.slice(before)).toContainEqual({
      to: next.phone,
      kind: "offer",
      payload: expect.objectContaining({ task_id }),
    });
    await reply(next.phone);
    expect(outbox.at(-1)).toMatchObject({ to: next.phone, kind: "capture_link", payload: { task_id } });
  });

  it.each(["stop", "no"] as const)(
    "reoffers a released task even when the %s confirmation fails",
    async (intent) => {
      const at = somewhere();
      const a = await agent();
      const first = await worker(at);
      const next = await worker(north(at, 100));
      const { task_id } = await ask(a, at);
      await reply(first.phone);
      const before = outbox.length;
      const send = vi.spyOn(providers.messaging, "sendText").mockRejectedValueOnce(new Error("send failed"));
      try {
        await expect(service.handleWorkerReply({ phone: first.phone, intent, text: intent })).rejects.toThrow(
          "send failed",
        );
        expect(outbox.slice(before)).toContainEqual({
          to: next.phone,
          kind: "offer",
          payload: expect.objectContaining({ task_id }),
        });
        expect((await service.getTask(a, { task_id })).status).toBe("dispatched");
      } finally {
        send.mockRestore();
      }
    },
  );

  it("HELP after STOP gives help without restoring consent or location codes", async () => {
    const w = await worker(somewhere());
    await textWebhook(w.phone, "STOP");
    const before = outbox.length;
    await textWebhook(w.phone, "HELP");
    expect(outbox.slice(before)).toHaveLength(1);
    expect(String(outbox.at(-1)?.payload)).toContain("START");
    expect(String(outbox.at(-1)?.payload)).toContain("HELP");
    expect((await sql`select opted_in, lat from workers where id = ${w.worker_id}`)[0]).toMatchObject({
      opted_in: false,
      lat: null,
    });
    expect(await sql`select 1 from worker_location_tokens where worker_id = ${w.worker_id}`).toEqual([]);
  });

  it("photos by text explain capture submission and preserve the held task", async () => {
    const at = somewhere();
    const a = await agent();
    const w = await worker(at);
    const media = [{ url: "https://inkbox.test/photo.jpg" }];
    await textWebhook(w.phone, "", media);
    expect(String(outbox.at(-1)?.payload)).toContain("no open task");
    const { task_id } = await ask(a, at);
    await reply(w.phone);
    const link = String(outbox.at(-1)?.payload.capture_url);
    for (const content of ["", "\ufffc", "YES"]) {
      await textWebhook(w.phone, content, media);
      expect(String(outbox.at(-1)?.payload)).toContain(link);
      expect(String(outbox.at(-1)?.payload)).toContain("submit");
    }
    expect((await service.getTask(a, { task_id })).status).toBe("claimed");
    expect(await sql`select 1 from submissions where task_id = ${task_id}`).toEqual([]);
    await capture(new URL(link).searchParams.get("t") ?? "", at);
    await textWebhook(w.phone, "\ufffc", media);
    expect(String(outbox.at(-1)?.payload)).toContain("no open task");
  });

  it("concurrent asks give each worker only one open offer", async () => {
    const at = somewhere();
    const w = await worker(at);
    const a = await agent();
    const b = await agent();
    const results = await Promise.allSettled([ask(a, at), ask(b, at)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "no_workers_nearby" },
    });
    const offers = outbox.filter((m) => m.to === w.phone && m.kind === "offer");
    expect(offers).toHaveLength(1);
    await textWebhook(w.phone, "yes please");
    expect(outbox.at(-1)).toMatchObject({
      kind: "capture_link",
      payload: { task_id: offers[0]?.payload.task_id },
    });
  });

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

  it("two signed YES webhooks from distinct workers send one committed-owner capture link", async () => {
    const at = somewhere();
    const racers = [await worker(north(at, 100)), await worker(north(at, 200))];
    const asked = await ask(await agent(), at);
    const signingKey = "test-claim-race-signing-key";
    const sent = outbox.length;
    const deliver = providers.messaging.sendCaptureLink;
    const send = vi.spyOn(providers.messaging, "sendCaptureLink").mockImplementation(async (to, msg) => {
      const target = racers.find((w) => w.phone === to);
      expect(target).toBeDefined();
      expect(msg.task_id).toBe(asked.task_id);
      const [task] = await sql`select status, claimed_by from tasks where id = ${msg.task_id}`;
      expect(task).toMatchObject({ status: "claimed", claimed_by: target?.worker_id });
      return deliver(to, msg);
    });
    let requests: Promise<Response>[] = [];
    try {
      await sql.begin(async (tx) => {
        await tx`select id from tasks where id = ${asked.task_id} for update`;
        requests = racers.map(async ({ phone }) => {
          const app = inkboxRoutes(
            { service: createEyesService(deps), providers, config: deps.config },
            { INKBOX_WEBHOOK_SIGNING_KEY: signingKey },
          );
          const body = JSON.stringify({
            event_type: "text.received",
            data: { text_message: { id: randomUUID(), remote_phone_number: phone, text: "YES" } },
          });
          const id = randomUUID();
          const timestamp = String(Math.floor(providers.clock.now().getTime() / 1000));
          const signature = createHmac("sha256", signingKey)
            .update(`${id}.${timestamp}.${body}`)
            .digest("hex");
          return app.request("/", {
            method: "POST",
            body,
            headers: {
              "content-type": "application/json",
              "x-inkbox-request-id": id,
              "x-inkbox-timestamp": timestamp,
              "x-inkbox-signature": `sha256=${signature}`,
            },
          });
        });
        const deadline = Date.now() + 3_000;
        let waiting = await claimsWaitingOnLock();
        while (waiting < 2 && Date.now() < deadline) {
          await sleep(10);
          waiting = await claimsWaitingOnLock();
        }
        expect(waiting).toBe(2);
        expect(send).not.toHaveBeenCalled();
        expect(
          outbox.slice(sent).filter((m) => m.kind === "capture_link" || m.kind === "already_claimed"),
        ).toEqual([]);
      });
      expect((await Promise.all(requests)).map((response) => response.status)).toEqual([200, 200]);
      expect(send).toHaveBeenCalledTimes(1);
      const links = outbox.slice(sent).filter((m) => m.kind === "capture_link");
      const losers = outbox.slice(sent).filter((m) => m.kind === "already_claimed");
      expect(links).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const link = links[0];
      const winner = racers.find((w) => w.phone === link?.to);
      if (!link || !winner) throw new Error("no winner");
      expect(losers[0]?.to).toBe(racers.find((w) => w.phone !== winner.phone)?.phone);
      const [task] = await sql`select status, claimed_by from tasks where id = ${asked.task_id}`;
      expect(task).toMatchObject({ status: "claimed", claimed_by: winner.worker_id });
      const token = new URL(String(link.payload.capture_url)).searchParams.get("t") ?? "";
      expect(await service.getOffer(token)).toMatchObject({
        task_id: asked.task_id,
        claimed_by_you: true,
      });
    } finally {
      await Promise.allSettled(requests);
      send.mockRestore();
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

    const key = randomUUID();
    const asked = await ask(a, at, { idempotency_key: key });
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
    expect(await ask(a, at, { idempotency_key: key })).toMatchObject({
      task_id: asked.task_id,
      status: "claimed",
      escrowed_usd: 3.5,
      next_step: expect.stringContaining("Call await_answer"),
    });

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
    expect(await ask(a, at, { idempotency_key: key })).toMatchObject({
      task_id: asked.task_id,
      status: "paid",
      escrowed_usd: 0,
      next_step: expect.stringContaining("Call get_task"),
    });

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

  it("email is an extra channel on a phone account: unverified gets no offers, an authenticated email verifies it but only a text turns tasks on, offers reach both channels, YES by email answers by email, STOP drops login codes", async () => {
    const at = somewhere();
    const email = `w${randomInt(1e9)}@workers.test`;
    const phone = newPhone();
    const joined = await service.joinWorker({
      name: "Mail Worker",
      phone,
      email: email.toUpperCase(),
      ...north(at, 100),
    });
    expect(joined.opt_in_instructions).toContain(
      `saying START from ${email} to work@brave-otter.primitive.email`,
    );
    const [row] =
      await sql`select id, email, email_verified_at, opted_in from workers where phone = ${phone}`;
    expect(row).toMatchObject({ email, email_verified_at: null, opted_in: false });

    const other = newPhone();
    await service.joinWorker({ name: "Squatter", phone, email: "x@workers.test", ...at });
    await service.joinWorker({ name: "Second", phone: other, email, ...at });
    expect(await sql`select email from workers where phone in (${phone}, ${other}) order by email`).toEqual([
      { email },
      { email: null },
    ]);

    await service.handleWorkerReply({ email, intent: "start", text: "START" });
    expect(outbox.at(-1)).toMatchObject({
      to: email,
      payload: expect.stringContaining("from your phone first"),
    });
    const [unconfirmed] = await sql`select opted_in, email_verified_at from workers where phone = ${phone}`;
    expect(unconfirmed).toMatchObject({ opted_in: false, email_verified_at: null });
    expect(providers.email.outbox.filter((m) => m.to === email)).toEqual([]);

    await service.handleWorkerReply({
      email: `u${randomInt(1e9)}@workers.test`,
      intent: "start",
      text: "START",
    });
    expect(String(outbox.at(-1)?.payload)).toContain(
      "join with your phone number at https://w.eyes.test first",
    );

    await service.handleWorkerReply({ phone, intent: "start", text: "START" });
    expect(String(outbox.at(-1)?.payload)).toContain(`confirmation link to w…@workers.test. Not yours?`);
    const link = providers.email.outbox.findLast((m) => m.to === email);
    expect(link).toMatchObject({
      reply_to: "work@brave-otter.primitive.email",
      text: expect.stringContaining("https://w.eyes.test/login#c="),
    });
    await service.handleWorkerReply({ email, intent: "help", text: "HELP" });
    const [confirmed] = await sql`select email_verified_at from workers where phone = ${phone}`;
    expect(confirmed?.email_verified_at).not.toBeNull();

    const later = await worker(north(at, 200));
    const laterEmail = `b${randomInt(1e9)}@workers.test`;
    await sql`select eyes_set_worker_email(${later.worker_id}, ${laterEmail})`;
    const asked = await ask(await agent(), at);
    const sent = outbox
      .filter((m) => m.kind === "offer" && m.payload.task_id === asked.task_id)
      .map((m) => m.to);
    expect(sent.sort()).toEqual([phone, email, later.phone].sort());
    expect(asked.workers_notified).toBe(2);

    await service.handleWorkerReply({ email, intent: "yes", text: "yes" });
    expect(outbox.at(-1)).toMatchObject({ to: email, kind: "capture_link" });

    await sql`select eyes_issue_worker_code(${email.toUpperCase()}, ${`h${email}`}, now() + interval '15 minutes')`;
    await service.handleWorkerReply({ email, intent: "stop", text: "STOP" });
    expect(await sql`select 1 from worker_login_codes where email = ${email}`).toHaveLength(0);
    const [stopped] = await sql`select opted_in, lat from workers where phone = ${phone}`;
    expect(stopped).toMatchObject({ opted_in: false, lat: null });
    expect(await sql`select email, email_verified_at from eyes_set_worker_email(${row?.id}, null)`).toEqual([
      { email: null, email_verified_at: null },
    ]);
  });

  it("email on /me: adding needs a phone that texted START; the emailed link signs in once and verifies; sign-in links go only to verified emails; a taken email is 409; null removes it", async () => {
    const eToken = (workerId: string) => signToken("test-link-secret-0123456789", `e:${workerId}`);
    // The one-time code in the last link emailed to this address.
    const linkCode = (to: string) =>
      /\/login#c=(\S+)/.exec(providers.email.outbox.findLast((m) => m.to === to)?.text ?? "")?.[1] ?? "";
    const off = await worker(somewhere(), false);
    await expect(service.workerSetEmail(eToken(off.worker_id), "a@workers.test")).rejects.toMatchObject({
      code: "invalid_input",
      message: "Text START to the Eyes number first.",
    });
    await expect(service.workerSetEmail("bad", null)).rejects.toMatchObject({ code: "unauthorized" });

    const w = await worker(somewhere());
    const email = `m${randomInt(1e9)}@workers.test`;
    expect(await service.workerSetEmail(eToken(w.worker_id), email.toUpperCase())).toMatchObject({
      email_masked: "m…@workers.test",
      email_status: "pending",
    });
    const confirm = linkCode(email);
    const sent = providers.email.outbox.length;
    await service.workerEmailLogin(email);
    await service.workerEmailLogin(`n${randomInt(1e9)}@workers.test`);
    expect(providers.email.outbox).toHaveLength(sent);
    await expect(service.workerEmailLogin("not an email")).rejects.toMatchObject({ code: "invalid_input" });

    const { token } = await service.workerLoginCode(confirm);
    expect(await service.workerSetup(token)).toMatchObject({ email_status: "verified" });
    await expect(service.workerLoginCode(confirm)).rejects.toMatchObject({ code: "unauthorized" });
    await service.workerSetEmail(eToken(w.worker_id), email);
    expect(providers.email.outbox).toHaveLength(sent);

    await service.workerEmailLogin(email.toUpperCase());
    expect(providers.email.outbox.at(-1)).toMatchObject({ to: email, subject: "Your Eyes sign-in link" });
    expect(await service.workerSetup((await service.workerLoginCode(linkCode(email))).token)).toMatchObject({
      opted_in: true,
    });

    const other = await worker(somewhere());
    await expect(service.workerSetEmail(eToken(other.worker_id), email)).rejects.toMatchObject({
      code: "email_taken",
    });
    expect(await service.workerSetEmail(eToken(w.worker_id), null)).toMatchObject({
      email_masked: null,
      email_status: "none",
    });
  });

  it("email by text (T6.51): EMAIL or an address gets a mailto short link and no email; the coded email connects the sender, verified, once; taken, wrong and stale codes change nothing; 5 links an hour; EMAIL OFF removes", async () => {
    const eToken = (workerId: string) => signToken("test-link-secret-0123456789", `e:${workerId}`);
    const lastText = (phone: string) => String(outbox.findLast((m) => m.to === phone)?.payload);
    const text = (phone: string, body: string) =>
      service.handleWorkerReply({ phone, intent: parseReplyIntent(body), text: body });
    const off = await worker(somewhere(), false);
    await text(off.phone, "a@workers.test");
    expect(lastText(off.phone)).toBe("Text START first, then send your email.");
    await expect(service.workerEmailStart(eToken(off.worker_id))).rejects.toMatchObject({
      code: "invalid_input",
      message: "Text START to the Eyes number first.",
    });
    await expect(service.workerEmailStart("bad")).rejects.toMatchObject({ code: "unauthorized" });

    const w = await worker(somewhere());
    const mailtoFor = async (body: string) => {
      await text(w.phone, body);
      const id = /^To get tasks by email, tap this and press Send: \S+\/s\/([0-9A-Za-z]{8})$/.exec(
        lastText(w.phone),
      )?.[1];
      const [row] = await sql`select target from short_links where id = ${id ?? ""}`;
      return String(row?.target);
    };
    const codeOf = (mailto: string) => /subject=Eyes%20([\w-]{43})&/.exec(mailto)?.[1] ?? "";
    const emails = providers.email.outbox.length;
    for (const body of ["EMAIL", " My email is: <mailto:Ana@Workers.test>. ", "e-mail"]) {
      expect(await mailtoFor(body)).toMatch(
        /^mailto:work@\S+\?subject=Eyes%20[\w-]{43}&body=Send%20this%20email%20to%20connect$/,
      );
    }
    expect(providers.email.outbox).toHaveLength(emails);
    await text(w.phone, "a@workers.test b@workers.test");
    expect(lastText(w.phone)).toMatch(/^Didn't catch that\./);

    const email = `c${randomInt(1e9)}@workers.test`;
    const code = codeOf(await mailtoFor("email"));
    expect(await service.workerConnectEmail(email, "x".repeat(43))).toMatch(/^This link has expired/);
    const other = await worker(somewhere());
    await sql`update workers set email = ${email} where id = ${other.worker_id}`;
    expect(await service.workerConnectEmail(email, code)).toMatch(
      /^This email is already on another Eyes account/,
    );
    await sql`update workers set email = null where id = ${other.worker_id}`;
    expect(await service.workerConnectEmail(email.toUpperCase(), code)).toBe(
      "Connected. Eyes will also send you tasks here. Reply STOP to stop.",
    );
    expect(await service.workerConnectEmail(email, code)).toMatch(/^This link has expired/);
    expect(
      await sql`select email, email_verified_at is not null as verified from workers where id = ${w.worker_id}`,
    ).toEqual([{ email, verified: true }]);
    await service.handleWorkerReply({ phone: w.phone, intent: "help", text: "HELP" });
    expect(lastText(w.phone)).not.toContain("Text EMAIL");

    await mailtoFor("EMAIL");
    await text(w.phone, "EMAIL");
    expect(lastText(w.phone)).toBe("Too many email links this hour. Text EMAIL again in an hour.");

    const { mailto } = await service.workerEmailStart(eToken(w.worker_id));
    const start = providers.clock.now();
    try {
      providers.clock.advance(24 * 3_600_000 + 1);
      expect(await service.workerConnectEmail(email, codeOf(mailto))).toMatch(/^This link has expired/);
    } finally {
      providers.clock.set(start);
    }

    await text(w.phone, "Email off");
    expect(lastText(w.phone)).toBe(
      "Email removed. Eyes won't email you tasks. Text EMAIL anytime to add one again.",
    );
    expect(await sql`select email from workers where id = ${w.worker_id}`).toEqual([{ email: null }]);
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
    expect(await service.joinWorker({ name: "Someone Else", phone, ...north(at, 4000) })).toEqual(first);
    // 0,0 is never a location: the join is refused before anything is written.
    await expect(
      service.joinWorker({ name: "Someone Else", phone: newPhone(), lat: 0, lng: 0 }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    // STOP deleted the location (ADR-037); the repeat join did not write its own.
    expect(await sql`select name, lat from workers where phone = ${phone}`).toEqual([
      { name: "Real Worker", lat: null },
    ]);
  });

  it("STOP silences task replies until START, which confirms the worker is back in", async () => {
    const { phone } = await worker(somewhere());
    const sent = () => outbox.filter((m) => m.to === phone).map((m) => m.payload);
    const before = sent().length;
    await service.handleWorkerReply({ phone, intent: "stop", text: "STOP" });
    for (const intent of ["stop", "yes", "no", "unknown"] as const) {
      await service.handleWorkerReply({ phone, intent, text: intent });
    }
    const after = sent().slice(before);
    expect(after).toEqual(["Eyes: you're opted out and won't get task texts. Text START to rejoin."]);
    expect(String(after[0]).length).toBeLessThanOrEqual(159);
    await service.handleWorkerReply({ phone, intent: "start", text: "START" });
    // One text: STOP reset the app link (it deleted every code) and cleared the spot.
    const start = sent().slice(before + 1);
    expect(start).toHaveLength(1);
    const lines = hubLines(start[0]);
    expect(lines).toEqual([
      "You're in. Eyes texts you paid photo tasks near you.",
      expect.stringMatching(
        /^1\. Get the app \(keeps your spot fresh\): https:\/\/w\.eyes\.test\/install#c=[\w-]{43}$/,
      ),
      expect.stringMatching(/^2\. Set up payouts: \S+\/w\/connect\/\S+$/),
      expect.stringMatching(/^Your setup: https:\/\/w\.eyes\.test\/me#c=[\w-]+\.[\w-]+$/),
    ]);
    const code = /#c=([\w-]{43})$/.exec(lines[1] ?? "")?.[1] ?? "";
    expect(await service.workerDevice(code)).toMatchObject({ registered: false });
    // START again within the hour mints no second code: the app step links to the setup page.
    await service.handleWorkerReply({ phone, intent: "start", text: "START" });
    expect(hubLines(sent().at(-1))).toEqual([
      lines[0],
      expect.stringMatching(/^1\. Get the app \(keeps your spot fresh\): https:\/\/w\.eyes\.test\/me#c=\S+$/),
      expect.stringMatching(/^2\. Set up payouts: /),
      expect.stringMatching(/^Your setup: /),
    ]);
  });

  it("HELP is the shared hub text: open steps, setup page and the complete command menu", async () => {
    const { phone } = await worker(somewhere());
    await service.handleWorkerReply({ phone, intent: "help", text: "HELP" });
    const help = hubLines(outbox.findLast((m) => m.to === phone)?.payload);
    // START sent the app link within the hour: the app step links to the setup page, no second code.
    expect(help).toEqual([
      "You're in. Eyes texts you paid photo tasks near you.",
      expect.stringMatching(/^1\. Get the app \(keeps your spot fresh\): https:\/\/w\.eyes\.test\/me#c=\S+$/),
      expect.stringMatching(/^2\. Set up payouts: \S+\/w\/connect\/\S+$/),
      expect.stringMatching(/^Your setup: https:\/\/w\.eyes\.test\/me#c=[\w-]+\.[\w-]+$/),
    ]);
    expect(await service.workerSetup(meToken(help[3]))).toMatchObject({ opted_in: true });
  });

  it("workerSetTexts runs STOP and START for the /me code and shows texts_on", async () => {
    const w = await worker(somewhere());
    const eToken = (workerId: string) => signToken("test-link-secret-0123456789", `e:${workerId}`);
    const token = eToken(w.worker_id);
    expect(await service.workerSetup(token)).toMatchObject({ opted_in: true, texts_on: true });
    expect(await service.workerSetTexts(token, false)).toMatchObject({ opted_in: false, texts_on: false });
    expect(String(outbox.findLast((m) => m.to === w.phone)?.payload)).toContain("you're opted out");
    expect(await service.workerSetTexts(token, true)).toMatchObject({ opted_in: true, texts_on: true });
    await expect(service.workerSetTexts("bad", false)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("START and HELP send a readable canonical menu in one body through the live phone/email wrappers; aliases still work", async () => {
    const w = await worker(somewhere(), false);
    const email = `menu-${randomUUID()}@workers.test`;
    const rpc = createRpc(deps.db);
    const wrapped = createEyesService({
      ...deps,
      providers: {
        ...providers,
        messaging: withShortLinks(
          withWorkerEmail(providers.messaging, providers.email, deps.config.email_domain),
          rpc,
          deps.config,
          () => providers.clock.now(),
        ),
      },
    });
    const before = outbox.length;
    await wrapped.handleWorkerReply({ phone: w.phone, intent: parseReplyIntent("START"), text: "START" });
    const sent = outbox.slice(before);
    expect(sent).toHaveLength(1);
    const text = String(sent[0]?.payload);
    hubLines(text);
    const links = text.match(/https:\/\/api\.eyes\.test\/s\/[0-9A-Za-z]{8}/g) ?? [];
    expect(links).toHaveLength(1);
    const targets = await Promise.all(
      links.map(async (link) => {
        const [row] = await rpc<{ target: string }>("eyes_short_link", {
          p_id: link.split("/").at(-1) ?? "",
          p_now: providers.clock.now().toISOString(),
        });
        return row?.target;
      }),
    );
    expect(targets).toEqual([expect.stringMatching(/^https:\/\/api\.eyes\.test\/w\/connect\/\S+$/)]);
    const installCode = /\/install#c=([\w-]{43})/.exec(text)?.[1] ?? "";
    expect(await wrapped.workerDevice(installCode)).toMatchObject({ registered: false });
    expect(await wrapped.workerSetup(meToken(text))).toMatchObject({ opted_in: true });
    expect(
      await sql`select target from short_links where worker_id = ${w.worker_id} and target like '%#c=%'`,
    ).toEqual([]);

    // Already-opted-in email replies use the same hub; no second phone message.
    await sql`update workers set email = ${email}, email_verified_at = now() where id = ${w.worker_id}`;
    await wrapped.handleWorkerReply({ email, intent: parseReplyIntent("START"), text: "START" });
    const emailed = providers.email.outbox.findLast((m) => m.to === email);
    hubLines(emailed?.text);
    expect(outbox.slice(before)).toHaveLength(1);
    for (const intent of ["start", "help"] as const) {
      const count = outbox.length;
      await wrapped.handleWorkerReply({ phone: w.phone, intent, text: intent.toUpperCase() });
      expect(outbox.slice(count)).toHaveLength(1);
      hubLines(outbox.at(-1)?.payload);
    }

    // These engine-only commands bypass the parser but must actually reach emailByText.
    for (const command of ["EMAIL", "E-MAIL"]) {
      await wrapped.handleWorkerReply({ phone: w.phone, intent: parseReplyIntent(command), text: command });
      expect(String(outbox.at(-1)?.payload)).toMatch(/^To get tasks by email, tap this and press Send: /);
    }
    for (const command of ["EMAIL OFF", "E-MAIL OFF"]) {
      await sql`update workers set email = ${email} where id = ${w.worker_id}`;
      await wrapped.handleWorkerReply({ phone: w.phone, intent: parseReplyIntent(command), text: command });
      expect(String(outbox.at(-1)?.payload)).toMatch(/^Email removed\./);
      expect(await sql`select email from workers where id = ${w.worker_id}`).toEqual([{ email: null }]);
    }
    expect(text).not.toContain("EMAILOFF");
  });

  describe("worker setup page (ADR-028)", () => {
    const setupToken = (phone: string) =>
      meToken(
        outbox.findLast((m) => m.to === phone && /^You're (in|all set)\./.test(String(m.payload)))?.payload,
      );
    const fixToken = (workerId: string) =>
      signToken(deps.config.link_secret, `l:${workerId}`, new Date(providers.clock.now().getTime() + 60_000));
    const refused = {
      code: "unauthorized",
      message: "This link is invalid or has expired.",
      fix: "Text HELP to the Eyes number for a fresh link.",
    };

    it("shows the spot's age, whether the app sends it, payout setup, and every task with its payout", async () => {
      const at = somewhere();
      const agents = [await agent(), await agent()];
      const w = await worker(north(at, 50));
      const token = setupToken(w.phone);
      const [joined] = await sql<
        { created_at: Date }[]
      >`select created_at from workers where id = ${w.worker_id}`;
      expect(WorkerSetup.parse(await service.workerSetup(token))).toEqual({
        opted_in: true,
        texts_on: true,
        spot: { at: joined?.created_at.toISOString(), fresh: true, max_age_h: 24 },
        app: { connected: false, last_at: null, sending: false },
        payouts: {
          set_up: false,
          live: true,
          setup_url: expect.stringMatching(/^https:\/\/api\.eyes\.test\/w\/connect\/[\w-]+\.[\w-]+$/),
        },
        here_url: expect.stringMatching(/^https:\/\/w\.eyes\.test\/here\.html\?t=[\w-]+\.[\w-]+$/),
        email_masked: null,
        email_status: "none",
        email_skipped: false,
      });

      // Six claims from two agents (each stays within its $20 grant); the list has all of them, newest first.
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
        questions.map((question) => ({
          task_id: expect.any(String),
          question,
          place_label: expect.any(String),
          status: "verified",
          bounty_usd: 3,
          payout,
          claimed_at: expect.any(String),
          dispute: null,
        }));
      const list = async () => WorkerTasks.parse(await service.workerTasks(token, {}));
      expect(await list()).toEqual({
        paid_usd: 0,
        pending_usd: 18,
        tasks: rows("waiting_for_payout_setup"),
        next_cursor: null,
      });
      await service.workerConnectUrl(connectToken(w.phone));
      expect(await service.workerSetup(token)).toMatchObject({
        payouts: { set_up: true, live: true, setup_url: expect.stringContaining("/w/connect/") },
      });
      expect((await list()).tasks).toEqual(rows("pending"));

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

    it("START and HELP list only open steps: numbered for 2+, unnumbered for 1, 'You're all set' for none", async () => {
      const at = somewhere();
      const w = await worker(at); // its START sent the app link, so the next hour has no app step
      const hub = async (intent: "start" | "help") => {
        await service.handleWorkerReply({ phone: w.phone, intent, text: intent.toUpperCase() });
        return hubLines(outbox.findLast((m) => m.to === w.phone)?.payload);
      };
      const head = "Eyes texts you paid photo tasks near you.";
      const tail = [expect.stringMatching(/^Your setup: https:\/\/w\.eyes\.test\/me#c=\S+$/)];
      const hour = 3_600_000;
      const start = providers.clock.now();
      try {
        providers.clock.advance(hour + 1);
        expect(await hub("start")).toEqual([
          `You're in. ${head}`,
          expect.stringMatching(/^1\. Get the app \(keeps your spot fresh\): \S+$/),
          expect.stringMatching(/^2\. Set up payouts: \S+$/),
          ...tail,
        ]);

        // The app sent a fix: no app step even past the hour, so payouts is the one step, unnumbered.
        providers.clock.advance(31_000);
        await service.updateWorkerLocation(fixToken(w.worker_id), { ...north(at, 10), source: "app" });
        providers.clock.advance(hour + 1);
        for (const intent of ["start", "help"] as const) {
          expect(await hub(intent)).toEqual([
            `You're in. ${head}`,
            expect.stringMatching(/^Set up payouts: \S+\/w\/connect\/\S+$/),
            ...tail,
          ]);
        }

        await service.workerConnectUrl(connectToken(w.phone));
        for (const intent of ["start", "help"] as const) {
          expect(await hub(intent)).toEqual([`You're all set. ${head}`, ...tail]);
        }

        // An old fix makes the spot stale, not the installed app.
        providers.clock.advance(24 * hour);
        expect(await hub("help")).toEqual([`You're all set. ${head}`, ...tail]);
      } finally {
        providers.clock.set(start);
      }
    });

    it("pages every task 20 at a time and searches only what a row shows, dates in the browser's zone", async () => {
      const a = await agent();
      const w = await worker(somewhere());
      const token = setupToken(w.phone);
      // 25 claims, one a day back from 2026-03-10 05:30 UTC (the evening before in Los Angeles).
      const status = (i: number) =>
        (["verified", "needs_review", "expired", "disputed", "refunded"] as const)[i % 5] ?? "verified";
      for (let i = 0; i < 25; i++) {
        const at = new Date(Date.UTC(2026, 2, 10 - i, 5, 30));
        await sql`insert into tasks (agent_id, question, task_type, place_label, lat, lng, bounty_cents, fee_cents,
          deadline_at, status, claimed_by, claimed_at)
          values (${a.id}, ${`Question ${i}`}, 'is_open', ${i === 7 ? "Ferry Building" : "Pier 39"}, 1, 1,
          ${100 + i}, 0, ${at}, ${status(i)}, ${w.worker_id}, ${at})`;
      }
      const ids = (r: { tasks: { question: string }[] }) => r.tasks.map((t) => t.question);
      const first = await service.workerTasks(token, {});
      expect(ids(first)).toEqual(Array.from({ length: 20 }, (_, i) => `Question ${i}`));
      expect(first.next_cursor).toMatch(/\|[0-9a-f-]{36}$/);
      const second = await service.workerTasks(token, { cursor: first.next_cursor ?? "" });
      expect([ids(second), second.next_cursor]).toEqual([
        ["Question 20", "Question 21", "Question 22", "Question 23", "Question 24"],
        null,
      ]);
      // A malformed cursor starts from the top instead of failing.
      expect(ids(await service.workerTasks(token, { cursor: "x|y" }))).toEqual(ids(first));

      const search = async (q: string, tz?: string) => ids(await service.workerTasks(token, { q, tz }));
      expect(await search("ferry")).toEqual(["Question 7"]);
      expect(await search("$1.07")).toEqual(["Question 7"]);
      expect(await search("question 1")).toHaveLength(11);
      expect(await search("Mar 10, 2026")).toEqual(["Question 0"]);
      expect(await search("Mar 9, 2026", "America/Los_Angeles")).toEqual(["Question 0"]);
      expect(await search("Mar 10, 2026", "Not/AZone")).toEqual(["Question 0"]);
      // Nothing a row does not show: not the cents, the task id or a UTC timestamp.
      expect(await search("107")).toEqual([]);
      expect(await search(first.tasks[0]?.task_id.slice(0, 8) ?? "")).toEqual([]);
      expect(await search("05:30")).toEqual([]);

      const filter = async (s: "paid" | "pending" | "review" | "expired") =>
        ids(await service.workerTasks(token, { status: s }));
      expect(await filter("review")).toEqual(
        ["Question 1", "Question 3", "Question 6", "Question 8"].concat([
          "Question 11",
          "Question 13",
          "Question 16",
          "Question 18",
          "Question 21",
          "Question 23",
        ]),
      );
      expect(await filter("expired")).toHaveLength(10);
      expect(await filter("paid")).toEqual([]);
      expect(await filter("pending")).toEqual([]);
      const [verified] = await sql<{ id: string }[]>`select id from tasks where claimed_by = ${w.worker_id}
        and question = 'Question 5'`;
      await sql`insert into ledger (type, amount_cents, task_id, worker_id) values ('release', 105, ${verified?.id ?? ""}, ${w.worker_id})`;
      expect(await filter("pending")).toEqual(["Question 5"]);
      expect(ids(await service.workerTasks(token, { status: "pending", q: "pier" }))).toEqual(["Question 5"]);
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

  it("INSTALL and APP text one app link with a fresh code each: /install without TestFlight", async () => {
    const { phone } = await worker(somewhere());
    await service.handleWorkerReply({ phone, intent: "install", text: "INSTALL" });
    const install = String(outbox.findLast((m) => m.to === phone)?.payload);
    expect(install).toMatch(/^Get the Eyes app: https:\/\/w\.eyes\.test\/install#c=[\w-]{43}$/);
    const code = install.slice(-43);
    expect(await service.workerDevice(code)).toMatchObject({ registered: false, ready: false });
    await service.handleWorkerReply({ phone, intent: "app", text: "APP" });
    const app = String(outbox.findLast((m) => m.to === phone)?.payload);
    expect(app).toMatch(/^Get the Eyes app: https:\/\/w\.eyes\.test\/install#c=[\w-]{43}$/);
    expect(app.slice(-43)).not.toBe(code);
  });

  it("START and APP link /app (which falls back to TestFlight) when EYES_TESTFLIGHT_URL is set", async () => {
    const link = "https://testflight.apple.com/join/TESTLINK1";
    const withLink = createEyesService({
      ...deps,
      config: AppConfig.parse({ ...deps.config, testflight_url: link }),
    });
    const { phone } = await worker(somewhere());
    const last = () => String(outbox.findLast((m) => m.to === phone)?.payload);
    await withLink.handleWorkerReply({ phone, intent: "app", text: "APP" });
    expect(last()).toMatch(/^Get the Eyes app: https:\/\/w\.eyes\.test\/app#c=[\w-]{43}$/);
    await withLink.handleWorkerReply({ phone, intent: "stop", text: "STOP" });
    await withLink.handleWorkerReply({ phone, intent: "start", text: "START" });
    expect(last().split("\n")[1]).toMatch(
      /^1\. Get the app \(keeps your spot fresh\): https:\/\/w\.eyes\.test\/app#c=[\w-]{43}$/,
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
    const [a, b] = [await agent(), await agent()];
    const mine: string[] = [];
    for (const question of ["Is it open right now?", "Is the line long?", "Is it busy right now?"]) {
      await worker(north(at, 100));
      mine.unshift((await ask(a, at, { question })).task_id);
      providers.clock.advance(1000);
    }
    await worker(north(at, 100));
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

  it("pages beyond 50 tasks without losing timestamp ties", async () => {
    const signup = await service.signupAgent({ name: "paging-test" });
    const a = (await service.authenticate(signup.api_key)) as Agent;
    await sql`insert into tasks
      (agent_id, question, task_type, place_label, lat, lng, bounty_cents, fee_cents, deadline_at, created_at)
      select ${a.id}, 'Is it open?', 'is_open', 'Pier', 1, 1, 300, 0,
        '2026-10-20T12:00:00Z', '2026-10-20T11:00:00.123456Z'
      from generate_series(1, 55)`;
    const expected =
      await sql`select id from tasks where agent_id = ${a.id} order by created_at desc, id desc`;
    const first = await service.listTasks(a, { limit: 50 });
    expect(first.tasks.map((task) => task.task_id)).toEqual(expected.slice(0, 50).map((row) => row.id));
    expect(first.next_cursor).toBe(first.tasks[49]?.task_id);
    expect(first.next_step).toContain("list_tasks");
    expect(first.next_step).not.toContain("ask_eyes");
    const before = String(first.next_cursor);
    const last = await service.listTasks(a, { limit: 5, before });
    expect(last.tasks.map((task) => task.task_id)).toEqual(expected.slice(50).map((row) => row.id));
    expect(last.next_cursor).toBeNull();
    const empty = await service.listTasks(a, { limit: 50, before: last.tasks[4]?.task_id });
    expect(empty.tasks).toEqual([]);
    expect(empty.next_cursor).toBeNull();
    expect(empty.next_step).toContain("list_tasks");
    expect(empty.next_step).not.toContain("ask_eyes");
    expect(await service.listTasks(await agent(), { limit: 50 })).toMatchObject({
      tasks: [],
      next_cursor: null,
    });
    expect(await service.listTasks(await agent(), { limit: 50, before })).toMatchObject({
      tasks: [],
      next_cursor: null,
    });
    expect(await service.listTasks(a, { limit: 50, status: "paid" })).toMatchObject({
      tasks: [],
      next_cursor: null,
    });
    const server = createServer({ service, providers, config: deps.config, env: {} });
    const fetch: typeof globalThis.fetch = (url, init) => server.fetch(new Request(url, init));
    const headers = { authorization: `Bearer ${signup.api_key}` };
    const response = await fetch(`http://eyes.test/v1/tasks?limit=50&before=${first.next_cursor}`, {
      headers,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(last);
    const client = new Client({ name: "paging-test", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://eyes.test/mcp"), {
          fetch,
          requestInit: { headers },
        }),
      );
      const result = await client.callTool({
        name: "list_tasks",
        arguments: { limit: 50, before: first.next_cursor },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "null")).toEqual(last);
    } finally {
      await client.close();
    }
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
      [
        "caps the suggestion at the daily cap left minus the fee",
        { max_bounty_usd: 2.5, daily_cap_usd: 3 },
        null,
        fits(2.5),
      ],
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
        { max_bounty_usd: 0.5, daily_cap_usd: 1 },
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

  it.each([
    { policy: { max_bounty_usd: 1 }, code: "bounty_exceeds_max" },
    {
      policy: { allowed_task_types: ["is_open"] as OwnerPolicyInput["allowed_task_types"] },
      code: "task_type_not_allowed",
    },
    { policy: { max_bounty_usd: 3, daily_cap_usd: 5 }, code: "daily_cap_exceeded" },
  ])("replays a paid ask after the owner tightens $code without another charge", async ({ policy, code }) => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const { api_key } = await service.signupAgent({ name: "retry-agent" });
    const a = (await service.authenticate(api_key)) as Agent;
    const key = randomUUID();
    const first = await ask(a, at, { idempotency_key: key });
    await service.updateSpendPolicy(signToken(deps.config.link_secret, `p:${a.id}`), {
      max_bounty_usd: 10,
      daily_cap_usd: 50,
      allowed_task_types: ["line_length"],
      ...policy,
    });
    const current = (await service.authenticate(api_key)) as Agent;

    expect(await ask(current, at, { idempotency_key: key })).toEqual(first);
    await expect(ask(current, at)).rejects.toMatchObject({ code });
    expect(await sql`select id from tasks where agent_id = ${a.id}`).toEqual([{ id: first.task_id }]);
    expect(await ledger(first.task_id)).toEqual([expect.objectContaining({ type: "escrow", amount: 350 })]);
    expect(await service.getBalance(current)).toMatchObject({ balance_usd: 16.5, escrowed_usd: 3.5 });
    expect(outbox.filter((m) => m.to === w.phone && m.kind === "offer")).toHaveLength(1);
    await expect(
      ask(current, at, { idempotency_key: key, question: "Is it open right now?" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("replays a paid ask without a new safety decision", async () => {
    const at = somewhere();
    await worker(north(at, 100));
    const a = await agent();
    const key = randomUUID();
    const first = await ask(a, at, { idempotency_key: key });
    const assess = vi.spyOn(deps, "assessTask").mockResolvedValue({
      allowed: false,
      category: "private_residence",
      reason: "Policy changed",
      fix: null,
      layer: "rules",
    });
    try {
      expect(await ask(a, at, { idempotency_key: key })).toEqual(first);
      await expect(ask(a, at)).rejects.toMatchObject({ code: "unsafe_task" });
      expect(await sql`select id from tasks where agent_id = ${a.id}`).toEqual([{ id: first.task_id }]);
      expect(await service.getBalance(a)).toMatchObject({ balance_usd: 16.5, escrowed_usd: 3.5 });
    } finally {
      assess.mockRestore();
    }
  });

  it("replays a cancelled ask with its refunded status and no money held", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const a = await agent();
    const key = randomUUID();
    const first = await ask(a, at, { idempotency_key: key });
    await service.cancelTask(a, { task_id: first.task_id });

    const retry = TOOLS.ask_eyes.output.parse(await ask(a, at, { idempotency_key: key }));
    expect(retry).toMatchObject({
      task_id: first.task_id,
      status: "refunded",
      escrowed_usd: 0,
      deadline_at: first.deadline_at,
    });
    expect(await sql`select id from tasks where agent_id = ${a.id}`).toEqual([{ id: first.task_id }]);
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 20, escrowed_usd: 0 });
    expect(await ledger(first.task_id)).toEqual([
      expect.objectContaining({ type: "escrow", amount: 350 }),
      expect.objectContaining({ type: "refund", amount: 350 }),
    ]);
    expect(outbox.filter((m) => m.to === w.phone && m.kind === "offer")).toHaveLength(1);
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

  it("returns the resolved place over REST and MCP, including retries", async () => {
    const at = somewhere();
    await worker(at);
    const place = { ...at, label: "Public Cafe, Paris, France" };
    const scoped = { ...providers, geo: { geocode: async () => place } };
    const svc = createEyesService({ ...deps, providers: scoped });
    const signup = await svc.signupAgent({ name: "resolved-place" });
    const server = createServer({ service: svc, providers: scoped, config: deps.config, env: {} });
    const fetch = (url: string | URL, init?: RequestInit) => server.fetch(new Request(url, init));
    const headers = { authorization: `Bearer ${signup.api_key}` };
    const input = {
      question: "Is the cafe open?",
      location: "Public Cafe, London, UK",
      task_type: "is_open",
      idempotency_key: randomUUID(),
    };
    const response = await fetch("http://eyes.test/v1/tasks", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    const posted = await response.json();
    expect(posted.resolved_location).toEqual(place);
    const client = new Client({ name: "resolved-place", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://eyes.test/mcp"), {
          fetch,
          requestInit: { headers },
        }),
      );
      const result = await client.callTool({ name: "ask_eyes", arguments: input });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        task_id: posted.task_id,
        resolved_location: place,
      });
    } finally {
      await client.close();
    }
  });

  it.each([
    { lat: 91, lng: 0 },
    { lat: 0, lng: -181 },
    { lat: Number.NaN, lng: 2 },
  ])("reports invalid geocoder coordinates as location_not_found: %j", async (point) => {
    const svc = createEyesService({
      ...deps,
      providers: { ...providers, geo: { geocode: async () => ({ ...point, label: "Public Cafe" }) } },
    });
    await expect(
      svc.quoteTask(await agent(), { location: "Public Cafe", task_type: "is_open" }),
    ).rejects.toMatchObject({ code: "location_not_found" });
  });

  it("rejects bad characters and coordinates over REST and MCP before charging", async () => {
    const signup = await service.signupAgent({ name: "invalid-input" });
    const a = (await service.authenticate(signup.api_key)) as Agent;
    const server = createServer({ service, providers, config: deps.config, env: {} });
    const fetch = (url: string | URL, init?: RequestInit) => server.fetch(new Request(url, init));
    const headers = { authorization: `Bearer ${signup.api_key}` };
    const client = new Client({ name: "invalid-input", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://eyes.test/mcp"), {
          fetch,
          requestInit: { headers },
        }),
      );
      for (const patch of [
        ...["\u0000", "\ud800", "\udfff"].flatMap((bad) =>
          ["question", "location", "idempotency_key"].map((field) => ({ [field]: `Cafe ${bad}` })),
        ),
        { location: { lat: 91, lng: 0 } },
        { location: { lat: 0, lng: -181 } },
        { location: "95,200" },
        { location: "-91, 0" },
        { location: "0, -181" },
      ]) {
        const input = {
          question: "Is the cafe open?",
          location: somewhere(),
          task_type: "is_open",
          idempotency_key: randomUUID(),
          ...patch,
        };
        const response = await fetch("http://eyes.test/v1/tasks", {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        });
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toBe("invalid_input");
        expect(body.issues[0].path).toContain(Object.keys(patch)[0]);
        const result = await client.callTool({ name: "ask_eyes", arguments: input });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(Object.keys(patch)[0]);
      }
      expect(await service.getBalance(a)).toMatchObject({ balance_usd: 20, escrowed_usd: 0 });
      expect(await sql`select id from tasks where agent_id = ${a.id}`).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("returns a retryable safety outage over REST and MCP without charging", async () => {
    const signup = await service.signupAgent({ name: "outage-test" });
    const a = (await service.authenticate(signup.api_key)) as Agent;
    const server = createServer({ service, providers, config: deps.config, env: {} });
    const fetch = (url: string | URL, init?: RequestInit) => server.fetch(new Request(url, init));
    const client = new Client({ name: "outage-test", version: "1" });
    const input = {
      question: "Is the cafe open?",
      location: somewhere(),
      task_type: "is_open",
      idempotency_key: randomUUID(),
    };
    safety = UNAVAILABLE;
    try {
      const headers = { authorization: `Bearer ${signup.api_key}` };
      await expect(
        service.quoteTask(a, { location: input.location, task_type: "is_open" }),
      ).rejects.toMatchObject({ code: "service_unavailable" });
      const response = await fetch("http://eyes.test/v1/tasks", {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toMatchObject({ error: "service_unavailable", fix: expect.stringContaining("Retry") });
      expect(body.fix).not.toContain("Rephrase");
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://eyes.test/mcp"), {
          fetch,
          requestInit: { headers },
        }),
      );
      const result = await client.callTool({ name: "ask_eyes", arguments: input });
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "null")).toEqual(body);
      expect(await service.getBalance(a)).toMatchObject({ balance_usd: 20, escrowed_usd: 0 });
      expect(await sql`select id from tasks where agent_id = ${a.id}`).toHaveLength(0);
      await expect(ask(a, somewhere(), { location: "Nowhere Street 1, Atlantis" })).rejects.toMatchObject({
        code: "location_not_found",
      });
    } finally {
      safety = ALLOW;
      await client.close();
    }
  });

  it("refuses an unsafe task at a place it cannot resolve as unsafe_task, checking the place text as given", async () => {
    const a = await agent();
    const nowhere = "123 Oak St, Nowhere";
    safety = {
      allowed: false,
      category: "private_residence",
      reason: "Targets a private home.",
      fix: "Ask about a public place instead.",
      layer: "rules",
    };
    try {
      const question = "Photograph the house at 123 Oak St";
      await expect(ask(a, somewhere(), { question, location: nowhere })).rejects.toMatchObject({
        code: "unsafe_task",
        fix: "Ask about a public place instead.",
        context: { category: "private_residence" },
      });
      await expect(
        ask(a, somewhere(), { question, location: "ferry building, san francisco" }),
      ).rejects.toMatchObject({ code: "unsafe_task" });
      safety = ALLOW;
      await expect(ask(a, somewhere(), { location: nowhere })).rejects.toMatchObject({
        code: "location_not_found",
      });
    } finally {
      safety = ALLOW;
    }
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 20, escrowed_usd: 0 });
    expect(await sql`select id from tasks where agent_id = ${a.id}`).toHaveLength(0);
  });

  it.each([
    ["Main Street Apt 12, 100 Main Street, Boise, Idaho", "Main Street", false],
    ["my ex-girlfriend's house, 1000 W Hays St, Boise, ID", "West Hays Street", false],
    ["Main Street", "Main Street Apt 12", false],
    ["Ferry Building, San Francisco", "Ferry Building", true],
  ])("gives the same place decision for quote and ask: %s -> %s", async (location, label, allowed) => {
    const a = await agent();
    const at = somewhere();
    await worker(at);
    const geocode = vi.spyOn(providers.geo, "geocode").mockResolvedValue({ ...at, label });
    const check = vi.spyOn(deps, "assessTask").mockImplementation(async (input) => checkRules(input));
    try {
      const quote = await service.quoteTask(a, { location, task_type: "line_length" });
      expect(quote.allowed).toBe(allowed);
      if (allowed) {
        await expect(ask(a, at, { location })).resolves.toMatchObject({ status: "dispatched" });
      } else {
        await expect(ask(a, at, { location })).rejects.toMatchObject({
          code: "unsafe_task",
          context: { category: "private_residence", layer: "rules" },
        });
        expect(await service.getBalance(a)).toMatchObject({ balance_usd: 20, escrowed_usd: 0 });
        expect(await sql`select id from tasks where agent_id = ${a.id}`).toHaveLength(0);
      }
    } finally {
      geocode.mockRestore();
      check.mockRestore();
    }
  });

  it.each(["other", null] as const)(
    "keeps location_not_found when an unresolved place gets an inconclusive safety category: %s",
    async (category) => {
      const a = await agent();
      const location = "Nowhere Street 1, Atlantis";
      safety = {
        allowed: false,
        category,
        reason: "The safety review is temporarily unavailable.",
        fix: "Rephrase the task.",
        layer: "classifier",
      };
      try {
        const expected = { code: "location_not_found", fix: ERRORS.location_not_found.fix };
        await expect(ask(a, somewhere(), { location })).rejects.toMatchObject(expected);
        expect(await service.getBalance(a)).toMatchObject({ balance_usd: 20, escrowed_usd: 0 });
        expect(await sql`select id from tasks where agent_id = ${a.id}`).toHaveLength(0);
      } finally {
        safety = ALLOW;
      }
    },
  );

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

  describe("open-ended spend limits (ADR-050)", () => {
    const types: OwnerPolicyInput["allowed_task_types"] = ["line_length"];
    const setPolicy = (a: Agent, policy: Partial<OwnerPolicyInput>) =>
      service.updateSpendPolicy(signToken(deps.config.link_secret, `p:${a.id}`), {
        max_bounty_usd: 10,
        daily_cap_usd: 20,
        allowed_task_types: types,
        ...policy,
      });

    it("reads an old policy unchanged: day window, ask at the limit", async () => {
      const a = await agent();
      expect(await service.getSpendPolicy(a)).toMatchObject({
        max_bounty_usd: 10,
        daily_cap_usd: 20,
        cap_period: "day",
        at_limit: "ask",
        remaining_today_usd: 20,
      });
      // An update without the new fields keeps the stored period and at_limit.
      await setPolicy(a, { cap_period: "month", at_limit: "pause" });
      await setPolicy(a, { daily_cap_usd: 30 });
      expect(await service.getSpendPolicy(a)).toMatchObject({ cap_period: "month", at_limit: "pause" });
    });

    it("treats a null cap and a null max bounty as no limit", async () => {
      const at = somewhere();
      await worker(north(at, 100));
      const a = await agent();
      await sql`update agents set daily_cap_cents = 100 where id = ${a.id}`;
      await setPolicy(a, { max_bounty_usd: null, daily_cap_usd: null });
      expect(await service.getSpendPolicy(a)).toMatchObject({
        max_bounty_usd: null,
        daily_cap_usd: null,
        remaining_today_usd: null,
      });
      await expect(ask(a, at, { bounty_usd: 3 })).resolves.toMatchObject({ status: "dispatched" });
      expect(await service.quoteTask(a, { location: at, task_type: "line_length" })).toMatchObject({
        allowed: expect.any(Boolean),
      });
    });

    it("counts the cap per week (Monday UTC) and frees it when the next week starts", async () => {
      const at = somewhere();
      await worker(north(at, 100));
      const a = await agent();
      await setPolicy(a, { max_bounty_usd: 3, daily_cap_usd: 5, cap_period: "week" });
      await ask(a, at);
      const start = providers.clock.now(); // a Saturday
      try {
        providers.clock.advance(24 * 3_600_000); // Sunday: same week, spend still counts
        expect(await service.getSpendPolicy(a)).toMatchObject({
          spent_today_usd: 3.5,
          remaining_today_usd: 1.5,
        });
        await expect(ask(a, at)).rejects.toMatchObject({
          code: "daily_cap_exceeded",
          context: { cap_period: "week" },
        });
        providers.clock.advance(24 * 3_600_000); // Monday: new week
        expect(await service.getSpendPolicy(a)).toMatchObject({ spent_today_usd: 0, remaining_today_usd: 5 });
      } finally {
        providers.clock.set(start);
      }
    });

    it("tells the agent to stop at a paused limit, and to ask the user otherwise", async () => {
      const at = somewhere();
      await worker(north(at, 100));
      const a = await agent();
      await setPolicy(a, { max_bounty_usd: 3, daily_cap_usd: 4.9, at_limit: "pause" });
      await ask(a, at);
      const paused = await ask(a, at).catch((err: EyesError) => err);
      expect(paused).toMatchObject({ code: "daily_cap_exceeded", context: { at_limit: "pause" } });
      expect((paused as EyesError).fix).toMatch(/paused spending.*Do not retry/);
      const quote = await service.quoteTask(a, { location: at, task_type: "line_length" });
      expect(quote.reason_if_not).toContain("paused");

      await setPolicy(a, { max_bounty_usd: 3, daily_cap_usd: 4.9, at_limit: "ask" });
      const asked = await ask(a, at).catch((err: EyesError) => err);
      expect((asked as EyesError).fix).toContain("ask your user to raise");
    });

    it("rejects a cap below one request and a fractional cent, saving nothing", async () => {
      const a = await agent();
      await expect(
        setPolicy(a, { max_bounty_usd: 10, daily_cap_usd: 5, cap_period: "week" }),
      ).rejects.toMatchObject({
        code: "invalid_input",
        message: "The weekly total is less than one request.",
      });
      await expect(setPolicy(a, { daily_cap_usd: 20.005 })).rejects.toMatchObject({ code: "invalid_input" });
      expect(await service.getSpendPolicy(a)).toMatchObject({ max_bounty_usd: 10, daily_cap_usd: 20 });
      await expect(setPolicy(a, { daily_cap_usd: 0 })).resolves.toMatchObject({ daily_cap_usd: 0 });
    });
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
    const ownerEmail = `owner-${randomUUID()}@owners.eyes.pictures`;
    const signup = await service.signupAgent({ name: "owned-agent", owner_email: ownerEmail });
    const mail = providers.email.outbox.find((m) => m.to === ownerEmail);
    const ownerToken = mail?.text.match(/\/owner\/([\w.-]+)/)?.[1] ?? "";
    expect(ownerToken).not.toBe("");
    expect(mail?.text).toContain(`An AI agent (Eyes agent id ${signup.agent_id})`);
    expect(mail?.text).not.toContain("owned-agent");
    expect(mail?.subject).not.toContain("owned-agent");
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

    // ADR-044: owner tasks are scoped to the token's agent; another owner's token sees none of it.
    const otherMail = `owner-${randomUUID()}@owners.eyes.pictures`;
    await service.signupAgent({ name: "other-agent", owner_email: otherMail });
    const otherToken =
      providers.email.outbox.find((m) => m.to === otherMail)?.text.match(/\/owner\/([\w.-]+)/)?.[1] ?? "";
    expect(otherToken).not.toBe("");
    expect((await service.ownerTasks(ownerToken, { limit: 20 })).tasks.map((t) => t.task_id)).toEqual([
      asked.task_id,
    ]);
    expect((await service.ownerTasks(otherToken, { limit: 20 })).tasks).toEqual([]);
    expect((await service.ownerTasks(otherToken, { limit: 20, before: asked.task_id })).tasks).toEqual([]);
    expect((await service.ownerConsole(otherToken)).tasks).toEqual([]);
    await expect(service.ownerTasks("bogus", { limit: 20 })).rejects.toMatchObject({
      code: "owner_link_invalid",
    });

    // ADR-052: a revoke kills the link made before it; a new link at the new version works.
    const { owner_link_version } = await service.revokeOwnerLinks(signup.agent_id);
    expect(owner_link_version).toBe(1);
    await expect(service.ownerConsole(ownerToken)).rejects.toMatchObject({ code: "owner_link_invalid" });
    const newLink = signToken("test-link-secret-0123456789", `p:${signup.agent_id}:${owner_link_version}`);
    expect((await service.ownerConsole(newLink)).agent_id).toBe(signup.agent_id);
    expect(await service.setAgentSuspended(signup.agent_id, true)).toEqual({
      agent_id: signup.agent_id,
      suspended: true,
    });
    expect((await service.authenticate(signup.api_key))?.suspended).toBe(true);
    await service.setAgentSuspended(signup.agent_id, false);
    const unknown = randomUUID();
    await expect(
      service.ownerConsole(signToken("test-link-secret-0123456789", `p:${unknown}`)),
    ).rejects.toMatchObject({ code: "owner_link_invalid" });
    await expect(service.setAgentSuspended(unknown, true)).rejects.toMatchObject({ code: "not_found" });
    await expect(service.revokeOwnerLinks(unknown)).rejects.toMatchObject({ code: "not_found" });

    const types = ["is_open", "line_length"] as const;
    expect(
      await service.updateSpendPolicy(newLink, {
        max_bounty_usd: 2,
        daily_cap_usd: 20,
        allowed_task_types: [...types, "is_open"],
      }),
    ).toEqual({
      max_bounty_usd: 2,
      daily_cap_usd: 20,
      cap_period: "day",
      at_limit: "ask",
      spent_today_usd: 3.5,
      remaining_today_usd: 16.5,
      allowed_task_types: types,
    });
    await expect(ask(await fresh(), at)).rejects.toMatchObject({ code: "bounty_exceeds_max" });
    await expect(ask(await fresh(), at, { bounty_usd: 2, task_type: "in_stock" })).rejects.toMatchObject({
      code: "task_type_not_allowed",
    });

    await service.updateSpendPolicy(newLink, {
      max_bounty_usd: 10,
      daily_cap_usd: 0,
      allowed_task_types: [...types],
    });
    const frozen = await ask(await fresh(), at, { bounty_usd: 2 }).catch((err: EyesError) => err);
    expect(frozen).toMatchObject({ code: "daily_cap_exceeded", fix: expect.stringContaining("froze") });
    expect((frozen as EyesError).fix).not.toMatch(/tomorrow|Lower bounty_usd/);

    await service.updateSpendPolicy(newLink, {
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
    const ownerEmail = `owner-${randomUUID()}@owners.eyes.pictures`;
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
    // One text: no payout step on a test server, the simulated note instead; the app is the one step.
    const lines = hubLines(texts.at(-1));
    expect(lines.slice(0, 3)).toEqual([
      "You're in. Eyes texts you paid photo tasks near you.",
      expect.stringMatching(/^Get the app \(keeps your spot fresh\): /),
      simulated,
    ]);
    expect(String(texts.at(-1))).not.toContain("/w/connect/");
    expect(await sim.workerSetup(meToken(lines[3]))).toMatchObject({
      payouts: { set_up: false, live: false, setup_url: null },
    });
    await sim.handleWorkerReply({ phone, intent: "help", text: "HELP" });
    expect(hubLines(last("text"))[2]).toBe(simulated);

    const verified = await capture();
    expect(verified.result).toMatchObject({ status: "verified", message: `Verified. ${simulated}` });
    expect(last("paid")).toMatchObject({ task_id: verified.task_id, live_payouts: false });

    providers.vision.setVerdict({ allowed: false, reason: "The photo shows graphic gore." });
    const review = await capture();
    expect(review.result).toMatchObject({
      status: "needs_review",
      message: `Thanks, we got it. Your answer needs a quick manual check (The photo shows graphic gore.). ${simulated} To request a manual review, reply HELP to the Eyes text.`,
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
      const signup = await service.signupAgent({
        name: "unlucky-agent",
        owner_email: "owner@owners.eyes.pictures",
      });
      expect(signup.next_step).toContain("could not email your user at owner@owners.eyes.pictures");
      expect(error).toHaveBeenCalled();
      expect(JSON.stringify(error.mock.calls)).not.toContain("/owner/");
    } finally {
      providers.email.send = send;
      error.mockRestore();
    }
  });

  it("emails only the first payer a working owner link, once, and never shows the link to the agent", async () => {
    const a = await agent();
    const payer = `payer-${randomUUID()}@owners.eyes.pictures`;
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

    const later = `later-${randomUUID()}@owners.eyes.pictures`;
    await service.creditTopup({ ...topup, stripe_ref: `cs_${randomUUID()}`, payer_email: later });
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 50 });
    expect(providers.email.outbox).toHaveLength(before + 1);
    for (const out of [await service.getBalance(a), await service.getSpendPolicy(a)]) {
      expect(JSON.stringify(out)).not.toContain("/owner/");
    }
  });

  it("does not give a later payer control when the first payment has no email", async () => {
    const a = await agent();
    const before = providers.email.outbox.length;
    await service.creditTopup({
      agent_id: a.id,
      amount_cents: 1500,
      stripe_ref: `cs_${randomUUID()}`,
      payer_email: null,
    });
    await service.creditTopup({
      agent_id: a.id,
      amount_cents: 1500,
      stripe_ref: `cs_${randomUUID()}`,
      payer_email: "later@owners.eyes.pictures",
    });

    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 50 });
    expect(providers.email.outbox).toHaveLength(before);
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
    const payer = `payer-${randomUUID()}@owners.eyes.pictures`;
    const ref = `cs_${randomUUID()}`;
    const before = providers.email.outbox.length;
    await overlapping(a.id, () => Array.from({ length: 5 }, () => topup(a.id, ref, payer)));
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 35 });
    expect(providers.email.outbox.slice(before).map((m) => m.to)).toEqual([payer]);

    const b = await agent();
    const payers = [
      `first-${randomUUID()}@owners.eyes.pictures`,
      `second-${randomUUID()}@owners.eyes.pictures`,
    ];
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
        payer_email: "payer@owners.eyes.pictures",
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
    const policy = { max_bounty_usd: 1, daily_cap_usd: 2, allowed_task_types: [] };
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
      place_label: expect.any(String),
      claimed_at: expect.any(String),
      dispute: null,
    };

    const first = await work(3);
    const connect = connectToken(w.phone);
    expect(await service.workerTasks(await helpEarnings(w.phone), {})).toEqual({
      paid_usd: 0,
      pending_usd: 3,
      tasks: [
        { ...row, task_id: first, status: "verified", bounty_usd: 3, payout: "waiting_for_payout_setup" },
      ],
      next_cursor: null,
    });

    await service.workerConnectUrl(connect);
    const setupToken = await helpEarnings(w.phone);
    for (const intent of ["start", "help"] as const) {
      await service.handleWorkerReply({ phone: w.phone, intent, text: intent.toUpperCase() });
      expect(String(outbox.findLast((m) => m.to === w.phone && m.kind === "text")?.payload)).toContain(
        "/w/connect/",
      );
    }
    const setup = await service.workerSetup(setupToken);
    expect(setup.payouts.setup_url).toMatch(/^https:\/\/api\.eyes\.test\/w\/connect\//);
    await expect(
      service.workerConnectUrl(new URL(setup.payouts.setup_url ?? "").pathname.split("/").at(-1) ?? ""),
    ).resolves.toContain(`acct_fake_${w.worker_id}`);
    await service.markWorkerOnboarded(`acct_fake_${w.worker_id}`);
    const paid = outbox.findLast((m) => m.to === w.phone && m.kind === "paid");
    expect(paid?.payload).toMatchObject({ task_id: first, amount_cents: 300 });
    expect((await service.workerSetup(setupToken)).payouts.setup_url).toBeNull();
    await service.handleWorkerReply({ phone: w.phone, intent: "start", text: "START" });
    expect(String(outbox.findLast((m) => m.to === w.phone && m.kind === "text")?.payload)).not.toContain(
      "/w/connect/",
    );

    const payoutWorker = providers.payments.payoutWorker;
    providers.payments.payoutWorker = async () => {
      throw new Error("balance_insufficient");
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = await work(4.25).finally(() => {
      providers.payments.payoutWorker = payoutWorker;
      error.mockRestore();
    });

    expect(paid?.payload.me_url).toMatch(/^https:\/\/w\.eyes\.test\/me#c=[\w-]+\.[\w-]+$/);
    const view = WorkerTasks.parse(await service.workerTasks(meToken(paid?.payload.me_url), {}));
    expect(view).toEqual({
      paid_usd: 3,
      pending_usd: 4.25,
      tasks: [
        { ...row, task_id: second, status: "verified", bounty_usd: 4.25, payout: "pending" },
        { ...row, task_id: first, status: "paid", bounty_usd: 3, payout: "paid" },
      ],
      next_cursor: null,
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
    const view = async (phone: string) => service.workerTasks(await helpEarnings(phone), {});
    expect(await view(w1.phone)).toMatchObject({ pending_usd: 3, tasks: [{ task_id: t1 }] });
    expect((await view(w1.phone)).tasks).toHaveLength(1);
    expect(await view(w2.phone)).toMatchObject({ pending_usd: 5, tasks: [{ task_id: t2 }] });
    expect((await view(w2.phone)).tasks).toHaveLength(1);
    expect(await view(idle.phone)).toEqual({ paid_usd: 0, pending_usd: 0, tasks: [], next_cursor: null });
    // A cursor from another worker's list only moves the window; it never shows that worker's tasks.
    const other = (await view(w2.phone)).tasks[0];
    const fromW2 = await service.workerTasks(await helpEarnings(w1.phone), {
      cursor: `9999-01-01T00:00:00Z|${other?.task_id}`,
    });
    expect(fromW2.tasks.map((t) => t.task_id)).toEqual([t1]);
  });

  it("lists tasks only with an e: token for an existing worker, signed here and under 7 days old", async () => {
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
      await expect(service.workerTasks(token, {})).rejects.toMatchObject({
        code: "unauthorized",
        message: "This link is invalid or has expired.",
      });
    }
    const token = await helpEarnings(w.phone);
    const issued = providers.clock.now();
    try {
      providers.clock.advance(7 * 24 * 60 * 60 * 1000 - 1000);
      await expect(service.workerTasks(token, {})).resolves.toMatchObject({ tasks: [] });
      providers.clock.advance(2000);
      await expect(service.workerTasks(token, {})).rejects.toMatchObject({ code: "unauthorized" });
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
        owner_email: "o@owners.eyes.pictures",
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

  it("revokes only the replaced agent key on REST and an already connected MCP client", async () => {
    const first = await service.signupAgent({ name: "rotate-this-agent" });
    const other = await service.signupAgent({ name: "keep-this-agent" });
    const a = (await service.authenticate(first.api_key)) as Agent;
    const ownerToken = signToken(deps.config.link_secret, `p:${a.id}`);
    const server = createServer({ service, providers, config: deps.config, env: {} });
    const fetch: typeof globalThis.fetch = (url, init) => server.fetch(new Request(url, init));
    const balance = (key: string) =>
      fetch("http://eyes.test/v1/balance", { headers: { authorization: `Bearer ${key}` } });
    const client = new Client({ name: "revocation-test", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://eyes.test/mcp"), {
          fetch,
          requestInit: { headers: { authorization: `Bearer ${first.api_key}` } },
        }),
      );
      expect((await balance(first.api_key)).status).toBe(200);
      expect((await client.callTool({ name: "get_balance", arguments: {} })).isError).not.toBe(true);

      const replacement = await service.rotateApiKey(ownerToken);

      expect((await balance(first.api_key)).status).toBe(401);
      await expect(client.callTool({ name: "get_balance", arguments: {} })).rejects.toThrow(
        /"error":"unauthorized"/,
      );
      expect((await balance(replacement.api_key)).status).toBe(200);
      expect((await balance(other.api_key)).status).toBe(200);
      await expect(service.ownerConsole(ownerToken)).resolves.toMatchObject({
        top_up_url: first.top_up_url,
      });
    } finally {
      await client.close();
    }
  }, 30_000);

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

  it.each([
    ["ordinary public photo with incidental faces", true, 0.95, false],
    ["uncertain content", true, 0.1, false],
    ["graphic gore", false, 0.95, false],
    ["explicit sexual content", false, 0.95, false],
    ["Safety check unavailable; the photo needs manual review.", false, 0.95, false],
    ["provider unavailable", false, 0, true],
  ])("moderates %s without deleting photos or paying twice", async (reason, allowed, confidence, fails) => {
    const verify = vi.spyOn(deps, "verifySubmission").mockImplementation(verifySubmission);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const remove = vi.spyOn(providers.storage, "deletePhoto");
    const judge = vi.spyOn(providers.vision, "judge");
    if (fails) judge.mockRejectedValue(new Error("provider failed"));
    providers.vision.setVerdict({ allowed, confidence, reason });
    try {
      const at = somewhere();
      const { a, task_id, token, w } = await claimed(at);
      await service.workerConnectUrl(connectToken(w.phone));
      expect(await capture(token, at)).toMatchObject({
        status: allowed ? "paid" : "needs_review",
        verification: { gps_ok: true, fresh_ok: true, vision_ok: allowed },
      });
      const [key] = stored(task_id);
      expect(key).toBeDefined();
      expect(remove).not.toHaveBeenCalled();
      const answer = (await service.getTask(a, { task_id })).answer;
      expect(answer?.photo_url).toBe(allowed ? `https://storage.fake.test/photos/${key}?sig=fake` : null);
      if (fails) expect(answer?.verification.vision_reason).toContain("unavailable");
      await expect(capture(token, at)).rejects.toMatchObject({ code: "offer_invalid" });
      await service.retryPayouts();
      const released = await sql`select id from ledger where task_id = ${task_id} and type = 'release'`;
      expect(released).toHaveLength(allowed ? 1 : 0);
      const paid = providers.payments.transfers.filter((p) => p.task_id === task_id);
      expect(paid).toHaveLength(allowed ? 1 : 0);
      if (!allowed) {
        expect(await service.resolveTask(task_id, "release", "Manual photo review")).toMatchObject({
          status: "paid",
        });
        await expect(service.resolveTask(task_id, "release", "Repeated release")).rejects.toMatchObject({
          code: "invalid_input",
        });
        await service.retryPayouts();
        const delivered = (await service.awaitAnswer(a, { task_id, timeout_seconds: 1 })).answer;
        expect(delivered?.photo_url).toBe(fails ? `https://storage.fake.test/photos/${key}?sig=fake` : null);
        expect((await service.getTask(a, { task_id })).answer?.photo_url).toBe(delivered?.photo_url);
        expect(delivered?.verification.vision_ok).toBe(false);
        expect(await sql`select id from ledger where task_id = ${task_id} and type = 'release'`).toHaveLength(
          1,
        );
        expect(providers.payments.transfers.filter((p) => p.task_id === task_id)).toHaveLength(1);
      }
    } finally {
      verify.mockRestore();
      judge.mockRestore();
      remove.mockRestore();
      log.mockRestore();
    }
  });

  const tickets = (taskId: string) =>
    sql`select id::int, status, message, note from tickets where task_id = ${taskId}`;

  it("HELP after a held answer opens a ticket, a free-text reply adds to it, and resolving it texts the worker", async () => {
    const at = somewhere();
    providers.vision.setVerdict({ allowed: false, reason: "The photo shows graphic gore." });
    const { task_id, token, w } = await claimed(at);
    expect(await capture(token, at)).toMatchObject({
      status: "needs_review",
      message:
        "Thanks, we got it. Your answer needs a quick manual check (The photo shows graphic gore.). You will be paid once it is approved. To request a manual review, reply HELP to the Eyes text.",
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
          /^You're (in|all set)\. Eyes texts you paid photo tasks near you\.\n[\s\S]*Your setup: /,
        );
        await service.handleWorkerReply({ phone: w.phone, intent: "unknown", text: "hello?" });
        expect(outbox.findLast((m) => m.to === w.phone)?.payload).toMatch(
          /^Didn't catch that\. Reply YES to take a task or STOP to pause\. Your setup: https:\/\/w\.eyes\.test\/me#c=\S+$/,
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
    await reply(releaser.phone);

    providers.clock.advance(1000);
    const elsewhere = await ask(a, north(at, 5000));
    await reply(busy.phone);
    expect(outbox.findLast((m) => m.to === busy.phone)).toMatchObject({
      kind: "capture_link",
      payload: { task_id: elsewhere.task_id },
    });

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

  it("blocks new YES claims over phone and verified email when an earlier offer's worker is held", async () => {
    const at = somewhere();
    const a = await agent();
    const w = await worker(at);
    const email = `held-${randomUUID()}@example.test`;
    await sql`update workers set email = ${email}, email_verified_at = now() where id = ${w.worker_id}`;
    const { task_id } = await ask(a, at);
    await sql`update workers set dispute_hold_at = now() where id = ${w.worker_id}`;
    await reply(w.phone);
    await service.handleWorkerReply({ email, intent: "yes", text: "YES" });
    expect((await service.getTask(a, { task_id })).status).toBe("dispatched");
    expect(outbox.filter((m) => m.kind === "capture_link" && m.payload.task_id === task_id)).toHaveLength(0);
    expect((await service.quoteTask(a, { location: at, task_type: "line_length" })).workers_nearby).toBe(0);
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

    it("a dispute pauses the worker's Stripe payouts until ops rejects it", async () => {
      const { a, w, task_id } = await paidTask();
      const account = `acct_fake_${w.worker_id}`;
      await service.disputeAnswer(a, { task_id, reason: "The photo shows a different cafe." });
      expect(providers.payments.payoutsPaused.get(account)).toBe(true);
      await service.rejectDispute({ ticket_id: await disputeTicket(task_id), note: "answer stands" });
      expect(providers.payments.payoutsPaused.get(account)).toBe(false);
    });

    it("sends an answer to review when the worker email is the paying owner's", async () => {
      const at = somewhere();
      const { a, w, token } = await claimed(at);
      await sql`update agents set owner_email = 'boss@example.com' where id = ${a.id}`;
      await sql`update workers set email = 'boss@example.com' where id = ${w.worker_id}`;
      expect(await capture(token, at)).toMatchObject({ status: "needs_review" });
    });

    it("dispute_answer opens a dispute ticket that get_task reports as open", async () => {
      const { a, task_id, at } = await paidTask();
      const before = await service.getTask(a, { task_id });
      const money = await service.getBalance(a);
      const disputed = await service.disputeAnswer(a, {
        task_id,
        reason: "The photo shows a different cafe.",
      });
      expect(disputed.retry_context).toEqual({
        question: before.question,
        location: { ...at, label: before.place_label },
        task_type: before.task_type,
        bounty_usd: before.bounty_usd,
        deadline_minutes: 30,
        require_photo: true,
      });
      expect((await service.getTask(a, { task_id })).retry_context).toEqual(disputed.retry_context);
      expect(await service.disputeAnswer(a, { task_id, reason: "The same report again." })).toEqual(disputed);
      const count = Number((await sql`select count(*) as n from tasks where agent_id = ${a.id}`)[0]?.n);
      const quote = await service.quoteTask(a, {
        location: disputed.retry_context.location,
        task_type: disputed.retry_context.task_type,
      });
      expect(quote.allowed).toBe(true);
      expect(await service.getBalance(a)).toEqual(money);
      expect(Number((await sql`select count(*) as n from tasks where agent_id = ${a.id}`)[0]?.n)).toBe(count);
      const retry = await service.askEyes(a, {
        ...disputed.retry_context,
        idempotency_key: randomUUID(),
        deadline_minutes: 30,
        require_photo: true,
      });
      expect(retry.task_id).not.toBe(task_id);
      expect((await service.getBalance(a)).balance_usd).toBe(
        money.balance_usd - before.bounty_usd - before.fee_usd,
      );
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

    it("owner and worker dispute routes: state in both lists, wrong owner 404, double dispute 409 (ADR-047)", async () => {
      const { a, w, task_id } = await paidTask();
      const owner = signToken("test-link-secret-0123456789", `p:${a.id}`);
      const stranger = signToken("test-link-secret-0123456789", `p:${randomUUID()}`);
      const e = signToken("test-link-secret-0123456789", `e:${w.worker_id}`);
      const ownerState = async () =>
        (await service.ownerTasks(owner, { limit: 20 })).tasks.find((t) => t.task_id === task_id)?.dispute;
      const workerState = async () =>
        (await service.workerTasks(e, {})).tasks.find((t) => t.task_id === task_id)?.dispute;
      const input = { task_id, reason: "Photo shows another shop." };
      expect([await ownerState(), await workerState()]).toEqual([null, null]);

      await expect(service.ownerDispute(stranger, input)).rejects.toMatchObject({ status: 404 });
      await expect(service.workerDispute(e, input)).rejects.toMatchObject({ code: "task_not_disputable" });
      expect(await service.ownerDispute(owner, input)).toMatchObject({ task_id, status: "disputed" });
      await expect(service.ownerDispute(owner, input)).rejects.toMatchObject({ status: 409 });
      expect([await ownerState(), await workerState()]).toEqual(["open", "open"]);

      const other = signToken(
        "test-link-secret-0123456789",
        `e:${(await worker(somewhere(), false)).worker_id}`,
      );
      await expect(service.workerDispute(other, input)).rejects.toMatchObject({ status: 404 });
      expect(await service.workerDispute(e, input)).toEqual({ task_id, dispute: "in_review" });
      await expect(service.workerDispute(e, input)).rejects.toMatchObject({ status: 409 });
      expect([await ownerState(), await workerState()]).toEqual(["in_review", "in_review"]);
      expect((await service.getTask(a, { task_id })).dispute).toEqual({ status: "open", refunded_usd: null });

      await sql`update tickets set status = 'resolved', resolved_at = now(), note = 'closed' where task_id = ${task_id} and appeal`;
      await service.rejectDispute({ ticket_id: await disputeTicket(task_id), note: "answer stands" });
      expect([await ownerState(), await workerState()]).toEqual(["stands", "stands"]);
    });

    it("confirm fraud refunds bounty + fee, reverses the transfer once, bans the worker; a double click moves nothing", async () => {
      const { a, w, task_id, at } = await paidTask();
      const other = await worker(somewhere(), false);
      const devices = [
        { udid: "00000000-0000000000000001", worker_id: w.worker_id },
        { udid: "00000000-0000000000000002", worker_id: w.worker_id },
        { udid: "00000000-0000000000000003", worker_id: other.worker_id },
      ];
      await sql`insert into worker_devices ${sql(devices)}`;
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
      expect(
        await sql`select udid, worker_id from worker_devices
          where worker_id in (${w.worker_id}, ${other.worker_id})`,
      ).toEqual([devices[2]]);
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
      // 0,0 is a missing location written as numbers, never a place to send someone.
      await expect(
        service.quoteTask(a, { location: { lat: 0, lng: 0 }, task_type: "line_length" }),
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
          Object.assign(new Error("rejected owner@owners.eyes.pictures, see https://smtp.example/x"), {
            status: 550,
          }),
        );
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const first = await live.signupAgent({
          name: "live-agent",
          owner_email: "owner@owners.eyes.pictures",
        });
        expect(first.api_key).toMatch(/^eyes_live_/);
        expect(first.balance_usd).toBe(0);
        expect(first.next_step).toContain("We could not email your user at owner@owners.eyes.pictures");
        const second = await live.signupAgent({
          name: "live-agent",
          owner_email: "owner@owners.eyes.pictures",
        });
        expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
          `owner email for agent ${first.agent_id} failed: unknown`,
          `owner email for agent ${second.agent_id} failed: Error status 550: rejected <redacted> see <redacted>`,
        ]);
      } finally {
        send.mockRestore();
        error.mockRestore();
      }
    });

    it("skips owner email to reserved test domains at debug level and notes a provider 403 recipient denial once per agent at info level", async () => {
      const send = vi.spyOn(providers.email, "send");
      const logs = (["debug", "warn", "error"] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => {}),
      );
      const [debug, warn, error] = logs;
      notices.length = 0;
      try {
        for (const to of [
          "o@example.com",
          "o@a.example.net",
          "o@x.test",
          "o@x.example",
          "o@x.invalid",
          "o@app.localhost",
        ]) {
          const s = await service.signupAgent({ name: "smoke-agent", owner_email: to });
          expect(s.next_step).toContain(`could not email your user at ${to}`);
        }
        expect(send).not.toHaveBeenCalled();
        expect(debug).toHaveBeenCalledTimes(6);
        expect(String(debug?.mock.calls[0]?.[0])).toMatch(/skipped: reserved test domain$/);

        send.mockRejectedValueOnce(
          Object.assign(
            new Error("cannot send to o@x.co: x.co is not a Primitive-managed recipient domain"),
            {
              name: "PrimitiveApiError",
              status: 403,
            },
          ),
        );
        const denied = await service.signupAgent({ name: "scoped-agent", owner_email: "o@notexample.com" });
        expect(denied.next_step).toContain("could not email your user at o@notexample.com");
        send.mockRejectedValueOnce(
          Object.assign(new Error("cannot send to o@gmail.com: All granted recipient-scope gates denied"), {
            name: "PrimitiveApiError",
            status: 403,
            gates: [
              { name: "send_to_primitive_managed_domains", subject: "gmail.com" },
              { name: "send_to_confirmed_domains", subject: "o@gmail.com" },
              { name: "send_to_known_addresses", subject: "o@gmail.com" },
            ],
          }),
        );
        const gated = await service.signupAgent({ name: "gated-agent", owner_email: "o@gmail.com" });
        expect(gated.next_step).toContain("could not email your user at o@gmail.com");
        // The first payer's email to the same agent is denied again: no second notice.
        send.mockRejectedValueOnce(Object.assign(new Error("recipient not allowed"), { status: 403 }));
        await service.creditTopup({
          agent_id: gated.agent_id,
          amount_cents: 500,
          stripe_ref: `cs_gate_${gated.agent_id}`,
          payer_email: "p@gmail.com",
        });
        expect(send).toHaveBeenCalledTimes(3);
        expect(error).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        expect(notices).toEqual([
          {
            kind: "email",
            summary: `owner email for agent ${denied.agent_id} not sent: the email provider refused the recipient (403); it sends replies only until any-domain sending is enabled`,
          },
          {
            kind: "email",
            summary: `owner email for agent ${gated.agent_id} not sent: the email provider refused the recipient (403, gates denied: send_to_primitive_managed_domains, send_to_confirmed_domains, send_to_known_addresses); it sends replies only until any-domain sending is enabled`,
          },
        ]);
        expect(JSON.stringify(notices)).not.toContain("@");
      } finally {
        send.mockRestore();
        for (const log of logs) log.mockRestore();
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
        const earnings = await service.workerTasks(await helpEarnings(w.phone), {});
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
