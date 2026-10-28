import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { AppConfig, fakeProviders, signToken } from "@eyes/core";
import { createRpc, migrate } from "@eyes/db";
import { createEyesService } from "@eyes/engine";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toNodeListener } from "./http.ts";
import { createServer } from "./server.ts";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("worker setup persistence over HTTP and Postgres", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const providers = fakeProviders();
  const config = AppConfig.parse({
    public_api_url: "http://api.eyes.test",
    worker_web_url: "http://worker.eyes.test",
    link_secret: "worker-setup-test-secret-0123456789",
    live_payouts: false,
  });
  const db = { kind: "postgres" as const, url: url ?? "" };
  const deps = {
    db,
    providers,
    config,
    assessTask: async () => ({ allowed: true, category: null, reason: null, fix: null, layer: null }),
    verifySubmission: async () => ({
      gps_ok: true,
      fresh_ok: true,
      vision_ok: true,
      vision_reason: "Fixture photo accepted",
      worker_distance_m: 0,
      confidence: 0.99,
      auto_approve: true,
    }),
  };
  const service = createEyesService(deps);
  const makeServer = () =>
    createServer({ service: createEyesService(deps), providers, config, env: {}, rpc: createRpc(db) });
  let server = makeServer();
  const http = createHttpServer(toNodeListener((req) => server.fetch(req)));
  let base = "";
  const request = (path: string, code: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${code}`,
        origin: config.worker_web_url,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const setup = async (code: string) => {
    const response = await request("/w/me", code);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  };
  let phone = 1000000;
  const worker = async () => {
    const number = `+1555${++phone}`;
    await service.joinWorker({ name: "Setup fixture", phone: number, lat: 37.7, lng: -122.4 });
    const [w] = await sql`select id, phone from workers where phone = ${number}`;
    if (!w) throw new Error("Fixture worker missing");
    await service.handleWorkerReply({ phone: w.phone, intent: "start", text: "START" });
    const code = signToken(
      config.link_secret,
      `e:${w.id}`,
      new Date(providers.clock.now().getTime() + 7 * 86400000),
    );
    const install = await service.workerInstallLink(code);
    return {
      id: w.id as string,
      phone: w.phone as string,
      code,
      native: install.install_url.split("#c=")[1] ?? "",
    };
  };
  beforeAll(async () => {
    await migrate(url ?? "");
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP fixture port");
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
    await sql.end();
  });

  it("keeps native connection complete after a real task photo, another location, restart and elapsed time", async () => {
    const w = await worker();
    expect((await request("/w/location", w.native, { lat: 37.7, lng: -122.4, source: "app" })).status).toBe(
      204,
    );
    expect((await setup(w.code)).app.last_at).not.toBeNull();
    const signed = await service.signupAgent({ name: "setup regression" });
    const a = await service.authenticate(signed.api_key);
    if (!a) throw new Error("Fixture agent missing");
    const task = await service.askEyes(a, {
      question: "Is this public cafe open?",
      location: { lat: 37.7, lng: -122.4 },
      task_type: "is_open",
      bounty_usd: 3,
      deadline_minutes: 30,
      require_photo: true,
      idempotency_key: randomUUID(),
    });
    await service.handleWorkerReply({ phone: w.phone, intent: "yes", text: "YES" });
    const capture = signToken(
      config.link_secret,
      `o:${task.task_id}:${w.id}`,
      new Date(providers.clock.now().getTime() + 1800000),
    );
    providers.clock.advance(31000);
    const form = new FormData();
    for (const [key, value] of Object.entries({
      lat: 37.7,
      lng: -122.4,
      accuracy_m: 5,
      captured_at: providers.clock.now().toISOString(),
      answer_bool: true,
    }))
      form.set(key, String(value));
    form.set(
      "photo",
      new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1])], { type: "image/jpeg" }),
      "fixture.jpg",
    );
    const response = await fetch(`${base}/w/offers/${capture}/capture`, { method: "POST", body: form });
    expect(response.status).toBe(200);
    expect(["paid", "verified"]).toContain((await response.json()).status);
    expect((await sql`select location_source from workers where id = ${w.id}`)[0]?.location_source).toBe(
      "capture",
    );
    const afterPhoto = await setup(w.code);
    expect(afterPhoto.app.connected).toBe(true);
    expect(await setup(w.code)).toMatchObject({
      app: { connected: true, sending: false },
      spot: { fresh: true },
    });
    providers.clock.advance(31000);
    expect(
      (await request("/w/location", w.native, { lat: 37.71, lng: -122.4, source: "here_link" })).status,
    ).toBe(204);
    providers.clock.advance(25 * 3600000);
    server = makeServer();
    expect(await setup(w.code)).toMatchObject({
      app: { connected: true, sending: false },
      spot: { fresh: false },
    });
    expect(await (await request("/w/device", w.native, {})).json()).toMatchObject({ app_connected: true });
    await service.handleWorkerReply({ phone: w.phone, intent: "help", text: "HELP" });
    expect(String(providers.messaging.outbox.at(-1)?.payload)).not.toContain("Get the app");
  });

  it("does not call install-link visits, registration, or non-native fixes a connection", async () => {
    const w = await worker();
    const status = await request("/w/device", w.native, {});
    const device = await status.json();
    const ticket = device.profile_url.split("/").at(-1);
    await service.addWorkerDevice(ticket, {
      udid: "00008110-0000000000000001",
      product: "iPhone14,5",
      version: "18.0",
    });
    expect(
      (await request("/w/location", w.native, { lat: 37.7, lng: -122.4, source: "shortcut" })).status,
    ).toBe(204);
    expect((await setup(w.code)).app.connected).toBe(false);
    expect((await request("/w/location", w.native, { lat: 37.7, lng: -122.4, source: "app" })).status).toBe(
      429,
    );
    expect((await setup(w.code)).app.connected).toBe(false);
    providers.clock.advance(31000);
    expect((await request("/w/location", w.native, { lat: 37.7, lng: -122.4, source: "app" })).status).toBe(
      204,
    );
    expect((await setup(w.code)).app.connected).toBe(true);
  });

  it("persists optional email acknowledgement without mail or verification and supports later real email", async () => {
    const w = await worker();
    const sent = providers.email.outbox.length;
    const texts = providers.messaging.outbox.length;
    const response = await request("/w/me/email/skip", w.code, {});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(config.worker_web_url);
    expect(await response.json()).toMatchObject({
      email_skipped: true,
      email_status: "none",
      email_masked: null,
    });
    expect((await request("/w/me/email/skip", w.code, {})).status).toBe(200);
    server = makeServer();
    expect(await setup(w.code)).toMatchObject({ email_skipped: true, email_status: "none" });
    expect(await sql`select email, email_verified_at, opted_in from workers where id = ${w.id}`).toEqual([
      { email: null, email_verified_at: null, opted_in: true },
    ]);
    expect(providers.email.outbox).toHaveLength(sent);
    expect(providers.messaging.outbox).toHaveLength(texts);
    const start = await request("/w/me/email/start", w.code, {});
    expect(start.status).toBe(200);
    const { mailto } = await start.json();
    const connect = new URL(mailto).searchParams.get("subject")?.split(" ").at(-1) ?? "";
    await service.workerConnectEmail("setup-fixture@example.test", connect);
    expect(await setup(w.code)).toMatchObject({ email_skipped: false, email_status: "verified" });
  });

  it("rejects bad, expired, query-only and wrong-kind setup codes without changing preferences", async () => {
    const w = await worker();
    const codes = [
      "",
      "bad",
      w.native,
      signToken(config.link_secret, `e:${w.id}`, new Date(providers.clock.now().getTime() - 1)),
      signToken(config.link_secret, `l:${w.id}`),
    ];
    for (const code of codes)
      expect((await request(`/w/me/email/skip?c=${w.code}`, code, {})).status).toBe(401);
    expect((await setup(w.code)).email_skipped).toBe(false);
    expect((await request("/w/me/email/skip", w.code, { email: "invented@example.test" })).status).toBe(400);
    expect(
      (
        await fetch(`${base}/w/me/email/skip`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${w.code}`,
            origin: "https://other.test",
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect((await setup(w.code)).email_skipped).toBe(false);
  });

  it("deletes the account after paying, refusing while a task is in progress, and keeps the ledger", async () => {
    const w = await worker();
    const email = `delete-${w.id}@example.test`;
    const { mailto } = await service.workerEmailStart(w.code);
    await service.workerConnectEmail(
      email,
      new URL(mailto).searchParams.get("subject")?.split(" ").at(-1) ?? "",
    );
    // A spot no earlier fixture worker shares, so this worker gets the offer.
    const spot = { lat: 37.75, lng: -122.45 };
    expect((await request("/w/location", w.native, { ...spot, source: "app" })).status).toBe(204);
    const signed = await service.signupAgent({ name: "delete regression" });
    const a = await service.authenticate(signed.api_key);
    if (!a) throw new Error("Fixture agent missing");
    const task = await service.askEyes(a, {
      question: "Is this public cafe open?",
      location: spot,
      task_type: "is_open",
      bounty_usd: 3,
      deadline_minutes: 30,
      require_photo: true,
      idempotency_key: randomUUID(),
    });
    await service.handleWorkerReply({ phone: w.phone, intent: "yes", text: "YES" });
    const remove = (code: string) =>
      fetch(`${base}/w/me`, { method: "DELETE", headers: { authorization: `Bearer ${code}` } });
    const busy = await remove(w.code);
    expect(busy.status).toBe(400);
    expect(await busy.json()).toMatchObject({ error: "invalid_input", task_id: task.task_id });

    const capture = signToken(
      config.link_secret,
      `o:${task.task_id}:${w.id}`,
      new Date(providers.clock.now().getTime() + 1800000),
    );
    providers.clock.advance(31000);
    const form = new FormData();
    for (const [key, value] of Object.entries({
      ...spot,
      accuracy_m: 5,
      captured_at: providers.clock.now().toISOString(),
      answer_bool: true,
    }))
      form.set(key, String(value));
    form.set(
      "photo",
      new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1])], { type: "image/jpeg" }),
      "f.jpg",
    );
    expect((await fetch(`${base}/w/offers/${capture}/capture`, { method: "POST", body: form })).status).toBe(
      200,
    );
    await service.workerEmailLogin(email);
    const login = /#c=([\w-]+)/.exec(JSON.stringify(providers.email.outbox.at(-1)))?.[1] ?? "";
    const ledger = () =>
      sql`select type, amount_cents::int as cents, worker_id from ledger where task_id = ${task.task_id} order by type`;
    const before = await ledger();
    expect(before.map((row) => row.type)).not.toContain("payout");
    // Payouts set up only now, so the verified task is still owed when the delete starts.
    await sql`update workers set stripe_account_id = ${`acct_${w.id}`} where id = ${w.id}`;

    const deleted = await remove(w.code);
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("cache-control")).toBe("no-store");
    expect(await deleted.json()).toEqual({ deleted: true });
    const after = await ledger();
    expect(after.filter((row) => row.type !== "payout")).toEqual(
      before.map((row) => ({ ...row, worker_id: null })),
    );
    expect(after.filter((row) => row.type === "payout")).toEqual([
      { type: "payout", cents: 300, worker_id: null },
    ]);
    expect((await request("/w/me", w.code)).status).toBe(401);
    expect((await remove(w.code)).status).toBe(401);
    expect((await request("/w/location", w.native, { lat: 37.7, lng: -122.4, source: "app" })).status).toBe(
      401,
    );
    const code = await fetch(`${base}/w/login/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: login }),
    });
    expect(code.status).toBe(401);
    expect(await sql`select name, phone, email, lat, opted_in from workers where id = ${w.id}`).toEqual([
      { name: "", phone: `deleted:${w.id}`, email: null, lat: null, opted_in: false },
    ]);
  });
});
