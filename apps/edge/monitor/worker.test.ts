import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error untyped worker module; the Workers types are not in this package.
import worker from "./worker.js";

const HEALTH_URL = "https://api.eyes.pictures/healthz";
const MIN = 60_000;

interface Call {
  url: string;
  init?: RequestInit;
}

// Plain object standing in for the KV namespace.
function fakeKv(state?: unknown) {
  const store = new Map<string, string>();
  if (state !== undefined) store.set("state", JSON.stringify(state));
  return {
    store,
    get: vi.fn(async (key: string) => {
      const raw = store.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

type Kv = ReturnType<typeof fakeKv>;

function stored(kv: Kv): unknown {
  const raw = kv.store.get("state");
  return raw === undefined ? undefined : JSON.parse(raw);
}

function fakeEnv(kv: Kv, overrides: Record<string, string> = {}) {
  return {
    EYES_MONITOR: kv,
    HEALTH_URL,
    SUBJECT_PREFIX: "",
    ALERT_PHONE: "+15550100",
    INKBOX_API_KEY: "test-key",
    INKBOX_AGENT_HANDLE: "eyes-agent",
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const healthy = () => json({ ok: true, providers: { llm: "live" }, db: "insforge" });
const bad503 = () => new Response("down", { status: 503 });

function timeoutError(): Error {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
}

// Route each fetch: the health probe, the Inkbox identity lookup, and the iMessage send.
// Any other URL is a test bug, so it throws.
function routeFetch(health: () => Response, sendStatus = "sent", identityOk = true): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === HEALTH_URL) return health();
      if (url.includes("/identities/"))
        return identityOk ? json({ id: "ident-1" }) : json({ error: "nope" }, 500);
      if (url.includes("/imessage/messages")) return json({ message: { id: "m1", status: sendStatus } });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

// Subject is the first line of each alert text.
function alertSubjects(calls: Call[]): string[] {
  return calls
    .filter((c) => c.url.includes("/imessage/messages"))
    .map((c) => String(JSON.parse(String(c.init?.body)).text).split("\n")[0] ?? "");
}

// One failed check away from the "down" alert.
function oneBadCheck(): Kv {
  return fakeKv({ fails: 1, down: false, since: Date.now() - MIN });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("probe classification", () => {
  it.each<[string, () => Response]>([
    ["HTTP 503", bad503],
    ["body is not JSON", () => new Response("<html>", { status: 200 })],
    ["ok is not true", () => json({ ok: false, providers: { llm: "live" }, db: "insforge" })],
    [
      "providers not live: llm degraded",
      () => json({ ok: true, providers: { llm: "degraded" }, db: "insforge" }),
    ],
    ["providers not live: none reported", () => json({ ok: true, providers: {}, db: "insforge" })],
    ["providers not live: none reported", () => json({ ok: true, db: "insforge" })],
    ["db is sqlite", () => json({ ok: true, providers: { llm: "live" }, db: "sqlite" })],
    ["db is missing", () => json({ ok: true, providers: { llm: "live" } })],
    [
      "no answer in 10 s",
      () => {
        throw timeoutError();
      },
    ],
    [
      "request failed (socket hang up)",
      () => {
        throw new Error("socket hang up");
      },
    ],
  ])("classifies %s as a failed check", async (reason, health) => {
    const kv = oneBadCheck();
    const calls = routeFetch(health);

    await worker.scheduled({}, fakeEnv(kv));

    expect(alertSubjects(calls)).toEqual([`Eyes API is down: ${reason}`]);
    expect(stored(kv)).toMatchObject({ fails: 2, down: true, reason });
  });
});

describe("state transitions", () => {
  it("a single failure writes state and sends nothing", async () => {
    const kv = fakeKv();
    const calls = routeFetch(bad503);

    await worker.scheduled({}, fakeEnv(kv));

    expect(alertSubjects(calls)).toEqual([]);
    expect(stored(kv)).toMatchObject({ fails: 1, down: false, reason: "HTTP 503" });
  });

  it("two failures in a row send one down alert, and later failures send no repeats", async () => {
    const kv = fakeKv();
    const calls = routeFetch(bad503);

    await worker.scheduled({}, fakeEnv(kv));
    await worker.scheduled({}, fakeEnv(kv));
    await worker.scheduled({}, fakeEnv(kv));

    expect(alertSubjects(calls)).toEqual(["Eyes API is down: HTTP 503"]);
    expect(stored(kv)).toMatchObject({ fails: 3, down: true });
  });

  it("recovery sends one back-up alert with the outage length", async () => {
    const kv = fakeKv({ fails: 3, down: true, since: Date.now() - 12 * MIN, reason: "HTTP 503" });
    const calls = routeFetch(healthy);

    await worker.scheduled({}, fakeEnv(kv));

    expect(alertSubjects(calls)).toEqual(["Eyes API is back up (down 12 min)"]);
    expect(stored(kv)).toEqual({ fails: 0, down: false, since: 0 });
  });

  it("recovery reports at least one minute", async () => {
    const kv = fakeKv({ fails: 2, down: true, since: Date.now() - 10_000, reason: "HTTP 503" });
    const calls = routeFetch(healthy);

    await worker.scheduled({}, fakeEnv(kv));

    expect(alertSubjects(calls)).toEqual(["Eyes API is back up (down 1 min)"]);
  });

  it("the healthy steady state sends nothing", async () => {
    const kv = fakeKv({ fails: 0, down: false, since: 0 });
    const calls = routeFetch(healthy);

    await worker.scheduled({}, fakeEnv(kv));

    expect(alertSubjects(calls)).toEqual([]);
    expect(stored(kv)).toEqual({ fails: 0, down: false, since: 0 });
  });

  it("prefixes the subject and sends to ALERT_PHONE", async () => {
    const kv = oneBadCheck();
    const calls = routeFetch(bad503);

    await worker.scheduled({}, fakeEnv(kv, { SUBJECT_PREFIX: "[dev] " }));

    const send = calls.find((c) => c.url.includes("/imessage/messages"));
    const body = JSON.parse(String(send?.init?.body));
    expect(body.to).toBe("+15550100");
    expect(body.text.split("\n")[0]).toBe("[dev] Eyes API is down: HTTP 503");
  });
});

describe("send failures", () => {
  it("an identity lookup failure rejects and leaves state unchanged, so the next tick retries", async () => {
    const kv = oneBadCheck();
    routeFetch(bad503, "sent", false);

    await expect(worker.scheduled({}, fakeEnv(kv))).rejects.toThrow(
      "alert not sent: Inkbox identity lookup HTTP 500",
    );
    expect(kv.put).not.toHaveBeenCalled();
    expect(stored(kv)).toMatchObject({ fails: 1, down: false });
  });

  it("a declined recovery alert rejects and keeps the down state", async () => {
    const kv = fakeKv({ fails: 2, down: true, since: Date.now() - 5 * MIN, reason: "HTTP 503" });
    routeFetch(healthy, "declined");

    await expect(worker.scheduled({}, fakeEnv(kv))).rejects.toThrow(
      "alert not sent: Inkbox HTTP 200 declined",
    );
    expect(kv.put).not.toHaveBeenCalled();
    expect(stored(kv)).toMatchObject({ fails: 2, down: true });
  });
});

describe("send response fallbacks", () => {
  // Health fails, so a down alert is due. The identity and send responses come from the caller.
  function stubAlert(identity: () => Response, send: () => Response) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === HEALTH_URL) return bad503();
        if (url.includes("/identities/")) return identity();
        if (url.includes("/imessage/messages")) return send();
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  it("a non-JSON identity response is reported with its HTTP status", async () => {
    const kv = oneBadCheck();
    stubAlert(
      () => new Response("<html>", { status: 200 }),
      () => json({}),
    );

    await expect(worker.scheduled({}, fakeEnv(kv))).rejects.toThrow(
      "alert not sent: Inkbox identity lookup HTTP 200",
    );
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("a non-JSON send failure is reported with its HTTP status", async () => {
    const kv = oneBadCheck();
    stubAlert(
      () => json({ id: "ident-1" }),
      () => new Response("<html>", { status: 500 }),
    );

    await expect(worker.scheduled({}, fakeEnv(kv))).rejects.toThrow("alert not sent: Inkbox HTTP 500");
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("a send error reports the Inkbox error code", async () => {
    const kv = oneBadCheck();
    stubAlert(
      () => json({ id: "ident-1" }),
      () => json({ message: { status: "error", errorCode: "bad_number" } }, 422),
    );

    await expect(worker.scheduled({}, fakeEnv(kv))).rejects.toThrow(
      "alert not sent: Inkbox HTTP 422 bad_number",
    );
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("a 200 with a non-JSON body is not counted as sent, so the tick retries", async () => {
    const kv = oneBadCheck();
    stubAlert(
      () => json({ id: "ident-1" }),
      () => new Response("<html>", { status: 200 }),
    );

    await expect(worker.scheduled({}, fakeEnv(kv))).rejects.toThrow(
      "alert not sent: Inkbox HTTP 200 no message id",
    );
    expect(kv.put).not.toHaveBeenCalled();
    expect(stored(kv)).toMatchObject({ fails: 1, down: false });
  });

  it("a 200 with JSON but no message id is not counted as sent", async () => {
    const kv = oneBadCheck();
    stubAlert(
      () => json({ id: "ident-1" }),
      () => json({ message: { status: "sent" } }),
    );

    await expect(worker.scheduled({}, fakeEnv(kv))).rejects.toThrow(
      "alert not sent: Inkbox HTTP 200 no message id",
    );
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe("release trigger", () => {
  const DB = "https://db.test";
  const GH = "https://api.github.com/repos/i098/eyes-ios-release";
  const releaseEnv = (kv: Kv) =>
    fakeEnv(kv, {
      RELEASE_DISPATCH_TOKEN: "gh-test",
      INSFORGE_BASE_URL: `${DB}/`,
      INSFORGE_API_KEY: "db-key",
    });

  function routeRelease(opts: {
    pending?: number;
    dbStatus?: number;
    runs?: string[];
    runsStatus?: number;
    dispatchStatus?: number;
  }) {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === HEALTH_URL) return healthy();
        if (url === `${DB}/api/database/rpc/eyes_expire_overdue`) return json([]);
        if (url.startsWith(`${DB}/api/database/records/worker_devices?`))
          return json(
            Array.from({ length: opts.pending ?? 0 }, (_, i) => ({ udid: `u${i}` })),
            opts.dbStatus ?? 200,
          );
        if (url.startsWith(`${GH}/actions/runs`))
          return json(
            { workflow_runs: (opts.runs ?? []).map((status) => ({ status })) },
            opts.runsStatus ?? 200,
          );
        if (url === `${GH}/dispatches`) return new Response(null, { status: opts.dispatchStatus ?? 204 });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    return calls;
  }
  const dispatched = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/dispatches"));

  it("without a token it never asks the database or GitHub", async () => {
    const calls = routeFetch(healthy);
    await worker.scheduled({}, fakeEnv(fakeKv()));
    expect(calls.map((c) => c.url)).toEqual([HEALTH_URL]);
  });

  it("no unreleased iPhones: no GitHub call", async () => {
    const calls = routeRelease({ pending: 0 });
    await worker.scheduled({}, releaseEnv(fakeKv()));
    expect(calls.some((c) => c.url.startsWith(GH))).toBe(false);
    expect(calls.find((c) => c.url.startsWith(DB))?.url).toBe(
      `${DB}/api/database/records/worker_devices?select=udid&released_at=is.null`,
    );
  });

  it("an iPhone waits and no run is active: one device-registered dispatch, remembered in KV", async () => {
    const kv = fakeKv();
    const calls = routeRelease({ pending: 2, runs: ["completed"] });
    await worker.scheduled({}, releaseEnv(kv));
    const [d] = dispatched(calls);
    expect(JSON.parse(String(d?.init?.body))).toEqual({ event_type: "device-registered" });
    expect(new Headers(d?.init?.headers).get("authorization")).toBe("Bearer gh-test");
    expect(JSON.parse(kv.store.get("release") ?? "{}").at).toBeGreaterThan(0);
  });

  it.each([["in_progress"], ["queued"]])("a %s run means no new dispatch", async (status) => {
    const calls = routeRelease({ pending: 1, runs: ["completed", status] });
    await worker.scheduled({}, releaseEnv(fakeKv()));
    expect(dispatched(calls)).toHaveLength(0);
  });

  it("a dispatch in the last 10 minutes means no new one", async () => {
    const kv = fakeKv();
    kv.store.set("release", JSON.stringify({ at: Date.now() - 5 * MIN }));
    const calls = routeRelease({ pending: 1 });
    await worker.scheduled({}, releaseEnv(kv));
    expect(calls.some((c) => c.url.startsWith(GH))).toBe(false);
  });

  it.each([
    ["InsForge HTTP 500", { pending: 1, dbStatus: 500 }],
    ["GitHub runs HTTP 401", { pending: 1, runsStatus: 401 }],
    ["GitHub dispatch HTTP 403", { pending: 1, dispatchStatus: 403 }],
  ])("%s only logs; the uptime check still runs and no dispatch is remembered", async (msg, opts) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const kv = fakeKv();
    routeRelease(opts);
    await worker.scheduled({}, releaseEnv(kv));
    expect(log).toHaveBeenCalledWith(`release trigger: ${msg}`);
    expect(kv.store.has("release")).toBe(false);
    expect(stored(kv)).toEqual({ fails: 0, down: false, since: 0 });
  });
});

describe("expiry trigger", () => {
  const base = "https://db.test";
  const env = () => fakeEnv(fakeKv(), { INSFORGE_BASE_URL: `${base}/`, INSFORGE_API_KEY: "db-key" });

  it("refunds through the database even when the API is down", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return url === HEALTH_URL ? bad503() : json([]);
    });
    const before = Date.now();
    await worker.scheduled({}, env());
    const call = calls.find((c) => c.url === `${base}/api/database/rpc/eyes_expire_overdue`);
    expect(call?.init?.method).toBe("POST");
    expect(new Headers(call?.init?.headers).get("authorization")).toBe("Bearer db-key");
    expect(new Headers(call?.init?.headers).get("content-type")).toBe("application/json");
    const time = Date.parse(JSON.parse(String(call?.init?.body)).p_now);
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(Date.now());
  });

  it("waits for expiry before returning an alert failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let finish!: (response: Response) => void;
    const expiry = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === HEALTH_URL) return bad503();
      if (url.includes("/rpc/")) return expiry;
      throw new Error("alert unavailable");
    });
    const run = worker.scheduled({}, { ...env(), EYES_MONITOR: oneBadCheck() });
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void run.then(markSettled, markSettled);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
    } finally {
      finish(json([]));
      vi.useRealTimers();
    }
    await expect(run).rejects.toThrow("alert unavailable");
  });

  it.each(["INSFORGE_BASE_URL", "INSFORGE_API_KEY"])("skips expiry without %s", async (key) => {
    const calls = routeFetch(healthy);
    await worker.scheduled({}, { ...env(), [key]: "" });
    expect(calls.map((c) => c.url)).toEqual([HEALTH_URL]);
  });

  it.each([
    ["HTTP 503", () => bad503()],
    [
      "database timeout",
      () => {
        throw new Error("database timeout");
      },
    ],
  ])("logs %s without blocking health or release checks", async (reason, response) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url === HEALTH_URL) return healthy();
      if (url.includes("/rpc/")) return response();
      return json([]);
    });
    const e = { ...env(), RELEASE_DISPATCH_TOKEN: "gh-test" };
    await worker.scheduled({}, e);
    expect(log).toHaveBeenCalledWith(`expiry trigger: ${reason}`);
    expect(stored(e.EYES_MONITOR)).toEqual({ fails: 0, down: false, since: 0 });
    expect(calls).toContain(`${base}/api/database/records/worker_devices?select=udid&released_at=is.null`);
  });
});

describe("abuse alerts", () => {
  const DB = "https://db.example.test";
  const env = (kv: Kv) => fakeEnv(kv, { INSFORGE_BASE_URL: DB, INSFORGE_API_KEY: "k" });

  // The events query for a 429 spike returns `rows` rows; every other signal returns none.
  function spikeFetch(rows: number): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url === HEALTH_URL) return healthy();
        if (url.includes("/identities/")) return json({ id: "ident-1" });
        if (url.includes("/imessage/messages")) return json({ message: { id: "m1", status: "sent" } });
        if (url.includes("/records/events"))
          return json(Array.from({ length: url.includes("rate_limited") ? rows : 0 }, (_, id) => ({ id })));
        return json([]);
      }),
    );
    return calls;
  }

  it("a spike sends one alert and a second tick in the spike stays quiet", async () => {
    const kv = fakeKv();
    const calls = spikeFetch(50);
    await worker.scheduled({}, env(kv));
    await worker.scheduled({}, env(kv));
    expect(alertSubjects(calls)).toEqual(["Eyes abuse spike: 429 responses"]);
  });

  it("alerts again after the spike ends and a new one starts", async () => {
    const kv = fakeKv();
    const calls = spikeFetch(50);
    await worker.scheduled({}, env(kv));
    spikeFetch(0);
    await worker.scheduled({}, env(kv));
    const again = spikeFetch(50);
    await worker.scheduled({}, env(kv));
    expect(alertSubjects(calls)).toHaveLength(1);
    expect(alertSubjects(again)).toHaveLength(1);
  });

  it("below the limit sends nothing", async () => {
    const calls = spikeFetch(49);
    await worker.scheduled({}, env(fakeKv()));
    expect(alertSubjects(calls)).toEqual([]);
  });
});
