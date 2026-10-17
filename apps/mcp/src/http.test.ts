import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer, type OutgoingHttpHeaders, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Agent,
  AppConfig,
  type CaptureFields,
  type EyesService,
  fakeProviders,
  type PhotoUpload,
  signToken,
} from "@eyes/core";
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
  vi.restoreAllMocks();
  http?.closeAllConnections();
  await new Promise((resolve) => http?.close(resolve));
  http = undefined;
});

async function start(service: Partial<EyesService>) {
  const server = createServer({
    service: service as EyesService,
    providers: fakeProviders(),
    config,
    env: {},
  });
  http = createHttpServer(toNodeListener(server.fetch));
  await new Promise<void>((resolve) => http?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

function rawPost(
  url: string,
  headers: OutgoingHttpHeaders,
  write: (req: ReturnType<typeof request>) => void,
) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request(url, { method: "POST", headers }, (res) => {
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

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("node adapter on a real socket", () => {
  it("delivers a binary photo over 1 MB byte for byte and keeps the link token out of the logs", async () => {
    const received: { fields: CaptureFields; photo: PhotoUpload | null }[] = [];
    const base = await start({
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
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
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
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const res = await rawPost(
      `${base}/mcp`,
      { "content-type": "application/json", "content-length": 256 * MB },
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
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const res = await rawPost(`${base}/v1/signup`, { "content-type": "application/json" }, (req) => {
      for (let i = 0; i < 32; i++) req.write(Buffer.alloc(64 * 1024, 0x20));
      req.end();
    });

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: "invalid_input", max_bytes: MB });
    expect(signupAgent).not.toHaveBeenCalled();
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
    vi.spyOn(console, "log").mockImplementation(() => undefined);
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
});
