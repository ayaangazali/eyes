import { createHash, randomBytes } from "node:crypto";
import {
  type ClientRequest,
  createServer as createHttpServer,
  type RequestOptions,
  request,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Agent,
  AppConfig,
  type CaptureFields,
  EyesError,
  type EyesService,
  fakeProviders,
  type OfferView,
  type PhotoUpload,
  signToken,
} from "@eyes/core";
import type { Rpc } from "@eyes/db";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toNodeListener } from "./http.ts";
import { createServer } from "./server.ts";

const MB = 1024 * 1024;
const KEY = "eyes_test_key";
const TASK_ID = "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b";
const config = AppConfig.parse({
  public_api_url: "http://api.eyes.test",
  worker_web_url: "http://worker.eyes.test",
  link_secret: "x".repeat(32),
});

let http: Server | undefined;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  http?.closeAllConnections();
  await new Promise((resolve) => http?.close(resolve));
  http = undefined;
});

async function listenOn(fetch: (request: Request) => Promise<Response>) {
  http = createHttpServer(toNodeListener(fetch));
  await new Promise<void>((resolve) => http?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

function start(service: Partial<EyesService>, seen: Request[] = []) {
  const server = createServer({
    service: service as EyesService,
    providers: fakeProviders(),
    config,
    env: {},
  });
  return listenOn((request) => {
    seen.push(request);
    return server.fetch(request);
  });
}

function raw(url: string, options: RequestOptions, write: (req: ClientRequest) => void) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request(url, options, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        req.destroy();
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
      });
    });
    req.on("error", reject);
    write(req);
  });
}

function pump(req: ClientRequest, total: number) {
  const chunk = Buffer.alloc(64 * 1024, 0x20);
  let sent = 0;
  const next = () => {
    while (sent < total) {
      sent += chunk.length;
      if (!req.write(chunk)) return void req.once("drain", next);
    }
    req.end();
  };
  next();
}

const quiet = () => vi.spyOn(console, "log").mockImplementation(() => undefined);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("node adapter on a real socket", () => {
  it("delivers a binary photo over 1 MB byte for byte and keeps the link token out of the logs", async () => {
    const received: { fields: CaptureFields; photo: PhotoUpload | null }[] = [];
    const base = await start({
      getOffer: async () => ({ status: "claimed", claimed_by_you: true }) as OfferView,
      submitCapture: async (_token, fields, photo) => {
        received.push({ fields, photo });
        return {
          task_id: TASK_ID,
          status: "submitted",
          verification: { gps_ok: true, fresh_ok: true, vision_ok: true, vision_reason: "ok" },
          message: "Thanks!",
        };
      },
    });
    const log = quiet();
    const photo = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2 * MB)]));
    const token = signToken(config.link_secret, "offer-1");
    const form = new FormData();
    form.set("lat", "37.78246");
    form.set("lng", "-122.40776");
    form.set("accuracy_m", "8");
    form.set("captured_at", "2026-10-17T19:05:00.000Z");
    form.set("photo", new File([photo], "photo.jpg", { type: "image/jpeg" }));

    const res = await fetch(`${base}/w/offers/${token}/capture`, { method: "POST", body: form });

    expect(res.status).toBe(200);
    expect(received[0]?.photo?.content_type).toBe("image/jpeg");
    expect(sha256(received[0]?.photo?.bytes ?? new Uint8Array())).toBe(sha256(photo));
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([expect.stringMatching(/^POST \/w\/offers\/<token>\/capture 200 \d+ms$/)]);
    expect(lines.join("\n")).not.toContain(token);
  });

  it("answers 413 to a declared content-length over 1 MB without reading the body or authenticating", async () => {
    const authenticate = vi.fn(async () => null);
    const base = await start({ authenticate });
    quiet();

    const res = await raw(
      `${base}/mcp`,
      { method: "POST", headers: { "content-type": "application/json", "content-length": 256 * MB } },
      (req) => req.flushHeaders(),
    );

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: "invalid_input", max_bytes: MB });
    expect(res.body.fix).toEqual(expect.any(String));
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("answers 413 to a chunked body once it grows past 1 MB", async () => {
    const signupAgent = vi.fn();
    const base = await start({ signupAgent });
    quiet();

    const res = await raw(
      `${base}/v1/signup`,
      { method: "POST", headers: { "content-type": "text/plain" } },
      (req) => pump(req, 2 * MB),
    );

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: "invalid_input", max_bytes: MB });
    expect(signupAgent).not.toHaveBeenCalled();
  });

  it("holds a JSON body sent to the capture route to 1 MB, not the 21 MB photo limit", async () => {
    const submitCapture = vi.fn();
    const base = await start({ submitCapture });
    quiet();
    const rss = process.memoryUsage().rss;

    const res = await raw(
      `${base}/w/offers/bad.token/capture`,
      { method: "POST", headers: { "content-type": "application/json" } },
      (req) => pump(req, 20.9 * MB),
    );

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: "invalid_input", max_bytes: MB });
    expect(process.memoryUsage().rss - rss).toBeLessThan(16 * MB);
    expect(submitCapture).not.toHaveBeenCalled();
  });

  it("cuts off a capture body that stalls for 60 seconds and frees the token for a retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const submitCapture = vi.fn(async () => ({
      task_id: TASK_ID,
      status: "submitted" as const,
      verification: { gps_ok: true, fresh_ok: true, vision_ok: true, vision_reason: "ok" },
      message: "Thanks!",
    }));
    const base = await start({
      getOffer: async () => ({ status: "claimed", claimed_by_you: true }) as OfferView,
      submitCapture,
    });
    quiet();
    const url = `${base}/w/offers/${signToken(config.link_secret, "offer-1")}/capture`;
    let closed = false;
    const stalled = request(url, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=zzz" },
    });
    stalled.on("error", () => undefined);
    stalled.on("close", () => {
      closed = true;
    });
    stalled.write('--zzz\r\ncontent-disposition: form-data; name="lat"\r\n\r\n37.78246\r\n');
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));

    await vi.advanceTimersByTimeAsync(59_000);
    await sleep(100);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(closed).toBe(true));
    vi.useRealTimers();

    const form = new FormData();
    form.set("lat", "37.78246");
    form.set("lng", "-122.40776");
    form.set("accuracy_m", "8");
    form.set("captured_at", "2026-10-17T19:05:00.000Z");
    const retry = await fetch(url, { method: "POST", body: form });
    expect(retry.status).toBe(200);
    expect(submitCapture).toHaveBeenCalledTimes(1);
  });

  it("drops content-type on bodiless requests and answers malformed JSON with invalid_input", async () => {
    const agent = { id: "0b6c8f9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f" } as Agent;
    const base = await start({
      authenticate: async (key) => (key === KEY ? agent : null),
      getBalance: async () => ({ balance_usd: 20, escrowed_usd: 0, top_up_url: null }),
      cancelTask: async (_agent, input) => ({
        task_id: input.task_id,
        status: "refunded",
        refunded_usd: 3.5,
      }),
    });
    quiet();
    const headers = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

    const balance = await fetch(`${base}/v1/balance`, { headers });
    const cancel = await fetch(`${base}/v1/tasks/${TASK_ID}/cancel`, { method: "POST", headers });
    const bad = await fetch(`${base}/v1/tasks`, { method: "POST", headers, body: "{bad" });

    expect(balance.status).toBe(200);
    expect(await balance.json()).toMatchObject({ balance_usd: 20 });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toMatchObject({ task_id: TASK_ID, status: "refunded" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual(
      new EyesError("invalid_input", {
        issues: [{ path: "", message: "Request body is not valid JSON." }],
      }).toBody(),
    );
  });

  it("redacts the link token of an absolute-form target and tolerates an empty Host header", async () => {
    const base = await start({
      getOffer: async () => {
        throw new EyesError("offer_invalid");
      },
    });
    const log = quiet();
    const token = signToken(config.link_secret, "offer-1");

    const res = await raw(
      base,
      { method: "GET", path: `http://evil.test/w/offers/${token}`, headers: { host: "" } },
      (req) => req.end(),
    );

    expect(res.status).toBe(404);
    const lines = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(lines).toMatch(/^GET \/w\/offers\/<token> 404 \d+ms$/);
    expect(lines).not.toContain(token);
  });

  it("ignores a malformed Host header and answers an unparsable target with 400", async () => {
    const base = await start({});
    quiet();

    const health = await raw(base, { method: "GET", path: "/healthz", headers: { host: "[bad" } }, (req) =>
      req.end(),
    );
    const target = await raw(base, { method: "GET", path: "http://[bad/healthz" }, (req) => req.end());

    expect(health.status).toBe(200);
    expect(target.status).toBe(400);
    expect(target.body).toMatchObject({ error: "invalid_input", fix: expect.any(String) });
  });

  it("logs known routes as their template and every other path as <other>", async () => {
    const base = await start({});
    const log = quiet();
    const token = signToken(config.link_secret, "anything");

    await fetch(`${base}/some/${token}/deeper`);
    await fetch(`${base}/llms.txt`);
    await fetch(`${base}/v1/tasks/${TASK_ID}`);

    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines[0]).toMatch(/^GET <other> 404 \d+ms$/);
    expect(lines[1]).toMatch(/^GET \/llms\.txt \d{3} \d+ms$/);
    expect(lines[2]).toMatch(/^GET \/v1\/tasks\/<task_id> 401 \d+ms$/);
    expect(lines.join("\n")).not.toContain(token);
    expect(lines.join("\n")).not.toContain(TASK_ID);
  });

  const secret = signToken(config.link_secret, "offer-secret");
  const [tokenBody = "", tokenMac = ""] = secret.split(".");
  const encodeAll = (text: string) =>
    [...text].map((ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).join("");
  const logged = () =>
    [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
      .map((call) => call.map(String).join(" "))
      .join("\n");
  const silence = () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  };
  const offerInvalid = async (): Promise<OfferView> => {
    throw new EyesError("offer_invalid");
  };

  it.each([
    ["backslash", `/\\u:p@h/w/offers/${secret}`],
    ["scheme-relative", `//u:p@h/w/offers/${secret}`],
    ["absolute", `http://u:p@h/w/offers/${secret}`],
  ])("answers a %s target with userinfo with 400 and logs no token", async (_, path) => {
    const base = await start({ getOffer: offerInvalid });
    silence();

    const res = await raw(base, { method: "GET", path }, (req) => req.end());

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_input" });
    expect(logged()).not.toContain(tokenMac);
  });

  it.each([
    ["an encoded slash before it", `/w/offers%2F${secret}`, "<other>"],
    ["an encoded dot", `/w/offers/${tokenBody}%2E${tokenMac}`, "/w/offers/<token>"],
    ["full percent-encoding", `/w/offers/${encodeAll(secret)}`, "/w/offers/<token>"],
    ["a ;x suffix", `/w/offers/${secret};x`, "/w/offers/<token>"],
    ["a .json suffix", `/w/offers/${secret}.json`, "/w/offers/<token>"],
    ["an encoded slash after it", `/w/offers/${secret}%2Fcapture`, "/w/offers/<token>"],
    ["an encoded dot and a bare trailing %", `/w/offers/${tokenBody}%2E${tokenMac}.%`, "/w/offers/<token>"],
    ["two dots between the halves", `/w/offers/${tokenBody}..${tokenMac}`, "/w/offers/<token>"],
    ["the halves in separate segments", `/${tokenBody}/${tokenMac}`, "<other>"],
    ["a double-encoded dot", `/w/offers/${tokenBody}%252E${tokenMac}`, "/w/offers/<token>"],
  ])("logs a token with %s as its route template and neither half", async (_, path, route) => {
    const base = await start({ getOffer: offerInvalid });
    silence();

    await raw(base, { method: "GET", path }, (req) => req.end());

    expect(logged()).toMatch(new RegExp(`^GET ${route.replaceAll("/", "\\/")} \\d{3} \\d+ms$`));
    expect(logged()).not.toContain(tokenMac);
    expect(logged()).not.toContain(tokenBody);
  });

  it("writes no decoded control characters into the log", async () => {
    const base = await start({ getOffer: offerInvalid });
    silence();

    await raw(base, { method: "GET", path: "/w/offers/x%0D%0AGET%20%2Fhealthz%20200%201ms" }, (req) =>
      req.end(),
    );
    await raw(base, { method: "GET", path: "/%1B%5B2J%0Aforged" }, (req) => req.end());

    expect(logged().split("\n")).toEqual([
      expect.stringMatching(/^GET \/w\/offers\/<token> 404 \d+ms$/),
      expect.stringMatching(/^GET <other> 404 \d+ms$/),
    ]);
  });

  it.each([
    ["a dot segment", `/.//u:p@h/w/offers/${secret}`],
    ["a scheme-relative authority", `//h//u:p@evil.test/w/offers/${secret}`],
    ["an encoded dot segment", `/%2E//u:p@evil.test/w/offers/${secret}`],
    ["a parent segment", `/a/..//u:p@evil.test/w/offers/${secret}`],
    ["a bare host", "/.//evil.test/healthz"],
  ])("keeps a // path behind %s on localhost without a 500 or a leak", async (_, path) => {
    const seen: Request[] = [];
    const base = await start({ getOffer: offerInvalid }, seen);
    silence();

    const res = await raw(base, { method: "GET", path }, (req) => req.end());

    expect(res.status).not.toBe(500);
    expect(seen.map((request) => new URL(request.url).host)).toEqual(["localhost"]);
    expect(logged()).not.toContain("u:p@");
    expect(logged()).not.toContain(tokenMac);
    expect(logged()).not.toContain(tokenBody);
  });

  it("passes the socket address as X-Forwarded-For only when the request has none or a blank one", async () => {
    const seen: Request[] = [];
    const base = await start({}, seen);
    quiet();

    await fetch(`${base}/healthz`);
    await fetch(`${base}/healthz`, { headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9" } });
    await fetch(`${base}/healthz`, { headers: { "x-forwarded-for": "" } });

    expect(seen.map((request) => request.headers.get("x-forwarded-for"))).toEqual([
      "127.0.0.1",
      "198.51.100.7, 203.0.113.9",
      "127.0.0.1",
    ]);
  });

  it("keeps the ops key out of the request log", async () => {
    const opsKey = "ops-5f2c9a1e7b3d4c8a9e0f1a2b3c4d5e6f";
    const server = createServer({
      service: {} as EyesService,
      providers: fakeProviders(),
      config,
      env: { EYES_OPS_KEY: opsKey },
      rpc: (async () => [{ tasks: [], workers: [] }]) as Rpc,
    });
    const base = await listenOn((request) => server.fetch(request));
    const log = quiet();

    const statuses: number[] = [];
    for (const path of [`/ops/${opsKey}`, `/ops/${opsKey}0`]) {
      statuses.push((await fetch(`${base}${path}`, { redirect: "manual" })).status);
    }

    expect(statuses).toEqual([303, 404]);
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([
      expect.stringMatching(/^GET <other> 303 \d+ms$/),
      expect.stringMatching(/^GET <other> 404 \d+ms$/),
    ]);
  });

  it("logs only the error name when the app throws with the URL in its message", async () => {
    const base = await listenOn(async (request) => {
      throw new Error(`exploded on ${request.url}`);
    });
    silence();

    const res = await raw(base, { method: "GET", path: `/w/offers/${secret}` }, (req) => req.end());

    expect(res.status).toBe(500);
    expect(res.body).toEqual(new EyesError("internal_error").toBody());
    expect(logged()).toContain("request failed: Error");
    expect(logged()).not.toContain(tokenMac);
  });

  it("streams MCP responses and progress over SSE", async () => {
    const agent = { id: "0b6c8f9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f" } as Agent;
    const base = await start({
      authenticate: async (key) => (key === KEY ? agent : null),
      awaitAnswer: async (_agent, input) => ({
        task_id: input.task_id,
        status: "claimed",
        answered: false,
        answer: null,
        next_step: "Call await_answer again.",
      }),
    });
    quiet();
    const client = new Client({ name: "socket-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${KEY}` } },
      }),
    );
    const progress: unknown[] = [];

    const result = await client.callTool(
      { name: "await_answer", arguments: { task_id: TASK_ID, timeout_seconds: 5 } },
      { onprogress: (p) => progress.push(p) },
    );

    expect(result.structuredContent).toMatchObject({ task_id: TASK_ID, status: "claimed", answered: false });
    expect(progress).toHaveLength(1);
    await client.close();
  });

  it("answers 413 with the retake-photo fix to a multipart capture declared over 21 MB", async () => {
    const submitCapture = vi.fn();
    const base = await start({ submitCapture });
    quiet();

    const res = await raw(
      `${base}/w/offers/bad.token/capture`,
      {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x", "content-length": 22 * MB },
      },
      (req) => req.flushHeaders(),
    );

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      max_bytes: 21 * MB,
      fix: "Retake the photo at a lower resolution and submit again.",
    });
    expect(submitCapture).not.toHaveBeenCalled();
  });

  it("joins a repeated request header that Node keeps as an array", async () => {
    const seen: Request[] = [];
    const base = await start({}, seen);
    quiet();

    await raw(base, { method: "GET", path: "/healthz", headers: { "set-cookie": ["a=1", "b=2"] } }, (req) =>
      req.end(),
    );

    expect(seen[0]?.headers.get("set-cookie")).toBe("a=1, b=2");
  });

  it("answers 413 when the app's read of a streamed body fails because it grew past 1 MB", async () => {
    const base = await listenOn(async (request) => {
      await request.arrayBuffer();
      return new Response("read it all");
    });
    quiet();

    const res = await raw(
      `${base}/v1/signup`,
      { method: "POST", headers: { "content-type": "application/octet-stream" } },
      (req) => pump(req, 2 * MB),
    );

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: "invalid_input", max_bytes: MB });
  });

  it("logs 'unknown error' when the app rejects with something that is not an Error", async () => {
    const base = await listenOn(() => Promise.reject("boom"));
    silence();

    const res = await raw(base, { method: "GET", path: "/healthz" }, (req) => req.end());

    expect(res.status).toBe(500);
    expect(res.body).toEqual(new EyesError("internal_error").toBody());
    expect(logged()).toContain("request failed: unknown error");
  });

  it("logs only the error name when the client drops a JSON body part-way, and never calls the app", async () => {
    const signupAgent = vi.fn();
    const base = await start({ signupAgent });
    silence();

    const req = request(`${base}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": 1000 },
    });
    req.on("error", () => undefined);
    req.write('{"name":');
    await sleep(50);
    req.destroy();

    await vi.waitFor(() => expect(logged()).toContain("request failed: Error"));
    expect(signupAgent).not.toHaveBeenCalled();
  });
});
