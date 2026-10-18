import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
// @ts-expect-error untyped worker module; the Workers types are not in this package.
import worker, { EyesServer } from "./worker.js";

// The Durable Object base class only exists in the Workers runtime. Keep the same constructor contract.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const INACTIVITY_MS = 6 * 60 * 60 * 1000;

type FakeFetch = (input: string | Request | URL, init?: RequestInit) => Promise<Response>;

interface FakePort {
  fetch: Mock<FakeFetch>;
}

interface FakeContainerOptions {
  running?: boolean;
  port?: FakePort;
  monitor?: () => Promise<void>;
}

interface FakeContainer {
  running: boolean;
  port: FakePort;
  start: Mock<() => void>;
  setInactivityTimeout: Mock<(ms: number) => Promise<void>>;
  monitor: () => Promise<void>;
  getTcpPort: Mock<() => FakePort>;
}

interface FakeStub {
  fetch: Mock<(request: Request) => Promise<Response>>;
  ensure: Mock<() => Promise<boolean>>;
}

function fakePort(): FakePort {
  return { fetch: vi.fn<FakeFetch>(async () => new Response("ok", { status: 200 })) };
}

function fakeContainer(options: FakeContainerOptions = {}): FakeContainer {
  const container: FakeContainer = {
    running: options.running ?? false,
    port: options.port ?? fakePort(),
    start: vi.fn(() => {
      container.running = true;
    }),
    setInactivityTimeout: vi.fn(async (_ms: number) => {}),
    monitor: options.monitor ?? (() => Promise.resolve()),
    getTcpPort: vi.fn(() => container.port),
  };
  return container;
}

function fakeCtx(container: FakeContainer) {
  return { container, blockConcurrencyWhile: vi.fn((fn: () => unknown) => fn()) };
}

function fakeStub(): FakeStub {
  return {
    fetch: vi.fn(async (_request: Request) => new Response("routed", { status: 200 })),
    ensure: vi.fn(async () => false),
  };
}

function fakeEnv(stub: FakeStub, extra: Record<string, unknown> = {}) {
  return {
    EYES: { idFromName: vi.fn((name: string) => `id-${name}`), get: vi.fn(() => stub) },
    ...extra,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("api worker routing", () => {
  it("proxies to ORIGIN when set and the host is not workers.dev", async () => {
    const stub = fakeStub();
    const upstream = vi.fn(async (_input: URL | string, _init?: RequestInit) => new Response("from mac"));
    vi.stubGlobal("fetch", upstream);
    const env = fakeEnv(stub, { ORIGIN: "https://eyes-dispatch.inkboxwire.com" });

    const res = await worker.fetch(new Request("https://api.eyes.pictures/v1/tasks?limit=2"), env);

    expect(await res.text()).toBe("from mac");
    expect(upstream).toHaveBeenCalledOnce();
    expect(String(upstream.mock.calls[0]?.[0])).toBe("https://eyes-dispatch.inkboxwire.com/v1/tasks?limit=2");
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("sends workers.dev traffic to the container even when ORIGIN is set", async () => {
    const stub = fakeStub();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const env = fakeEnv(stub, { ORIGIN: "https://eyes-dispatch.inkboxwire.com" });

    const res = await worker.fetch(new Request("https://eyes-api.someone.workers.dev/healthz?x=1"), env);

    expect(await res.text()).toBe("routed");
    expect(upstream).not.toHaveBeenCalled();
    expect(stub.fetch.mock.calls[0]?.[0].url).toBe("http://eyes/healthz?x=1");
  });

  it("sends everything to the container when ORIGIN is not set", async () => {
    const stub = fakeStub();
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    await worker.fetch(new Request("https://api.eyes.pictures/v1/agents"), fakeEnv(stub));

    expect(upstream).not.toHaveBeenCalled();
    expect(stub.fetch).toHaveBeenCalledOnce();
    expect(stub.fetch.mock.calls[0]?.[0].url).toBe("http://eyes/v1/agents");
  });

  it("replaces a client-sent x-forwarded-for with cf-connecting-ip and sets x-forwarded-host", async () => {
    const stub = fakeStub();
    const req = new Request("https://api.eyes.pictures/v1/agents", {
      headers: { "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "203.0.113.9" },
    });

    await worker.fetch(req, fakeEnv(stub));

    const forwarded = stub.fetch.mock.calls[0]?.[0];
    expect(forwarded?.headers.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(forwarded?.headers.get("x-forwarded-host")).toBe("api.eyes.pictures");
  });

  it("sets x-forwarded-for to empty when Cloudflare sent no cf-connecting-ip", async () => {
    const stub = fakeStub();
    const req = new Request("https://api.eyes.pictures/v1/agents", {
      headers: { "x-forwarded-for": "6.6.6.6" },
    });

    await worker.fetch(req, fakeEnv(stub));

    expect(stub.fetch.mock.calls[0]?.[0].headers.get("x-forwarded-for")).toBe("");
  });

  it("removes the host header before it reaches the server", async () => {
    const stub = fakeStub();
    const req = new Request("https://api.eyes.pictures/v1/agents", { headers: { host: "evil.example" } });

    await worker.fetch(req, fakeEnv(stub));

    expect(stub.fetch.mock.calls[0]?.[0].headers.get("host")).toBeNull();
  });

  it("scheduled() calls ensure() on the main Durable Object", async () => {
    const stub = fakeStub();
    const env = fakeEnv(stub);

    await worker.scheduled({}, env);

    expect(env.EYES.idFromName).toHaveBeenCalledWith("main");
    expect(stub.ensure).toHaveBeenCalledOnce();
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

describe("EyesServer", () => {
  it("applies the inactivity timeout on construction only when the container is running", () => {
    const running = fakeContainer({ running: true });
    new EyesServer(fakeCtx(running), {});
    expect(running.setInactivityTimeout).toHaveBeenCalledWith(INACTIVITY_MS);

    const idle = fakeContainer({ running: false });
    const ctx = fakeCtx(idle);
    new EyesServer(ctx, {});
    expect(ctx.blockConcurrencyWhile).not.toHaveBeenCalled();
  });

  it("ensure() does nothing and returns false when the container is already running", async () => {
    const container = fakeContainer({ running: true });
    const dob = new EyesServer(fakeCtx(container), {});

    expect(await dob.ensure()).toBe(false);
    expect(container.start).not.toHaveBeenCalled();
  });

  it("ensure() starts the container with string env vars only, minus ORIGIN", async () => {
    const container = fakeContainer();
    const dob = new EyesServer(fakeCtx(container), {
      ORIGIN: "https://eyes-dispatch.inkboxwire.com",
      INKBOX_API_KEY: "test-key",
      SUBJECT_PREFIX: "",
      EYES: { not: "a string" },
      RETRIES: 3,
    });

    expect(await dob.ensure()).toBe(true);

    expect(container.start).toHaveBeenCalledWith({
      env: { INKBOX_API_KEY: "test-key", SUBJECT_PREFIX: "" },
      enableInternet: true,
    });
    expect(container.setInactivityTimeout).toHaveBeenCalledWith(INACTIVITY_MS);
  });

  it("logs, without throwing, when the container exits with an error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let exited: Promise<void> = Promise.resolve();
    const container = fakeContainer({
      monitor: () => {
        exited = Promise.reject(new Error("oom"));
        return exited;
      },
    });
    const dob = new EyesServer(fakeCtx(container), {});

    await dob.ensure();
    // ensure() attached its logger first, so this await runs after the log line.
    await exited.catch(() => {});

    expect(error).toHaveBeenCalledWith(
      "eyes container exited with an error",
      expect.objectContaining({ message: "oom" }),
    );
  });

  describe("fetch() while the server is still booting", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("retries after a refused connection and replays the buffered body", async () => {
      const port = fakePort();
      port.fetch
        .mockRejectedValueOnce(new Error("connection refused"))
        .mockResolvedValueOnce(new Response("ready", { status: 201 }));
      const dob = new EyesServer(fakeCtx(fakeContainer({ port })), {});

      const pending = dob.fetch(new Request("http://eyes/v1/tasks", { method: "POST", body: "hello" }));
      await vi.advanceTimersByTimeAsync(600);
      const res = await pending;

      expect(res.status).toBe(201);
      expect(await res.text()).toBe("ready");
      expect(port.fetch.mock.calls.map(([url]) => url)).toEqual([
        "http://eyes/v1/tasks",
        "http://eyes/v1/tasks",
      ]);
      const bodies = port.fetch.mock.calls.map(([, init]) =>
        new TextDecoder().decode(init?.body as ArrayBuffer),
      );
      expect(bodies).toEqual(["hello", "hello"]);
    });

    it("answers 503 once the 60 s deadline passes with no answer", async () => {
      const port = fakePort();
      port.fetch.mockRejectedValue(new Error("connection refused"));
      const dob = new EyesServer(fakeCtx(fakeContainer({ port })), {});

      const pending = dob.fetch(new Request("http://eyes/healthz"));
      await vi.advanceTimersByTimeAsync(61_000);
      const res = await pending;

      expect(res.status).toBe(503);
      expect(await res.text()).toBe("Eyes server unavailable: connection refused");
      expect(port.fetch.mock.calls.length).toBeGreaterThan(1);
    });

    it("passes later requests straight through once the server has answered", async () => {
      const port = fakePort();
      const dob = new EyesServer(fakeCtx(fakeContainer({ port })), {});

      await dob.fetch(new Request("http://eyes/healthz"));

      const second = new Request("http://eyes/v1/agents");
      await dob.fetch(second);

      expect(port.fetch).toHaveBeenCalledTimes(2);
      expect(port.fetch.mock.calls[1]?.[0]).toBe(second);
    });
  });
});
