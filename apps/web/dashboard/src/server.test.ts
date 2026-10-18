import { once } from "node:events";
import { request } from "node:http";
import { type AddressInfo, connect, Server } from "node:net";
import type { Rpc } from "@eyes/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDashboardServer, dbFromEnv, startFromEnv } from "./server.ts";

const FEED = {
  tasks: [],
  ledger: [],
  workers: [{ id: "w1", lat: 37.78246, lng: -122.40776, available: true, opted_in: true }],
  totals: { escrowed_cents: 0, released_today_cents: 0, paid_out_today_cents: 0 },
};

let calls: { fn: string; args: unknown }[] = [];
let failNext: unknown;
const rpc = (async (fn: string, args: Record<string, unknown>) => {
  calls.push({ fn, args });
  if (failNext !== undefined) {
    const err = failNext;
    failNext = undefined;
    throw err;
  }
  return [FEED];
}) as Rpc;

const server = createDashboardServer(rpc);
let port = 0;

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());

function get(path: string, host = `127.0.0.1:${port}`, method = "GET") {
  return new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), body }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("dashboard server", () => {
  it("serves the page at /", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.type).toContain("text/html");
    expect(res.body).toContain("<title>Eyes live</title>");
  });

  it("serves the feed function's row at /feed, with worker positions at full precision", async () => {
    calls = [];
    const res = await get("/feed");
    expect(res.status).toBe(200);
    expect(res.type).toContain("application/json");
    expect(JSON.parse(res.body)).toEqual(FEED);
    expect(calls).toEqual([{ fn: "eyes_dashboard_feed", args: { p_limit: 50 } }]);
  });

  it("answers 502 when the database call fails and keeps serving", async () => {
    failNext = new Error("connection refused");
    expect((await get("/feed")).status).toBe(502);
    expect((await get("/feed")).status).toBe(200);
  });

  it("rejects a non-loopback Host header, so a rebinding site cannot read the feed", async () => {
    calls = [];
    expect((await get("/feed", "evil.example:4400")).status).toBe(403);
    expect((await get("/", "evil.example")).status).toBe(403);
    expect(calls).toEqual([]);
    expect((await get("/feed", `localhost:${port}`)).status).toBe(200);
  });

  it("answers 404 for other paths and methods", async () => {
    expect((await get("/nope")).status).toBe(404);
    expect((await get("/feed", undefined, "POST")).status).toBe(404);
  });

  it("answers 502 for a rejection that is not an Error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    failNext = "pool exhausted";
    expect((await get("/feed")).status).toBe(502);
    expect(spy).toHaveBeenCalledWith("feed failed:", "pool exhausted");
    spy.mockRestore();
  });
});

describe("dbFromEnv", () => {
  it("prefers DATABASE_URL", () => {
    expect(
      dbFromEnv({
        DATABASE_URL: "postgres://test",
        INSFORGE_BASE_URL: "https://insforge.test",
        INSFORGE_API_KEY: "key",
      }),
    ).toEqual({ kind: "postgres", url: "postgres://test" });
  });

  it("uses InsForge only when both of its variables are set, and refuses to start otherwise", () => {
    expect(dbFromEnv({ INSFORGE_BASE_URL: "https://insforge.test", INSFORGE_API_KEY: "key" })).toEqual({
      kind: "insforge",
      base_url: "https://insforge.test",
      api_key: "key",
    });
    expect(() => dbFromEnv({ INSFORGE_BASE_URL: "https://insforge.test" })).toThrow("Set DATABASE_URL");
    expect(() => dbFromEnv({})).toThrow("to read the feed.");
  });
});

describe("startFromEnv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("listens on PORT on loopback and logs the URL", () => {
    const listen = mockListen();
    const log = vi.fn();
    startFromEnv({ INSFORGE_BASE_URL: "https://insforge.test", INSFORGE_API_KEY: "key", PORT: "5123" }, log);
    expect(listen).toHaveBeenCalledWith(5123, "127.0.0.1", expect.any(Function));
    expect(log).toHaveBeenCalledWith("EYES dashboard on http://127.0.0.1:5123");
  });

  it("defaults to port 4400 when PORT is unset", () => {
    const listen = mockListen();
    const log = vi.fn();
    startFromEnv({ INSFORGE_BASE_URL: "https://insforge.test", INSFORGE_API_KEY: "key" }, log);
    expect(listen).toHaveBeenCalledWith(4400, "127.0.0.1", expect.any(Function));
    expect(log).toHaveBeenCalledWith("EYES dashboard on http://127.0.0.1:4400");
  });

  it("throws before listening when no database is configured", () => {
    const listen = mockListen();
    expect(() => startFromEnv({}, vi.fn())).toThrow("Set DATABASE_URL");
    expect(listen).not.toHaveBeenCalled();
  });
});

describe("host guard", () => {
  it("answers 403 and never calls the database when the Host header is missing", async () => {
    const before = calls.length;
    expect(await getWithoutHost("/feed")).toBe(403);
    expect(calls).toHaveLength(before);
  });
});

function mockListen() {
  return vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server, ...args: unknown[]) {
    const done = args.find((arg): arg is () => void => typeof arg === "function");
    done?.();
    return this;
  } as never);
}

async function getWithoutHost(path: string): Promise<number> {
  const socket = connect(port, "127.0.0.1");
  socket.setEncoding("utf8");
  let raw = "";
  socket.on("data", (chunk: string) => {
    raw += chunk;
  });
  socket.end(`GET ${path} HTTP/1.0\r\n\r\n`);
  await once(socket, "end");
  return Number(raw.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? 0);
}
