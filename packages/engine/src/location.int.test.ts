import { randomInt, randomUUID } from "node:crypto";
import {
  type Agent,
  AppConfig,
  type EngineDeps,
  type EyesError,
  fakeProviders,
  type LatLng,
  type SafetyVerdict,
  signToken,
} from "@eyes/core";
import { migrate } from "@eyes/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEyesService } from "./index.ts";

const url = process.env.DATABASE_URL;
const SECRET = "test-link-secret-0123456789";
const ALLOW: SafetyVerdict = { allowed: true, category: null, reason: null, fix: null, layer: null };
const HOUR = 3_600_000;

describe.skipIf(!url)("worker location on Postgres", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const providers = fakeProviders();
  const outbox = providers.messaging.outbox as { to: string; kind: string; payload: unknown }[];
  const make = (extra: Record<string, unknown> = {}) => {
    const deps: EngineDeps = {
      db: { kind: "postgres", url: url ?? "" },
      providers,
      assessTask: async () => ALLOW,
      verifySubmission: async () => ({
        gps_ok: true,
        fresh_ok: true,
        vision_ok: true,
        vision_reason: "ok",
        confidence: 0.9,
        auto_approve: true,
        worker_distance_m: 0,
      }),
      config: AppConfig.parse({
        public_api_url: "https://api.eyes.test",
        worker_web_url: "https://w.eyes.test",
        link_secret: SECRET,
        ...extra,
      }),
    };
    return createEyesService(deps);
  };
  const service = make();
  const pinging = make({ location_ping: true });

  beforeAll(() => migrate(url ?? ""));
  afterAll(() => sql.end());

  const somewhere = (): LatLng => ({ lat: 10 + Math.random() * 40, lng: -120 + Math.random() * 60 });
  const north = (p: LatLng, meters: number): LatLng => ({ lat: p.lat + meters / 111_320, lng: p.lng });
  const lastText = (phone: string) => String(outbox.findLast((m) => m.to === phone)?.payload);
  const hereToken = (text: string) =>
    new URL(/https:\S+here\.html\S+/.exec(text)?.[0] ?? "x:").searchParams.get("t") ?? "";
  const welcome = (phone: string) =>
    String(outbox.findLast((m) => m.to === phone && String(m.payload).startsWith("You're in."))?.payload);
  const row = async (phone: string) => (await sql`select * from workers where phone = ${phone}`)[0];

  async function worker(at: LatLng) {
    const phone = `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;
    await service.joinWorker({ name: "Test Worker", phone, ...at });
    await service.handleWorkerReply({ phone, intent: "start", text: "START" });
    return { phone, id: String((await row(phone))?.id) };
  }
  const say = (
    phone: string,
    intent: "here" | "shortcut" | "app" | "location_share" | "stop" | "start" | "unknown",
    text = "",
  ) => service.handleWorkerReply({ phone, intent, text });
  const code = async (err: Promise<unknown>) => ((await err.catch((e) => e)) as EyesError).code;

  async function agent() {
    const { api_key } = await service.signupAgent({ name: "location-agent" });
    return (await service.authenticate(api_key)) as Agent;
  }
  const ask = (svc: typeof service, a: Agent, at: LatLng) =>
    svc.askEyes(a, {
      question: "Is it open?",
      location: at,
      task_type: "is_open",
      bounty_usd: 3,
      deadline_minutes: 30,
      require_photo: false,
      idempotency_key: randomUUID(),
    });

  it("HERE texts a 30-minute link whose fix is stored, rate limited, and never older than now", async () => {
    const w = await worker(somewhere());
    await say(w.phone, "here", "HERE");
    const token = hereToken(lastText(w.phone));
    expect(lastText(w.phone)).toContain("https://w.eyes.test/here.html?t=");
    const fix = { lat: "37,761", lng: "-122.386", accuracy_m: 9, source: "here_link" as const };
    await service.updateWorkerLocation(token, {
      ...fix,
      captured_at: new Date(Date.now() + HOUR).toISOString(),
    });
    expect(await row(w.phone)).toMatchObject({
      lat: 37.761,
      lng: -122.386,
      location_accuracy_m: 9,
      location_source: "here_link",
    });
    expect((await row(w.phone))?.location_at.getTime()).toBeLessThanOrEqual(providers.clock.now().getTime());
    expect(await code(service.updateWorkerLocation(token, fix))).toBe("rate_limited");
    providers.clock.advance(31_000);
    await service.updateWorkerLocation(token, { ...fix, lat: 37.7 });
    expect((await row(w.phone))?.lat).toBe(37.7);
    providers.clock.advance(30 * 60_000);
    expect(await code(service.updateWorkerLocation(token, fix))).toBe("unauthorized");
  });

  it("rejects a signed token of another kind, a made-up code, and bad coordinates", async () => {
    const w = await worker(somewhere());
    const fix = { lat: 37.7, lng: -122.4, source: "shortcut" as const };
    expect(await code(service.updateWorkerLocation(signToken(SECRET, `e:${w.id}`), fix))).toBe(
      "unauthorized",
    );
    expect(await code(service.updateWorkerLocation("not-a-code", fix))).toBe("unauthorized");
    await say(w.phone, "here");
    const token = hereToken(lastText(w.phone));
    expect(await code(service.updateWorkerLocation(token, { ...fix, lat: 0, lng: 0 }))).toBe("invalid_input");
    expect(await code(service.updateWorkerLocation(token, { ...fix, lat: 95 }))).toBe("invalid_input");
  });

  it("a texted map link stores the fix as map_link; a short link gets a HERE link instead", async () => {
    const w = await worker(somewhere());
    await say(w.phone, "unknown", "Here: https://maps.apple.com/?address=Somewhere&ll=37.761%2C-122.386");
    expect(lastText(w.phone)).toBe("Spot updated: near 37.76, -122.39.");
    expect(await row(w.phone)).toMatchObject({ lat: 37.761, lng: -122.386, location_source: "map_link" });
    await say(w.phone, "unknown", "https://www.google.com/maps/@40.7,-74,15z");
    expect(lastText(w.phone)).toContain("seconds ago");
    expect((await row(w.phone))?.lat).toBe(37.761);
    providers.clock.advance(31_000);
    await say(w.phone, "unknown", "https://maps.app.goo.gl/AbCdEf123");
    expect(lastText(w.phone)).toContain("https://w.eyes.test/here.html?t=");
    expect((await row(w.phone))?.lat).toBe(37.761);
  });

  it("SHORTCUT adds a code per device, keeps the 5 newest, and STOP deletes the fix and every code", async () => {
    const w = await worker(somewhere());
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) {
      await say(w.phone, "shortcut", "SHORTCUT");
      codes.push(lastText(w.phone));
    }
    expect(codes[0]).not.toContain(" ");
    const fix = { lat: "40,7", lng: "-74", source: "shortcut" as const };
    // Two devices with different codes both store fixes.
    await service.updateWorkerLocation(codes[1] ?? "", fix);
    providers.clock.advance(31_000);
    await service.updateWorkerLocation(codes[5] ?? "", { ...fix, lat: "40,8" });
    expect(await row(w.phone)).toMatchObject({ lat: 40.8, location_source: "shortcut" });
    // The 6th code evicted the oldest.
    expect(await code(service.updateWorkerLocation(codes[0] ?? "", fix))).toBe("unauthorized");
    const codesLeft = async () =>
      (await sql`select count(*)::int as n from worker_location_tokens where worker_id = ${w.id}`)[0]?.n;
    expect(await codesLeft()).toBe(5);

    await say(w.phone, "stop", "STOP");
    expect(await row(w.phone)).toMatchObject({ lat: null, lng: null, location_at: null });
    expect(await codesLeft()).toBe(0);
    providers.clock.advance(31_000);
    for (const c of codes.slice(1))
      expect(await code(service.updateWorkerLocation(c, fix))).toBe("unauthorized");
    await say(w.phone, "start", "START");
    // One text. STOP deleted every code, so this START sends a fresh app link even within the hour.
    expect(lastText(w.phone).split("\n").slice(1, 3)).toEqual([
      expect.stringMatching(
        /^1\. Get the app \(keeps your spot fresh\): https:\/\/w\.eyes\.test\/install#c=[\w-]{43}$/,
      ),
      expect.stringMatching(/^2\. Update your spot: https:\/\/w\.eyes\.test\/here\.html\?t=/),
    ]);
  });

  it("START texts the app link with a fresh code in the fragment, once per hour; APP always mints", async () => {
    const appCode = (text: string) => /\/install#c=([\w-]{43})/.exec(text)?.[1] ?? "";
    const w = await worker(somewhere());
    const first = appCode(lastText(w.phone));
    expect(first).not.toBe("");
    expect(lastText(w.phone)).not.toMatch(/[?&]c=/); // the code is only ever in a fragment
    // The code in the link works as a location code.
    await service.updateWorkerLocation(first, { lat: 37.7, lng: -122.4, source: "app" });
    expect(await row(w.phone)).toMatchObject({ lat: 37.7, location_source: "app" });
    const sent = () => outbox.filter((m) => m.to === w.phone).length;
    const codes = async () =>
      (await sql`select count(*)::int as n from worker_location_tokens where worker_id = ${w.id}`)[0]?.n;
    expect(await codes()).toBe(1);

    // START again within the hour: the welcome text only, no new code.
    const before = sent();
    await say(w.phone, "start", "START");
    expect(sent()).toBe(before + 1);
    expect(lastText(w.phone)).toContain("You're in.");
    expect(await codes()).toBe(1);

    // APP mints even within the hour, as one text.
    await say(w.phone, "app", "APP");
    const second = appCode(lastText(w.phone));
    expect(second).not.toBe("");
    expect(second).not.toBe(first);
    expect(sent()).toBe(before + 2);
    expect(await codes()).toBe(2);

    // An hour after the last link, START sends a new one.
    providers.clock.advance(61 * 60_000);
    await say(w.phone, "start", "START");
    expect(appCode(lastText(w.phone))).not.toBe("");
    expect(await codes()).toBe(3);
  });

  it("finds the worker by any stored code hash and records when it was last used", async () => {
    const w = await worker(somewhere());
    const legacy = `another-device-${randomUUID()}`;
    await sql`insert into worker_location_tokens (token_hash, worker_id)
      values (encode(sha256(${legacy}::bytea), 'hex'), ${w.id})`;
    await service.updateWorkerLocation(legacy, { lat: 37.7, lng: -122.4, source: "shortcut" });
    const [t] = await sql`select last_used_at from worker_location_tokens
      where token_hash = encode(sha256(${legacy}::bytea), 'hex')`;
    expect(t?.last_used_at).not.toBeNull();
  });

  it("AUTO, like SHORTCUT, links the automation steps and then texts the code alone", async () => {
    const w = await worker(somewhere());
    await say(w.phone, "shortcut", "AUTO");
    const texts = outbox.filter((m) => m.to === w.phone).map((m) => String(m.payload));
    expect(texts.at(-2)).toContain("/automation.html");
    expect(texts.at(-1)).not.toContain(" ");
  });

  it("stores a fix from the iOS app as source app (migration 020)", async () => {
    const w = await worker(somewhere());
    await say(w.phone, "shortcut", "AUTO");
    await service.updateWorkerLocation(lastText(w.phone), { lat: 37.7, lng: -122.4, source: "app" });
    expect(await row(w.phone)).toMatchObject({ lat: 37.7, location_source: "app" });
  });

  it("answers an Apple location share with a HERE link instead of 'did not get that'", async () => {
    const w = await worker(somewhere());
    await say(w.phone, "location_share", "\ufffd");
    expect(lastText(w.phone)).toMatch(
      /^Thanks! iMessage locations don't reach us, so tap this to update your spot: https:\/\/w\.eyes\.test\/here\.html\?t=/,
    );
  });

  it("caps fixes per day and lets a fix every minute through all day", async () => {
    const svc = make({ location_daily_max: 3 });
    const w = await worker(somewhere());
    await say(w.phone, "here");
    const fix = { lat: 37.7, lng: -122.4, source: "here_link" as const };
    for (let i = 0; i < 3; i++) {
      await svc.updateWorkerLocation(hereToken(lastText(w.phone)), fix);
      providers.clock.advance(60_000);
    }
    expect(await code(svc.updateWorkerLocation(hereToken(lastText(w.phone)), fix))).toBe("rate_limited");
    providers.clock.advance(24 * HOUR);
    await say(w.phone, "here");
    await svc.updateWorkerLocation(hereToken(lastText(w.phone)), fix);
  });

  it("dispatches only to workers with a fresh fix, and a new fix makes a worker fresh at once", async () => {
    const at = somewhere();
    const a = await agent();
    const w = await worker(north(at, 100));
    providers.clock.advance(25 * HOUR);
    await say(w.phone, "start", "START");
    expect(welcome(w.phone)).toContain("/here.html?t=");
    expect(await code(ask(service, a, at))).toBe("no_workers_nearby");
    await service.updateWorkerLocation(hereToken(welcome(w.phone)), {
      ...north(at, 50),
      source: "here_link",
    });
    expect(await ask(service, a, at)).toMatchObject({ workers_notified: 1 });
    await say(w.phone, "start", "START");
    expect(welcome(w.phone)).not.toContain("/here.html");
  });

  it("a submitted capture updates the worker's fix", async () => {
    const at = somewhere();
    const w = await worker(north(at, 100));
    const asked = await ask(service, await agent(), at);
    await service.handleWorkerReply({ phone: w.phone, intent: "yes", text: "YES" });
    const link = outbox.findLast((m) => m.to === w.phone && m.kind === "capture_link")?.payload as {
      capture_url: string;
    };
    const token = new URL(link.capture_url).searchParams.get("t") ?? "";
    providers.clock.advance(31_000);
    await service.submitCapture(
      token,
      {
        ...north(at, 5),
        accuracy_m: 6,
        captured_at: providers.clock.now().toISOString(),
        answer_text: "open",
        answer_bool: true,
      },
      null,
    );
    expect(await row(w.phone)).toMatchObject({
      lat: north(at, 5).lat,
      location_accuracy_m: 6,
      location_source: "capture",
    });
    expect(asked.status).toBe("dispatched");
  });

  it("pings the nearest stale workers only when EYES_LOCATION_PING is on, and marks the answered ping", async () => {
    const at = somewhere();
    const a = await agent();
    const stale = [await worker(north(at, 200)), await worker(north(at, 300))];
    providers.clock.advance(25 * HOUR);
    const fresh = await worker(north(at, 100));
    const pings = () =>
      outbox.filter((m) => stale.some((w) => w.phone === m.to) && /^Eyes ping /.test(String(m.payload)));

    const quiet = await ask(service, a, at);
    expect(quiet.workers_notified).toBe(1);
    expect(pings()).toHaveLength(0);

    const loud = await ask(pinging, a, at);
    expect(loud.workers_notified).toBe(1);
    expect(
      pings()
        .map((m) => m.to)
        .sort(),
    ).toEqual(stale.map((w) => w.phone).sort());
    const rows = await sql`select nonce, worker_id from worker_pings where task_id = ${loud.task_id}`;
    expect(rows).toHaveLength(2);

    const first = stale[0];
    const ping = rows.find((r) => r.worker_id === first?.id);
    const text = String(pings().find((m) => m.to === first?.phone)?.payload);
    await service.updateWorkerLocation(hereToken(text), {
      ...north(at, 150),
      source: "shortcut",
      input: `Eyes ping ${ping?.nonce}`,
    });
    const [answered] = await sql`select answered_at from worker_pings where nonce = ${ping?.nonce}`;
    expect(answered?.answered_at).not.toBeNull();

    // What the 30 s timer runs: the task goes to the now-fresh worker, up to dispatch_max_workers.
    const more =
      await sql`select * from eyes_offer_more(${loud.task_id}, 3000, 3, '24 hours', ${providers.clock.now().toISOString()})`;
    expect(more.map((r) => r.worker_id)).toEqual([first?.id]);
    expect(fresh.id).not.toBe(first?.id);

    expect(await ask(pinging, a, at)).toMatchObject({ workers_notified: 2 });
    expect(pings()).toHaveLength(2);
  });
  it("device: the code gets a 1-hour profile ticket; the ticket stores the UDID; ready after release; STOP deletes", async () => {
    const w = await worker(somewhere());
    await say(w.phone, "app", "APP");
    const appCode = /\/install#c=([\w-]{43})/.exec(lastText(w.phone))?.[1] ?? "";
    const first = await service.workerDevice(appCode);
    expect(first).toMatchObject({ registered: false, ready: false });
    const ticket = first.profile_url.replace("https://api.eyes.test/w/device/profile/", "");
    expect(ticket).not.toContain(appCode);
    const udid = `00008110-${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
    await service.addWorkerDevice(ticket, { udid, product: "iPhone18,1", version: "23F79" });
    await service.addWorkerDevice(ticket, { udid, product: "iPhone18,1", version: "23G5" });
    expect(await service.workerDevice(appCode)).toMatchObject({ registered: true, ready: false });
    await sql`update worker_devices set apple_registered_at = now(), released_at = now() where udid = ${udid}`;
    expect(await service.workerDevice(appCode)).toMatchObject({ registered: true, ready: true });
    expect((await sql`select os_version from worker_devices where udid = ${udid}`)[0]?.os_version).toBe(
      "23G5",
    );
    expect(await code(service.workerDevice("not-a-code"))).toBe("unauthorized");
    expect(
      await code(
        service.addWorkerDevice(signToken(SECRET, `l:${w.id}`), { udid, product: null, version: null }),
      ),
    ).toBe("unauthorized");
    providers.clock.advance(61 * 60_000);
    expect(await code(service.addWorkerDevice(ticket, { udid, product: null, version: null }))).toBe(
      "unauthorized",
    );
    await say(w.phone, "stop", "STOP");
    expect(await sql`select 1 from worker_devices where udid = ${udid}`).toHaveLength(0);
  });
});
