import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Agent,
  AppConfig,
  type AskEyesInput,
  fakeProviders,
  type LatLng,
  type SafetyVerdict,
  type VerificationResult,
} from "@eyes/core";
import { migrate } from "@eyes/db";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEyesService } from "./index.ts";

const url = process.env.DATABASE_URL ?? "";

const ALLOW: SafetyVerdict = { allowed: true, category: null, reason: null, fix: null, layer: null };
const PASS: VerificationResult = {
  gps_ok: true,
  fresh_ok: true,
  vision_ok: true,
  vision_reason: "ok",
  worker_distance_m: 0,
  confidence: 0.9,
  auto_approve: true,
};
const NO_OPEN_TASK = "no open task";

type Msg = { to: string; kind: string; payload: Record<string, unknown> };
type Env = ReturnType<typeof make>;

function make(opts: { maxWorkers?: number; verify?: () => Promise<VerificationResult> } = {}) {
  const providers = fakeProviders();
  const service = createEyesService({
    db: { kind: "postgres", url },
    providers,
    assessTask: async () => ALLOW,
    verifySubmission: opts.verify ?? (async () => PASS),
    config: AppConfig.parse({
      public_api_url: "https://api.eyes.test",
      worker_web_url: "https://w.eyes.test",
      link_secret: "test-link-secret-0123456789",
      dispatch_max_workers: opts.maxWorkers ?? 3,
      live_payouts: true,
    }),
  });
  return { providers, service, outbox: providers.messaging.outbox as Msg[] };
}

describe.skipIf(!url)("engine under races and guards", () => {
  const sql = postgres(url, { onnotice: () => {}, max: 4 });
  const main = make({ maxWorkers: 10 });
  const { service, providers, outbox } = main;
  const agentsSeen = new Set<string>();

  beforeAll(() => migrate(url));
  afterAll(() => sql.end());

  afterEach(async () => {
    const ids = [...agentsSeen];
    agentsSeen.clear();
    for (const id of ids) await assertLedger(id);
  });

  const somewhere = (): LatLng => ({ lat: 10 + Math.random() * 40, lng: -120 + Math.random() * 60 });
  const north = (p: LatLng, m: number): LatLng => ({ lat: p.lat + m / 111_320, lng: p.lng });
  const lastText = (env: Env, phone: string) =>
    String(env.outbox.findLast((m) => m.to === phone && m.kind === "text")?.payload ?? "");
  // START sends the welcome (with the payout link) and then the app link.
  const welcomeText = (env: Env, phone: string) =>
    String(
      env.outbox.findLast((m) => m.to === phone && String(m.payload).startsWith("You are in."))?.payload ??
        "",
    );

  async function worker(at: LatLng, env: Env = main) {
    const phone = `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;
    const joined = await env.service.joinWorker({ name: "Worker", phone, ...at });
    await env.service.handleWorkerReply({ phone, intent: "start", text: "START" });
    const [row] = await sql`select id from workers where phone = ${phone}`;
    return {
      ...joined,
      worker_id: String(row?.id),
      phone,
      // The welcome ends with the setup link (ADR-028), so the token runs to the next space.
      connectToken: /\/w\/connect\/(\S+)/.exec(welcomeText(env, phone))?.[1] ?? "",
    };
  }
  async function agent(env: Env = main) {
    const { api_key } = await env.service.signupAgent({ name: "adv" });
    const a = (await env.service.authenticate(api_key)) as Agent;
    agentsSeen.add(a.id);
    return a;
  }
  const ask = (a: Agent, at: LatLng, extra: Partial<AskEyesInput> = {}, env: Env = main) =>
    env.service.askEyes(a, {
      question: "Is the line long?",
      location: at,
      task_type: "line_length",
      bounty_usd: 3,
      deadline_minutes: 30,
      require_photo: true,
      idempotency_key: randomUUID(),
      ...extra,
    });
  const yes = (phone: string, env: Env = main) =>
    env.service.handleWorkerReply({ phone, intent: "yes", text: "YES" });
  const tokenOf = (box: Msg[], phone: string) => {
    const link = box.findLast((m) => m.to === phone && m.kind === "capture_link");
    return new URL(String(link?.payload.capture_url)).searchParams.get("t") ?? "";
  };
  const capture = (at: LatLng, now: Date) => ({
    lat: at.lat,
    lng: at.lng,
    accuracy_m: 8,
    captured_at: now.toISOString(),
    answer_text: "short",
    answer_bool: null,
  });
  const photo = { bytes: new Uint8Array([255, 216, 255]), content_type: "image/jpeg" };
  const task = async (id: string) =>
    (await sql`select status, claimed_by from tasks where id = ${id}`)[0] as {
      status: string;
      claimed_by: string | null;
    };
  const rows = (id: string) =>
    sql`select type, amount_cents::int as amount from ledger where task_id = ${id} order by type`;
  const waiting = async (fn: string) =>
    (
      await sql`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and query like ${`%${fn}(%`}`
    )[0]?.n as number;
  async function untilWaiting(fn: string, n: number) {
    for (let i = 0; i < 500 && (await waiting(fn)) < n; i++) await sleep(10);
    expect(await waiting(fn)).toBeGreaterThanOrEqual(n);
  }
  const deadlineClock = (deadline_at: string, offsetMs: number) => {
    const env = make();
    env.providers.clock.set(new Date(new Date(deadline_at).getTime() + offsetMs));
    return env;
  };

  async function assertLedger(agentId: string) {
    const per = await sql`
      select t.id, t.status, (t.bounty_cents + t.fee_cents)::int as total, t.bounty_cents::int as bounty,
        coalesce(sum(l.amount_cents) filter (where l.type = 'escrow'), 0)::int as escrow,
        coalesce(sum(l.amount_cents) filter (where l.type = 'release'), 0)::int as release,
        coalesce(sum(l.amount_cents) filter (where l.type = 'fee'), 0)::int as fee,
        coalesce(sum(l.amount_cents) filter (where l.type = 'refund'), 0)::int as refund,
        coalesce(sum(l.amount_cents) filter (where l.type = 'payout'), 0)::int as payout
      from tasks t left join ledger l on l.task_id = t.id
      where t.agent_id = ${agentId} group by t.id`;
    for (const r of per) {
      const ctx = JSON.stringify(r);
      expect(r.escrow, ctx).toBe(r.total);
      if (["expired", "refunded"].includes(r.status)) {
        expect(r.refund, ctx).toBe(r.escrow);
        expect(r.release + r.fee + r.payout, ctx).toBe(0);
      } else if (["verified", "paid"].includes(r.status)) {
        expect(r.release + r.fee, ctx).toBe(r.escrow);
        expect(r.refund, ctx).toBe(0);
        expect(r.payout, ctx).toBe(r.status === "paid" ? r.bounty : 0);
      } else if (r.status === "disputed") {
        expect(r.refund, ctx).toBe(0);
        expect(r.release + r.fee === 0 || r.release + r.fee === r.escrow, ctx).toBe(true);
      } else {
        expect(r.refund + r.release + r.fee + r.payout, ctx).toBe(0);
      }
    }
    const [b] = await sql<[{ balance: number; topups: number; escrows: number; refunds: number }]>`
      select a.balance_cents::int as balance,
        coalesce(sum(l.amount_cents) filter (where l.type = 'topup'), 0)::int as topups,
        coalesce(sum(l.amount_cents) filter (where l.type = 'escrow'), 0)::int as escrows,
        coalesce(sum(l.amount_cents) filter (where l.type = 'refund'), 0)::int as refunds
      from agents a left join ledger l on l.agent_id = a.id
      where a.id = ${agentId} group by a.id`;
    expect(b.balance, JSON.stringify(b)).toBe(b.topups - b.escrows + b.refunds);
    expect(b.balance).toBeGreaterThanOrEqual(0);
  }

  it("10 workers reply YES at once (forced on the row lock): one claim, nine already_claimed", async () => {
    const at = somewhere();
    const ws = await Promise.all(Array.from({ length: 10 }, (_, i) => worker(north(at, 50 + i * 20))));
    const a = await agent();
    const asked = await ask(a, at);
    expect(asked.workers_notified).toBe(10);
    let race: Promise<unknown> = Promise.resolve();
    await sql.begin(async (tx) => {
      await tx`select id from tasks where id = ${asked.task_id} for update`;
      race = Promise.all(ws.map((w) => yes(w.phone)));
      await untilWaiting("eyes_claim", 10);
    });
    await race;
    const phones = new Set(ws.map((w) => w.phone));
    const mine = outbox.filter((m) => phones.has(m.to));
    expect(mine.filter((m) => m.kind === "capture_link")).toHaveLength(1);
    expect(mine.filter((m) => m.kind === "already_claimed")).toHaveLength(9);
    const t = await task(asked.task_id);
    expect(t.status).toBe("claimed");
    expect(mine.find((m) => m.kind === "capture_link")?.to).toBe(
      ws.find((w) => w.worker_id === t.claimed_by)?.phone,
    );
  });

  it("a YES that loses to expiry is told there is no open task, and the task is refunded once", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const a = await agent();
    const { task_id, deadline_at } = await ask(a, at, { deadline_minutes: 5 });
    const late = deadlineClock(deadline_at, 0);
    const early = deadlineClock(deadline_at, -1000);
    let race: Promise<unknown[]> = Promise.resolve([]);
    await sql.begin(async (tx) => {
      await tx`select id from tasks where id = ${task_id} for update`;
      const exp = late.service.expireOverdue();
      await untilWaiting("eyes_expire_overdue", 1);
      const claim = yes(w.phone, early);
      await untilWaiting("eyes_claim", 1);
      race = Promise.all([exp, claim]);
    });
    await race;
    expect(await task(task_id)).toEqual({ status: "expired", claimed_by: null });
    expect(early.outbox.map((m) => m.kind)).toEqual(["text"]);
    expect(lastText(early, w.phone)).toContain(NO_OPEN_TASK);
    expect((await rows(task_id)).filter((r) => r.type === "refund")).toHaveLength(1);
  });

  it("a YES after deadline_at but before expiry runs is not claimed", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const a = await agent();
    const { task_id, deadline_at } = await ask(a, at, { deadline_minutes: 5 });
    const late = deadlineClock(deadline_at, 1000);
    await yes(w.phone, late);
    expect(await task(task_id)).toEqual({ status: "dispatched", claimed_by: null });
    expect(late.outbox.map((m) => m.kind)).toEqual(["text"]);
    expect(lastText(late, w.phone)).toContain(NO_OPEN_TASK);
  });

  it("YES wins a race with expiry at the deadline: the claimed task still expires once and capture is refused", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const a = await agent();
    const { task_id, deadline_at } = await ask(a, at, { deadline_minutes: 5 });
    const late = deadlineClock(deadline_at, 0);
    const early = deadlineClock(deadline_at, -1000);
    let race: Promise<unknown[]> = Promise.resolve([]);
    await sql.begin(async (tx) => {
      await tx`select id from tasks where id = ${task_id} for update`;
      const claim = yes(w.phone, early);
      await untilWaiting("eyes_claim", 1);
      const exp = late.service.expireOverdue();
      await untilWaiting("eyes_expire_overdue", 1);
      race = Promise.all([claim, exp]);
    });
    await race;
    expect(early.outbox.filter((m) => m.kind === "capture_link")).toHaveLength(1);
    expect((await task(task_id)).status).toBe("expired");
    await expect(
      early.service.submitCapture(
        tokenOf(early.outbox, w.phone),
        capture(at, early.providers.clock.now()),
        photo,
      ),
    ).rejects.toMatchObject({ code: "offer_invalid" });
    expect((await rows(task_id)).map((r) => r.type)).toEqual(["escrow", "refund"]);
  });

  it("expireOverdue from 5 connections at once refunds each overdue task exactly once", async () => {
    const at = somewhere();
    await worker(north(at, 100));
    const a = await agent();
    const b = await agent();
    const ids = [
      (await ask(a, at, { deadline_minutes: 5 })).task_id,
      (await ask(a, at, { deadline_minutes: 5 })).task_id,
      (await ask(b, at, { deadline_minutes: 5 })).task_id,
    ];
    const runners = Array.from({ length: 5 }, () => make());
    const when = new Date(providers.clock.now().getTime() + 6 * 60_000);
    for (const r of runners) r.providers.clock.set(when);
    const [{ n: due }] = await sql<
      [{ n: number }]
    >`select count(*)::int as n from tasks where status in ('dispatched','claimed') and deadline_at <= ${when}`;
    const runs = await Promise.all(runners.map((r) => r.service.expireOverdue()));
    expect(runs.reduce((s, r) => s + r.expired, 0)).toBe(due);
    expect(await runners[0]?.service.expireOverdue()).toEqual({ expired: 0 });
    for (const id of ids) {
      expect((await task(id)).status).toBe("expired");
      expect((await rows(id)).filter((r) => r.type === "refund")).toHaveLength(1);
    }
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 20, escrowed_usd: 0 });
    expect(await service.getBalance(b)).toMatchObject({ balance_usd: 20, escrowed_usd: 0 });
  });

  it("cancelTask racing a YES in both lock orders moves money once", async () => {
    for (const cancelFirst of [true, false]) {
      const at = somewhere();
      const w = await worker(north(at, 100));
      const a = await agent();
      const { task_id } = await ask(a, at);
      let race: Promise<PromiseSettledResult<unknown>[]> = Promise.resolve([]);
      await sql.begin(async (tx) => {
        await tx`select id from tasks where id = ${task_id} for update`;
        const first = cancelFirst ? service.cancelTask(a, { task_id }) : yes(w.phone);
        await untilWaiting(cancelFirst ? "eyes_cancel_task" : "eyes_claim", 1);
        const second = cancelFirst ? yes(w.phone) : service.cancelTask(a, { task_id });
        await untilWaiting(cancelFirst ? "eyes_claim" : "eyes_cancel_task", 1);
        race = Promise.allSettled([first, second]);
      });
      const settled = await race;
      const t = await task(task_id);
      const links = outbox.filter((m) => m.to === w.phone && m.kind === "capture_link");
      if (cancelFirst) {
        expect(t.status).toBe("refunded");
        expect(links).toHaveLength(0);
        expect(lastText(main, w.phone)).toContain(NO_OPEN_TASK);
      } else {
        expect(t.status).toBe("claimed");
        expect(links).toHaveLength(1);
        expect(settled[1]).toMatchObject({ status: "rejected", reason: { code: "task_not_cancellable" } });
      }
    }
  });

  it("10 concurrent ask_eyes retries with one idempotency_key: one task, one escrow, one round of texts", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const a = await agent();
    const key = randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => ask(a, at, { idempotency_key: key })),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(new Set(ok.map((r) => r.task_id)).size).toBe(1);
    expect(await sql`select id from tasks where agent_id = ${a.id}`).toHaveLength(1);
    expect(outbox.filter((m) => m.to === w.phone && m.kind === "offer")).toHaveLength(1);
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 16.5, escrowed_usd: 3.5 });
  });

  it("5 different keys racing for the last dollars: one task, the rest insufficient_balance", async () => {
    const at = somewhere();
    await worker(north(at, 100));
    const a = await agent();
    await sql`update agents set balance_cents = 500 where id = ${a.id}`;
    await sql`update ledger set amount_cents = 500 where agent_id = ${a.id} and type = 'topup'`;
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => ask(a, at, { idempotency_key: randomUUID() })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(4);
    for (const r of rejected) expect(r.reason).toMatchObject({ code: "insufficient_balance" });
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 1.5, escrowed_usd: 3.5 });
  });

  it("daily cap: exactly the cap is allowed, one cent over is refused, concurrent asks respect it", async () => {
    const at = somewhere();
    await worker(north(at, 100));
    const a = await agent();
    await sql`update agents set daily_cap_cents = 700 where id = ${a.id}`;
    await ask(a, at);
    await expect(ask(a, at)).resolves.toMatchObject({ status: "dispatched" });
    await expect(ask(a, at, { bounty_usd: 1 })).rejects.toMatchObject({
      code: "daily_cap_exceeded",
      context: { remaining_today_usd: 0 },
    });

    const b = await agent();
    await sql`update agents set daily_cap_cents = 699 where id = ${b.id}`;
    await ask(b, at);
    await expect(ask(b, at)).rejects.toMatchObject({
      code: "daily_cap_exceeded",
      context: { remaining_today_usd: 3.49 },
    });

    const c = await agent();
    await sql`update agents set daily_cap_cents = 700 where id = ${c.id}`;
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => ask(c, at)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(await service.getSpendPolicy(c)).toMatchObject({ spent_today_usd: 7, remaining_today_usd: 0 });
  });

  it("the same capture submitted twice at once settles once: one release, fee, payout and paid text", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    await service.workerConnectUrl(w.connectToken);
    const a = await agent();
    const { task_id } = await ask(a, at);
    await yes(w.phone);
    const token = tokenOf(outbox, w.phone);
    let race: Promise<PromiseSettledResult<unknown>[]> = Promise.resolve([]);
    await sql.begin(async (tx) => {
      await tx`select id from tasks where id = ${task_id} for update`;
      race = Promise.allSettled([
        service.submitCapture(token, capture(at, providers.clock.now()), photo),
        service.submitCapture(token, capture(at, providers.clock.now()), photo),
      ]);
      await untilWaiting("eyes_submit", 2);
    });
    const settled = await race;
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(settled.find((s) => s.status === "rejected")).toMatchObject({ reason: { code: "offer_invalid" } });
    expect((await rows(task_id)).map((r) => r.type)).toEqual(["escrow", "fee", "payout", "release"]);
    expect(providers.payments.transfers.filter((t) => t.task_id === task_id)).toHaveLength(1);
    expect(outbox.filter((m) => m.to === w.phone && m.kind === "paid")).toHaveLength(1);
    expect(await sql`select id from submissions where task_id = ${task_id}`).toHaveLength(1);
  });

  it("a capture after the deadline is refused whether or not expiry has run", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const a = await agent();
    const { task_id, deadline_at } = await ask(a, at, { deadline_minutes: 5 });
    await yes(w.phone);
    const token = tokenOf(outbox, w.phone);
    const later = deadlineClock(deadline_at, 1000);
    await expect(
      later.service.submitCapture(token, capture(at, later.providers.clock.now()), photo),
    ).rejects.toMatchObject({ code: "offer_invalid" });
    expect((await task(task_id)).status).toBe("claimed");
    await later.service.expireOverdue();
    await expect(
      later.service.submitCapture(token, capture(at, later.providers.clock.now()), photo),
    ).rejects.toMatchObject({ code: "offer_invalid" });
    expect((await rows(task_id)).map((r) => r.type)).toEqual(["escrow", "refund"]);
  });

  it("a capture whose verification finishes after the deadline does not settle", async () => {
    const clockBox: { advance?: () => void } = {};
    const slow = make({
      verify: async () => {
        clockBox.advance?.();
        return PASS;
      },
    });
    const at = somewhere();
    const w = await worker(north(at, 100), slow);
    const a = await agent(slow);
    const { task_id, deadline_at } = await ask(a, at, { deadline_minutes: 5 }, slow);
    await yes(w.phone, slow);
    const token = tokenOf(slow.outbox, w.phone);
    slow.providers.clock.set(new Date(new Date(deadline_at).getTime() - 1000));
    clockBox.advance = () => slow.providers.clock.advance(60_000);
    await expect(
      slow.service.submitCapture(token, capture(at, slow.providers.clock.now()), photo),
    ).rejects.toMatchObject({ code: "offer_invalid" });
    expect((await task(task_id)).status).toBe("claimed");
    expect((await rows(task_id)).map((r) => r.type)).toEqual(["escrow"]);
  });

  it("a dispute between verified and paid holds the payout when onboarding finishes later", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const a = await agent();
    const { task_id } = await ask(a, at);
    await yes(w.phone);
    const token = tokenOf(outbox, w.phone);
    expect(await service.submitCapture(token, capture(at, providers.clock.now()), photo)).toMatchObject({
      status: "verified",
    });
    await service.disputeAnswer(a, { task_id, reason: "Photo is of a different store." });
    await service.workerConnectUrl(w.connectToken);
    await service.markWorkerOnboarded(`acct_fake_${w.worker_id}`);
    expect((await task(task_id)).status).toBe("disputed");
    expect((await rows(task_id)).filter((r) => r.type === "payout")).toHaveLength(0);
    expect(providers.payments.transfers.filter((t) => t.task_id === task_id)).toHaveLength(0);
    expect(outbox.filter((m) => m.to === w.phone && m.kind === "paid")).toHaveLength(0);
  });

  it("a dispute landing while a transfer is in flight keeps the task disputed and records the money that moved", async () => {
    const slowPay = make();
    const realPayout = slowPay.providers.payments.payoutWorker;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered: () => void = () => {};
    const inTransfer = new Promise<void>((r) => {
      entered = r;
    });
    slowPay.providers.payments.payoutWorker = async (i) => {
      entered();
      await gate;
      return realPayout(i);
    };
    const at = somewhere();
    const w = await worker(north(at, 100), slowPay);
    const a = await agent(slowPay);
    const { task_id } = await ask(a, at, {}, slowPay);
    await yes(w.phone, slowPay);
    await slowPay.service.submitCapture(
      tokenOf(slowPay.outbox, w.phone),
      capture(at, slowPay.providers.clock.now()),
      photo,
    );
    await slowPay.service.workerConnectUrl(w.connectToken);
    const onboard = slowPay.service.markWorkerOnboarded(`acct_fake_${w.worker_id}`);
    await inTransfer;
    const disputed = await slowPay.service.disputeAnswer(a, { task_id, reason: "wrong store" });
    expect(disputed.next_step).toContain("If the answer was fake, the full bounty and fee are refunded");
    release();
    await onboard;
    expect((await task(task_id)).status).toBe("disputed");
    expect((await rows(task_id)).filter((r) => r.type === "payout")).toHaveLength(1);
    expect(slowPay.outbox.filter((m) => m.kind === "paid")).toHaveLength(0);
  });

  it("a worker without Stripe is texted the payout link, then onboarding twice in sequence and 5 times at once pays once", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const a = await agent();
    const t1 = (await ask(a, at)).task_id;
    await yes(w.phone);
    const linksBefore = outbox.filter((m) => m.to === w.phone && String(m.payload).includes("/w/connect/"));
    const res = await service.submitCapture(
      tokenOf(outbox, w.phone),
      capture(at, providers.clock.now()),
      photo,
    );
    expect(res.status).toBe("verified");
    expect(res.message).not.toContain("/w/connect/");
    const linksAfter = outbox.filter((m) => m.to === w.phone && String(m.payload).includes("/w/connect/"));
    expect(linksAfter.length).toBe(linksBefore.length + 1);
    await service.retryPayouts();
    expect((await task(t1)).status).toBe("verified");
    await service.workerConnectUrl(w.connectToken);
    const account = `acct_fake_${w.worker_id}`;
    await service.markWorkerOnboarded(account);
    await service.markWorkerOnboarded(account);
    expect((await task(t1)).status).toBe("paid");
    expect((await rows(t1)).filter((r) => r.type === "payout")).toHaveLength(1);

    const at2 = somewhere();
    const w2 = await worker(north(at2, 100));
    const t2 = (await ask(a, at2)).task_id;
    await yes(w2.phone);
    await service.submitCapture(tokenOf(outbox, w2.phone), capture(at2, providers.clock.now()), photo);
    await service.workerConnectUrl(w2.connectToken);
    await Promise.all(
      Array.from({ length: 5 }, () => service.markWorkerOnboarded(`acct_fake_${w2.worker_id}`)),
    );
    expect((await rows(t2)).filter((r) => r.type === "payout")).toHaveLength(1);
    expect(outbox.filter((m) => m.to === w2.phone && m.kind === "paid")).toHaveLength(1);
  });

  it("awaitAnswer times out near timeout_seconds, returns fast on abort, and wakes on an answer", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const a = await agent();
    const { task_id } = await ask(a, at);

    let t0 = Date.now();
    const timedOut = await service.awaitAnswer(a, { task_id, timeout_seconds: 1 });
    const timeoutMs = Date.now() - t0;
    expect(timedOut).toMatchObject({ status: "dispatched", answered: false, answer: null });
    expect(timeoutMs).toBeGreaterThanOrEqual(950);
    expect(timeoutMs).toBeLessThan(2500);

    const ac = new AbortController();
    t0 = Date.now();
    setTimeout(() => ac.abort(), 200);
    expect(await service.awaitAnswer(a, { task_id, timeout_seconds: 50 }, ac.signal)).toMatchObject({
      answered: false,
    });
    expect(Date.now() - t0).toBeLessThan(1500);

    t0 = Date.now();
    await service.awaitAnswer(a, { task_id, timeout_seconds: 50 }, AbortSignal.abort());
    expect(Date.now() - t0).toBeLessThan(500);

    await expect(service.awaitAnswer(a, { task_id, timeout_seconds: 56 })).rejects.toMatchObject({
      code: "invalid_input",
    });

    t0 = Date.now();
    const pending = service.awaitAnswer(a, { task_id, timeout_seconds: 20 });
    await sleep(300);
    await yes(w.phone);
    await service.submitCapture(tokenOf(outbox, w.phone), capture(at, providers.clock.now()), photo);
    expect(await pending).toMatchObject({ answered: true, status: "verified" });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("cancel of a claimed task is refused and leaves money untouched", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const a = await agent();
    const { task_id } = await ask(a, at);
    await yes(w.phone);
    await expect(service.cancelTask(a, { task_id })).rejects.toMatchObject({ code: "task_not_cancellable" });
    expect((await rows(task_id)).map((r) => r.type)).toEqual(["escrow"]);
  });

  it("concurrent top-up webhook redelivery credits once", async () => {
    const a = await agent();
    const ref = `cs_${randomUUID()}`;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        service.creditTopup({ agent_id: a.id, amount_cents: 1000, stripe_ref: ref }),
      ),
    );
    expect(await service.getBalance(a)).toMatchObject({ balance_usd: 30 });
  });

  it("a worker who texted STOP cannot claim and is not texted again", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const a = await agent();
    const { task_id } = await ask(a, at);
    await service.handleWorkerReply({ phone: w.phone, intent: "stop", text: "STOP" });
    const sentBefore = outbox.length;
    await yes(w.phone);
    expect(await task(task_id)).toEqual({ status: "dispatched", claimed_by: null });
    expect(outbox.slice(sentBefore).filter((m) => m.to === w.phone)).toEqual([]);
  });

  it("another agent cannot cancel or dispute my task, and a dispatched task cannot be disputed", async () => {
    const at = somewhere();
    await worker(north(at, 100));
    const a = await agent();
    const b = await agent();
    const { task_id } = await ask(a, at);
    await expect(service.cancelTask(b, { task_id })).rejects.toMatchObject({ code: "task_not_found" });
    await expect(service.disputeAnswer(b, { task_id, reason: "mine now" })).rejects.toMatchObject({
      code: "task_not_found",
    });
    await expect(service.disputeAnswer(a, { task_id, reason: "too early" })).rejects.toMatchObject({
      code: "task_not_disputable",
    });
    expect((await task(task_id)).status).toBe("dispatched");
    expect(await service.getBalance(b)).toMatchObject({ balance_usd: 20 });
  });

  it("expiry landing while a capture is being verified: the capture is refused and the escrow moves once", async () => {
    const hook: { during?: () => Promise<unknown> } = {};
    const svc = make({
      verify: async () => {
        await hook.during?.();
        return PASS;
      },
    });
    const at = somewhere();
    const w = await worker(north(at, 100), svc);
    const a = await agent(svc);
    const { task_id, deadline_at } = await ask(a, at, { deadline_minutes: 5 }, svc);
    await yes(w.phone, svc);
    const token = tokenOf(svc.outbox, w.phone);
    hook.during = () => deadlineClock(deadline_at, 0).service.expireOverdue();
    await expect(
      svc.service.submitCapture(token, capture(at, svc.providers.clock.now()), photo),
    ).rejects.toMatchObject({ code: "offer_invalid" });
    expect((await rows(task_id)).map((r) => r.type)).toEqual(["escrow", "refund"]);
    expect((await task(task_id)).status).toBe("expired");
  });

  it("a capture that loses to a NO during verification deletes its uploaded photo and is refused as before", async () => {
    const hook: { during?: () => Promise<unknown> } = {};
    const svc = make({
      verify: async () => {
        await hook.during?.();
        return PASS;
      },
    });
    const remove = vi.spyOn(svc.providers.storage, "deletePhoto");
    for (const sent of [photo, null]) {
      const at = somewhere();
      const w = await worker(north(at, 100), svc);
      const a = await agent(svc);
      const { task_id } = await ask(a, at, { require_photo: sent !== null }, svc);
      await yes(w.phone, svc);
      hook.during = () => svc.service.handleWorkerReply({ phone: w.phone, intent: "no", text: "NO" });
      await expect(
        svc.service.submitCapture(tokenOf(svc.outbox, w.phone), capture(at, svc.providers.clock.now()), sent),
      ).rejects.toMatchObject({ code: "task_already_claimed" });
      expect((await task(task_id)).status).toBe("dispatched");
    }
    expect(remove).toHaveBeenCalledOnce();
    expect(svc.providers.storage.objects.size).toBe(0);
  });

  it("a capture that fails verification goes to needs_review with escrow held", async () => {
    const svc = make({
      verify: async () => ({ ...PASS, vision_ok: false, auto_approve: false, vision_reason: "blurry" }),
    });
    const at = somewhere();
    const w = await worker(north(at, 100), svc);
    await svc.service.workerConnectUrl(w.connectToken);
    const a = await agent(svc);
    const { task_id } = await ask(a, at, {}, svc);
    await yes(w.phone, svc);
    const res = await svc.service.submitCapture(
      tokenOf(svc.outbox, w.phone),
      capture(at, svc.providers.clock.now()),
      photo,
    );
    expect(res.status).toBe("needs_review");
    expect((await rows(task_id)).map((r) => r.type)).toEqual(["escrow"]);
    expect(svc.providers.payments.transfers).toHaveLength(0);
    expect(await svc.service.getBalance(a)).toMatchObject({ balance_usd: 16.5, escrowed_usd: 3.5 });
  });

  it("an opted-in but unavailable worker cannot claim (the SQL guard on its own)", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const a = await agent();
    const { task_id } = await ask(a, at);
    await sql`update workers set available = false where id = ${w.worker_id}`;
    await yes(w.phone);
    expect(await task(task_id)).toEqual({ status: "dispatched", claimed_by: null });
  });

  it("a worker who never sent START gets no text for anything but START", async () => {
    const phone = `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;
    await service.joinWorker({ name: "Worker", phone, ...somewhere() });
    const before = outbox.length;
    for (const intent of ["yes", "no", "help", "unknown", "stop"] as const) {
      await service.handleWorkerReply({ phone, intent, text: intent });
    }
    expect(outbox.slice(before).filter((m) => m.to === phone)).toEqual([]);
    await service.handleWorkerReply({ phone, intent: "start", text: "START" });
    expect(welcomeText(main, phone)).toContain("/w/connect/");
  });

  it("a capture at exactly deadline_at does not settle", async () => {
    const edge = make({ verify: async () => PASS });
    const at = somewhere();
    const w = await worker(north(at, 100), edge);
    const a = await agent(edge);
    const { task_id, deadline_at } = await ask(a, at, { deadline_minutes: 5 }, edge);
    await yes(w.phone, edge);
    const atDeadline = make({
      verify: async () => {
        atDeadline.providers.clock.set(new Date(deadline_at));
        return PASS;
      },
    });
    atDeadline.providers.clock.set(new Date(new Date(deadline_at).getTime() - 1000));
    await expect(
      atDeadline.service.submitCapture(
        tokenOf(edge.outbox, w.phone),
        capture(at, atDeadline.providers.clock.now()),
        photo,
      ),
    ).rejects.toMatchObject({ code: "offer_invalid" });
    expect((await task(task_id)).status).toBe("claimed");
    expect((await rows(task_id)).map((r) => r.type)).toEqual(["escrow"]);
  });

  it("the same worker's YES delivered twice at once resends the same link and never says already claimed", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const a = await agent();
    const { task_id } = await ask(a, at);
    let race: Promise<unknown> = Promise.resolve();
    await sql.begin(async (tx) => {
      await tx`select id from tasks where id = ${task_id} for update`;
      race = Promise.all([yes(w.phone), yes(w.phone)]);
      await untilWaiting("eyes_claim", 2);
    });
    await race;
    const mine = outbox.filter((m) => m.to === w.phone && m.kind !== "text" && m.kind !== "offer");
    expect(mine.map((m) => m.kind)).toEqual(["capture_link", "capture_link"]);
    expect(mine[0]?.payload.capture_url).toBe(mine[1]?.payload.capture_url);
    expect(await task(task_id)).toEqual({ status: "claimed", claimed_by: w.worker_id });
  });

  it("a failed transfer for an onboarded worker says the payout will be retried and sends no setup link", async () => {
    const down = make();
    down.providers.payments.payoutWorker = async () => {
      throw new Error("stripe down");
    };
    const at = somewhere();
    const w = await worker(north(at, 100), down);
    await down.service.workerConnectUrl(w.connectToken);
    const a = await agent(down);
    const { task_id } = await ask(a, at, {}, down);
    await yes(w.phone, down);
    const sent = down.outbox.length;
    const res = await down.service.submitCapture(
      tokenOf(down.outbox, w.phone),
      capture(at, down.providers.clock.now()),
      photo,
    );
    expect(res.status).toBe("verified");
    expect(res.message).toContain("retried");
    expect(down.outbox.slice(sent)).toEqual([]);
    expect((await rows(task_id)).map((r) => r.type)).toEqual(["escrow", "fee", "release"]);
  });

  const REVIEW = async () => ({ ...PASS, vision_ok: false, auto_approve: false, vision_reason: "blurry" });
  const STRIPE_DOWN = async (): Promise<never> => {
    throw new Error("balance_insufficient");
  };

  async function captured(env: Env, connect = true, beforeCapture = async (_phone: string) => {}) {
    const at = somewhere();
    const w = await worker(north(at, 100), env);
    if (connect) await env.service.workerConnectUrl(w.connectToken);
    const a = await agent(env);
    const { task_id } = await ask(a, at, {}, env);
    await yes(w.phone, env);
    await beforeCapture(w.phone);
    const res = await env.service.submitCapture(
      tokenOf(env.outbox, w.phone),
      capture(at, env.providers.clock.now()),
      photo,
    );
    return { a, w, task_id, res };
  }
  const transfersFor = (env: Env, taskId: string) =>
    env.providers.payments.transfers.filter((t) => t.task_id === taskId);
  const paidTexts = (env: Env, phone: string) =>
    env.outbox.filter((m) => m.to === phone && m.kind === "paid");

  function stripeLike(env: Env, refusals: number) {
    const real = env.providers.payments.payoutWorker;
    const results = new Map<string, Error | { transfer_id: string }>();
    const keys: string[] = [];
    env.providers.payments.payoutWorker = async (i) => {
      keys.push(i.idempotency_key);
      await sleep(randomInt(4));
      const out =
        results.get(i.idempotency_key) ??
        (refusals-- > 0 ? new Error("balance_insufficient: platform balance too low") : await real(i));
      results.set(i.idempotency_key, out);
      if (out instanceof Error) throw out;
      return out;
    };
    return keys;
  }
  const leaseTakenAgo = (taskId: string, age: string) => sql`
    update ledger set stripe_ref = format('payout:%s:%s', task_id,
      floor(extract(epoch from clock_timestamp() - ${age}::interval) * 1000000)::bigint)
    where task_id = ${taskId} and type = 'release'`;
  const keyOf = (taskId: string) => new RegExp(`^payout:${taskId}:\\d+$`);
  async function retryUntilPaid(env: Env, taskId: string) {
    for (let i = 0; i < 10 && (await task(taskId)).status === "verified"; i++)
      await env.service.retryPayouts();
  }

  it("a transfer Stripe refused is paid by the next retryPayouts under a new idempotency key, exactly once", async () => {
    const env = make();
    const keys = stripeLike(env, 1);
    const { w, task_id, res } = await captured(env);
    expect(res).toMatchObject({ status: "verified", message: expect.stringContaining("retried") });

    await retryUntilPaid(env, task_id);
    await env.service.retryPayouts();
    expect((await task(task_id)).status).toBe("paid");
    expect((await rows(task_id)).map((r) => r.type)).toEqual(["escrow", "fee", "payout", "release"]);
    expect(transfersFor(env, task_id)).toEqual([expect.objectContaining({ amount_cents: 300 })]);
    const mine = keys.filter((k) => k.includes(task_id));
    expect(mine).toEqual([expect.stringMatching(keyOf(task_id)), expect.stringMatching(keyOf(task_id))]);
    expect(mine[0]).not.toBe(mine[1]);
    expect(paidTexts(env, w.phone)).toHaveLength(1);
  });

  it("retryPayouts, onboarding webhooks and an operator release racing on two instances pay each task once", async () => {
    const A = make();
    const B = make();
    stripeLike(A, 0);
    const stripe = A.providers.payments;
    B.providers.payments.payoutWorker = (i) => stripe.payoutWorker(i);
    for (let rep = 0; rep < 10; rep++) {
      const real = stripe.payoutWorker;
      stripe.payoutWorker = STRIPE_DOWN;
      const { a, w, task_id } = await captured(A);
      stripe.payoutWorker = real;
      const account = `acct_fake_${w.worker_id}`;
      if (rep % 2) await A.service.disputeAnswer(a, { task_id, reason: "Wrong store." });
      await Promise.all([
        A.service.retryPayouts(),
        B.service.retryPayouts(),
        A.service.markWorkerOnboarded(account),
        B.service.markWorkerOnboarded(account),
        rep % 2 && B.service.resolveTask(task_id, "release", "Sign matches."),
      ]);
      await A.service.markWorkerOnboarded(account);
      expect((await task(task_id)).status).toBe("paid");
      expect((await rows(task_id)).filter((r) => r.type === "payout")).toHaveLength(1);
      expect(stripe.transfers.filter((t) => t.task_id === task_id)).toHaveLength(1);
      expect([...A.outbox, ...B.outbox].filter((m) => m.to === w.phone && m.kind === "paid")).toHaveLength(1);
    }
  });

  it("an attempt that died holding the payout lease blocks others for 15 minutes, then the task is paid", async () => {
    const env = make();
    const real = env.providers.payments.payoutWorker;
    env.providers.payments.payoutWorker = STRIPE_DOWN;
    const { w, task_id } = await captured(env);
    env.providers.payments.payoutWorker = real;
    const account = `acct_fake_${w.worker_id}`;

    await leaseTakenAgo(task_id, "14 minutes 50 seconds");
    await env.service.markWorkerOnboarded(account);
    expect((await task(task_id)).status).toBe("verified");
    expect(transfersFor(env, task_id)).toHaveLength(0);

    await leaseTakenAgo(task_id, "15 minutes");
    await env.service.markWorkerOnboarded(account);
    expect((await task(task_id)).status).toBe("paid");
    expect(transfersFor(env, task_id)).toHaveLength(1);
  });

  it("a transfer whose outcome is unknown keeps the lease, so the webhook cannot pay again before Stripe finishes", async () => {
    const env = make();
    const real = env.providers.payments.payoutWorker;
    let finished: { transfer_id: string } | undefined;
    let stripeStillRunning: Promise<void> | undefined;
    env.providers.payments.payoutWorker = async (i) => {
      if (finished) return finished;
      if (stripeStillRunning) return real(i);
      stripeStillRunning = sleep(50).then(async () => {
        finished = await real(i);
      });
      throw Object.assign(new Error("connection lost on all 3 tries"), { outcome_unknown: true });
    };
    const { w, task_id, res } = await captured(env);
    expect(res.status).toBe("verified");
    const account = `acct_fake_${w.worker_id}`;

    await env.service.markWorkerOnboarded(account);
    await stripeStillRunning;
    expect((await task(task_id)).status).toBe("verified");
    expect(transfersFor(env, task_id)).toHaveLength(1);

    await leaseTakenAgo(task_id, "15 minutes");
    await env.service.markWorkerOnboarded(account);
    expect((await task(task_id)).status).toBe("paid");
    expect(transfersFor(env, task_id)).toHaveLength(1);
    expect((await rows(task_id)).filter((r) => r.type === "payout")).toHaveLength(1);
    expect(paidTexts(env, w.phone)).toHaveLength(1);
  });

  it("30 tasks on an account that never finishes onboarding do not keep retryPayouts from a newer payable task", async () => {
    const env = make();
    const real = env.providers.payments.payoutWorker;
    const at = somewhere();
    const stuck = await worker(north(at, 100), env);
    await env.service.workerConnectUrl(stuck.connectToken);
    const stuckAccount = `acct_fake_${stuck.worker_id}`;
    env.providers.payments.payoutWorker = async (i) => {
      if (i.account_id === stuckAccount)
        throw new Error(`Stripe account ${i.account_id} cannot receive transfers yet`);
      return real(i);
    };
    const stuckTasks: string[] = [];
    for (let n = 0; n < 3; n++) {
      const a = await agent(env);
      for (let k = 0; k < 10; k++) {
        const { task_id } = await ask(a, at, { bounty_usd: 1 }, env);
        await yes(stuck.phone, env);
        await env.service.submitCapture(
          tokenOf(env.outbox, stuck.phone),
          capture(at, env.providers.clock.now()),
          photo,
        );
        stuckTasks.push(task_id);
      }
    }
    env.providers.clock.advance(60_000);
    const late = await captured(env, false);
    await env.service.workerConnectUrl(late.w.connectToken);
    expect((await task(late.task_id)).status).toBe("verified");

    await retryUntilPaid(env, late.task_id);
    expect((await task(late.task_id)).status).toBe("paid");
    for (const id of stuckTasks) expect((await task(id)).status).toBe("verified");

    env.providers.payments.payoutWorker = real;
    await env.service.markWorkerOnboarded(stuckAccount);
    for (const id of stuckTasks) expect((await task(id)).status).toBe("paid");
  }, 15_000);

  it("resolveTask refund returns a needs_review task's escrow to the agent and never pays the worker", async () => {
    const env = make({ verify: REVIEW });
    const { a, task_id } = await captured(env);
    expect(await env.service.resolveTask(task_id, "refund", "Photo shows a different store.")).toEqual({
      task_id,
      status: "refunded",
    });
    expect(await env.service.getBalance(a)).toMatchObject({ balance_usd: 20, escrowed_usd: 0 });
    await env.service.retryPayouts();
    await expect(env.service.resolveTask(task_id, "release", "Changed my mind.")).rejects.toMatchObject({
      code: "invalid_input",
      context: { status: "refunded" },
    });
    expect((await rows(task_id)).map((r) => r.type)).toEqual(["escrow", "refund"]);
    expect(transfersFor(env, task_id)).toHaveLength(0);
  });

  it("resolveTask release pays a disputed needs_review task through the normal payout path and keeps the note", async () => {
    const env = make({ verify: REVIEW });
    const { a, w, task_id } = await captured(env);
    await env.service.disputeAnswer(a, { task_id, reason: "Too blurry to read." });
    expect(await env.service.resolveTask(task_id, "release", "Line is visible when zoomed.")).toEqual({
      task_id,
      status: "paid",
    });
    expect((await rows(task_id)).map((r) => r.type)).toEqual(["escrow", "fee", "payout", "release"]);
    expect(transfersFor(env, task_id)).toEqual([
      expect.objectContaining({ idempotency_key: expect.stringMatching(keyOf(task_id)) }),
    ]);
    expect(paidTexts(env, w.phone)).toHaveLength(1);
    expect(await env.service.getBalance(a)).toMatchObject({ balance_usd: 16.5, escrowed_usd: 0 });
    expect((await sql`select dispute_reason from tasks where id = ${task_id}`)[0]?.dispute_reason).toBe(
      "Too blurry to read.\nresolved release: Line is visible when zoomed.",
    );
    await expect(env.service.resolveTask(task_id, "refund", "Again.")).rejects.toMatchObject({
      code: "invalid_input",
      context: { status: "paid" },
    });
  });

  it("refund and release racing on one needs_review task (forced on the row lock): one wins, money moves once", async () => {
    const env = make({ verify: REVIEW });
    const { task_id } = await captured(env);
    let race: Promise<PromiseSettledResult<unknown>[]> = Promise.resolve([]);
    await sql.begin(async (tx) => {
      await tx`select id from tasks where id = ${task_id} for update`;
      race = Promise.allSettled([
        env.service.resolveTask(task_id, "refund", "Operator A."),
        env.service.resolveTask(task_id, "release", "Operator B."),
      ]);
      await untilWaiting("eyes_resolve_task", 2);
    });
    const settled = await race;
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(settled.find((s) => s.status === "rejected")).toMatchObject({ reason: { code: "invalid_input" } });
    expect(["refunded", "paid"]).toContain((await task(task_id)).status);
  });

  it("resolveTask refuses unknown tasks, tasks not under review, and a refund once the bounty was released", async () => {
    const env = make();
    const real = env.providers.payments.payoutWorker;
    await expect(env.service.resolveTask(randomUUID(), "refund", "Note.")).rejects.toMatchObject({
      code: "task_not_found",
    });
    env.providers.payments.payoutWorker = STRIPE_DOWN;
    const unpaid = await captured(env);
    env.providers.payments.payoutWorker = real;
    const paid = await captured(env);
    expect([unpaid.res.status, paid.res.status]).toEqual(["verified", "paid"]);

    for (const { a, task_id, res } of [unpaid, paid]) {
      await expect(env.service.resolveTask(task_id, "release", "Note.")).rejects.toMatchObject({
        code: "invalid_input",
        context: { status: res.status },
      });
      await env.service.disputeAnswer(a, { task_id, reason: "Wrong store." });
      await expect(env.service.resolveTask(task_id, "refund", "Agent is right.")).rejects.toMatchObject({
        code: "invalid_input",
        context: { status: "disputed" },
      });
      expect(await env.service.resolveTask(task_id, "release", "Store sign matches.")).toEqual({
        task_id,
        status: "paid",
      });
    }
    for (const { w, task_id } of [unpaid, paid]) {
      expect(transfersFor(env, task_id)).toHaveLength(1);
      expect(paidTexts(env, w.phone)).toHaveLength(1);
    }
  });

  it("one failed paid text does not stop the rest of a retryPayouts batch", async () => {
    const env = make();
    const real = env.providers.payments.payoutWorker;
    env.providers.payments.payoutWorker = STRIPE_DOWN;
    const first = await captured(env);
    const second = await captured(env);
    env.providers.payments.payoutWorker = real;
    const sendPaid = env.providers.messaging.sendPaid;
    let failed = false;
    env.providers.messaging.sendPaid = async (to, msg) => {
      if (failed) return sendPaid(to, msg);
      failed = true;
      throw new Error("inkbox down");
    };

    await env.service.retryPayouts();
    for (const { task_id } of [first, second]) {
      expect((await task(task_id)).status).toBe("paid");
      expect(transfersFor(env, task_id)).toHaveLength(1);
    }
  });

  it("a worker who texted STOP is paid without texts, and the capture page shows the payout setup link instead", async () => {
    const env = make();
    const stop = (phone: string) => env.service.handleWorkerReply({ phone, intent: "stop", text: "STOP" });
    const onboarded = await captured(env, true, stop);
    const unconnected = await captured(env, false, stop);
    expect([onboarded.res.status, unconnected.res.status]).toEqual(["paid", "verified"]);
    expect((await rows(onboarded.task_id)).map((r) => r.type)).toEqual([
      "escrow",
      "fee",
      "payout",
      "release",
    ]);
    for (const { w } of [onboarded, unconnected]) {
      expect(
        env.outbox.filter(
          (m) => m.to === w.phone && (m.kind === "paid" || String(m.payload).includes("is waiting")),
        ),
      ).toEqual([]);
    }
    expect(unconnected.res.message).not.toContain("texted");
    const link = unconnected.res.message.split("set up payouts here: ")[1] ?? "";
    expect(link).toMatch(/^https:\/\/api\.eyes\.test\/w\/connect\//);
    expect(await env.service.workerConnectUrl(link.split("/w/connect/")[1] ?? "")).toBe(
      `https://connect.fake.test/onboard/acct_fake_${unconnected.w.worker_id}`,
    );
  });

  it("a paid or payout setup text that fails after verification never fails the capture or the payout", async () => {
    const env = make();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const refuse = async (to: string): Promise<never> => {
      throw new Error(`403 recipient_opted_out ${to}`);
    };
    const inkboxDown = async () => {
      env.providers.messaging.sendPaid = refuse;
      env.providers.messaging.sendText = refuse;
    };
    const { sendPaid, sendText } = env.providers.messaging;
    try {
      const onboarded = await captured(env, true, inkboxDown);
      Object.assign(env.providers.messaging, { sendPaid, sendText });
      const unconnected = await captured(env, false, inkboxDown);
      expect([onboarded.res.status, unconnected.res.status]).toEqual(["paid", "verified"]);
      expect(transfersFor(env, onboarded.task_id)).toHaveLength(1);
      const logged = error.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain(onboarded.task_id);
      expect(logged).toContain(unconnected.task_id);
      for (const { w } of [onboarded, unconnected]) expect(logged).not.toContain(w.phone);
    } finally {
      Object.assign(env.providers.messaging, { sendPaid, sendText });
      error.mockRestore();
    }
  });
});
