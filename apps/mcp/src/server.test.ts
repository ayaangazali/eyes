import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Agent,
  AppConfig,
  type CaptureFields,
  ERRORS,
  EyesError,
  type EyesService,
  FAKE_STRIPE_SIGNATURE,
  fakeProviders,
  type OfferView,
  type PhotoUpload,
  QuoteTaskOutput,
  signToken,
  TOOLS,
  WorkerLocationInput,
} from "@eyes/core";
import type { Rpc } from "@eyes/db";
import { PAGE_HEADERS } from "@eyes/payments";
import { createEventLog, type EventLog, OPS_PAGE, PAGE } from "@eyes/web-dashboard";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, SMOKE_UA } from "./server.ts";

const KEY = "eyes_test_key";
const SECRET = "x".repeat(32);
const AGENT: Agent = {
  id: "0b6c8f9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
  name: "test-agent",
  api_key_hash: "hash",
  email_identity: null,
  balance_cents: 2000,
  daily_cap_cents: 5000,
  max_bounty_cents: 1000,
  allowed_task_types: ["is_open", "line_length"],
  created_at: "2026-10-17T19:00:00.000Z",
};
const TASK_ID = "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b";
const QUOTE = {
  workers_nearby: 3,
  est_minutes_to_answer: 12,
  suggested_bounty_usd: 3,
  allowed: true,
  reason_if_not: null,
  resolved_location: {
    lat: 37.78246,
    lng: -122.40776,
    label: "Blue Bottle Coffee, Mint Plaza, San Francisco",
  },
};

const OPS_KEY = "ops-5f2c9a1e7b3d4c8a9e0f1a2b3c4d5e6f";
const FEED = {
  tasks: [{ id: TASK_ID, lat: 37.78246, lng: -122.40776, photo_url: "https://storage.eyes.test/p.jpg" }],
  ledger: [],
  workers: [{ lat: 37.78246, lng: -122.40776, available: true, opted_in: true }],
  totals: { escrowed_cents: 0, released_today_cents: 0, paid_out_today_cents: 0 },
};

const OFFER: OfferView = {
  task_id: TASK_ID,
  question: "How long is the line?",
  task_type: "line_length",
  place_label: "Blue Bottle Coffee, Mint Plaza, San Francisco",
  lat: 37.78246,
  lng: -122.40776,
  radius_m: 150,
  bounty_usd: 3,
  deadline_at: "2026-10-17T19:30:00.000Z",
  require_photo: true,
  status: "claimed",
  claimed_by_you: true,
};

function setup(overrides: Partial<EyesService> = {}, env: Record<string, string> = {}) {
  const captures: { token: string; fields: CaptureFields; photo: PhotoUpload | null }[] = [];
  const awaitSignals: (AbortSignal | undefined)[] = [];
  const service: Partial<EyesService> = {
    authenticate: async (key) => (key === KEY ? AGENT : null),
    signupAgent: async () => ({
      agent_id: AGENT.id,
      api_key: KEY,
      balance_usd: 20,
      top_up_url: null,
      email_address: null,
      next_step: "Call quote_task.",
    }),
    quoteTask: async () => QUOTE,
    askEyes: async () => {
      throw new EyesError("insufficient_balance", {
        balance_usd: 1.2,
        needed_usd: 3.5,
        top_up_url: "https://eyes.test/topup/abc",
        max_affordable_bounty_usd: 0.7,
      });
    },
    awaitAnswer: async (_agent, input, signal) => {
      awaitSignals.push(signal);
      return {
        task_id: input.task_id,
        status: "dispatched",
        answered: false,
        answer: null,
        next_step: "Call await_answer again.",
      };
    },
    getTask: async () => {
      throw new Error("connect ECONNREFUSED postgres://admin:hunter2@db.internal");
    },
    cancelTask: async () => {
      throw new EyesError("task_not_cancellable");
    },
    getOffer: async () => OFFER,
    submitCapture: async (token, fields, photo) => {
      captures.push({ token, fields, photo });
      return {
        task_id: TASK_ID,
        status: "submitted",
        verification: { gps_ok: true, fresh_ok: true, vision_ok: true, vision_reason: "ok" },
        message: "Thanks!",
      };
    },
    ...overrides,
  };
  const config = AppConfig.parse({
    public_api_url: "http://api.eyes.test",
    worker_web_url: "http://worker.eyes.test",
    link_secret: SECRET,
    live_payouts: true,
  });
  const providers = fakeProviders();
  const rpcCalls: { fn: string; args: unknown }[] = [];
  const rpc = (async (fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    return [FEED];
  }) as Rpc;
  const server = createServer({
    service: service as EyesService,
    providers,
    config,
    env,
    rpc,
  });
  const fetch = (url: string | URL, init?: RequestInit) => server.fetch(new Request(url, init));
  return { server, fetch, captures, awaitSignals, rpcCalls, clock: providers.clock };
}

async function connect(fetch: ReturnType<typeof setup>["fetch"]) {
  const client = new Client({ name: "eyes-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://eyes.test/mcp"), {
      fetch,
      requestInit: { headers: { authorization: `Bearer ${KEY}` } },
    }),
  );
  return client;
}

const parseText = (result: { content?: unknown }) => {
  const [block] = result.content as { type: string; text: string }[];
  return JSON.parse(block?.text ?? "null");
};

describe("auth", () => {
  const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const cases: [string, Record<string, string>][] = [
    ["missing", {}],
    ["bad", { authorization: "Bearer nope" }],
  ];

  it.each(cases)("rejects a %s key on /mcp and /v1 with the unauthorized body", async (_, headers) => {
    const { fetch } = setup();
    const unauthorized = new EyesError("unauthorized").toBody();
    const mcp = await fetch("http://eyes.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(rpc),
    });
    expect(mcp.status).toBe(401);
    expect(await mcp.json()).toEqual(unauthorized);
    const rest = await fetch("http://eyes.test/v1/balance", { headers });
    expect(rest.status).toBe(401);
    expect(await rest.json()).toEqual(unauthorized);
    const ask = await fetch("http://eyes.test/v1/tasks", { method: "POST", headers, body: "{}" });
    expect(ask.status).toBe(401);
    expect(await ask.json()).toEqual(unauthorized);
  });

  it("accepts a lowercase bearer scheme", async () => {
    const { fetch } = setup();
    const res = await fetch("http://eyes.test/v1/quote", {
      method: "POST",
      headers: { authorization: `bearer ${KEY}` },
      body: JSON.stringify({ location: "Ferry Building, San Francisco", task_type: "line_length" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(QUOTE);
  });

  it("leaves POST /v1/signup public", async () => {
    const { fetch } = setup();
    const res = await fetch("http://eyes.test/v1/signup", {
      method: "POST",
      body: JSON.stringify({ name: "my-agent" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ api_key: KEY });
  });
});

describe("worker location", () => {
  it.each(["/w/location", "/v1/worker/location"])(
    "%s passes the bearer token and body to the service and answers 204, with no agent key",
    async (path) => {
      const calls: unknown[][] = [];
      const { fetch } = setup({ updateWorkerLocation: async (...args) => void calls.push(args) });
      const res = await fetch(`http://eyes.test${path}`, {
        method: "POST",
        headers: { authorization: "Bearer code123", "content-type": "text/plain" },
        body: JSON.stringify({ lat: "37,761", lng: "-122,386", source: "shortcut" }),
      });
      expect(res.status).toBe(204);
      expect(calls).toEqual([["code123", { lat: "37,761", lng: "-122,386", source: "shortcut" }]]);
    },
  );

  it("answers 401 without a bearer token and passes the service's 429 through", async () => {
    const { fetch } = setup({
      updateWorkerLocation: async () => {
        throw new EyesError("rate_limited", { retry_after_s: 30 });
      },
    });
    const post = (headers: Record<string, string>) =>
      fetch("http://eyes.test/w/location", { method: "POST", headers, body: "{}" });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer x" })).status).toBe(429);
  });

  const ok = { lat: 37.761, lng: -122.386, source: "here_link" };
  it.each([
    [
      { ...ok, lat: "37,761", lng: " -122.386 " },
      { lat: 37.761, lng: -122.386 },
    ],
    [{ ...ok, accuracy_m: "12,5" }, { accuracy_m: 12.5 }],
    [{ ...ok, accuracy_m: "far", input: 7, captured_at: "yesterday" }, { accuracy_m: undefined }],
    [{ ...ok, input: "Eyes ping 0a1b2c3d" }, { input: "Eyes ping 0a1b2c3d" }],
    [{ ...ok, source: "app" }, { source: "app" }],
  ])("accepts %j", (body, expected) => {
    expect(WorkerLocationInput.parse(body)).toMatchObject(expected);
  });

  it.each([
    { ...ok, lat: 0, lng: 0 },
    { ...ok, lat: "0,0", lng: "0" },
    { ...ok, lat: 91 },
    { ...ok, lng: -180.5 },
    { ...ok, lat: "abc" },
    { ...ok, lat: "" },
    { ...ok, source: "gps" },
    { lng: ok.lng, source: ok.source },
  ])("rejects %j", (body) => {
    expect(WorkerLocationInput.safeParse(body).success).toBe(false);
  });
});

describe("worker device (ad hoc install)", () => {
  it("serves the ad hoc manifest and .ipa from storage without a redirect; 404 before any upload", async () => {
    const upstream: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      upstream.push(url);
      return url.endsWith("Eyes.ipa")
        ? new Response(new Uint8Array([80, 75, 3, 4]), { headers: { "content-length": "4" } })
        : new Response("<plist/>");
    });
    try {
      const { fetch } = setup({}, { INSFORGE_BASE_URL: "https://x.insforge.test/" });
      const ipa = await fetch("http://eyes.test/w/app/Eyes.ipa?v=abc");
      expect([ipa.status, ipa.headers.get("location"), ipa.headers.get("content-type")]).toEqual([
        200,
        null,
        "application/octet-stream",
      ]);
      expect([ipa.headers.get("content-length"), (await ipa.arrayBuffer()).byteLength]).toEqual(["4", 4]);
      const manifest = await fetch("http://eyes.test/w/app/manifest.plist");
      expect([manifest.headers.get("content-type"), manifest.headers.get("cache-control")]).toEqual([
        "application/xml",
        "no-cache",
      ]);
      expect(await manifest.text()).toBe("<plist/>");
      expect(upstream).toEqual([
        "https://x.insforge.test/api/storage/buckets/apps/objects/eyes-worker/Eyes.ipa",
        "https://x.insforge.test/api/storage/buckets/apps/objects/eyes-worker/manifest.plist",
      ]);
      vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
      expect((await fetch("http://eyes.test/w/app/Eyes.ipa")).status).toBe(404);
      expect((await setup().fetch("http://eyes.test/w/app/manifest.plist")).status).toBe(404);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  const UDID = "00008110-001A2B3C4D5E801E";
  const callback = (udid: string) =>
    Buffer.concat([
      Buffer.from([0x30, 0x82, 0x0a]), // CMS envelope bytes around the plist
      Buffer.from(
        `<?xml version="1.0"?><plist><dict><key>PRODUCT</key><string>iPhone18,1</string><key>UDID</key><string>${udid}</string><key>VERSION</key><string>23F79</string></dict></plist>`,
      ),
      Buffer.from([0x00, 0xa0]),
    ]);

  it("POST /w/device passes the bearer code to the service and returns its JSON; 401 without one", async () => {
    const codes: string[] = [];
    const state = { profile_url: "http://api.eyes.test/w/device/profile/t", registered: false, ready: false };
    const { fetch } = setup({
      workerDevice: async (code) => {
        codes.push(code);
        return state;
      },
    });
    const res = await fetch("http://eyes.test/w/device", {
      method: "POST",
      headers: { authorization: "Bearer c0de" },
    });
    expect([res.status, await res.json(), codes]).toEqual([200, state, ["c0de"]]);
    expect((await fetch("http://eyes.test/w/device", { method: "POST" })).status).toBe(401);
  });

  it("serves the profile for a device ticket only, with a callback to the same ticket", async () => {
    const { fetch, clock } = setup();
    const ticket = signToken(SECRET, "d:worker-1", new Date(clock.now().getTime() + 60_000));
    const res = await fetch(`http://eyes.test/w/device/profile/${ticket}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-apple-aspen-config");
    const body = await res.text();
    expect(body).toContain(`<string>http://api.eyes.test/w/device/${ticket}</string>`);
    expect(body).toContain("<string>Profile Service</string>");
    for (const bad of [signToken(SECRET, "l:worker-1"), "nope"])
      expect((await fetch(`http://eyes.test/w/device/profile/${bad}`)).status).toBe(401);
  });

  it("stores the posted UDID and redirects (301) to the install page; rejects a body without one", async () => {
    const calls: unknown[][] = [];
    const { fetch } = setup({ addWorkerDevice: async (...args) => void calls.push(args) });
    const post = (body: Buffer) =>
      fetch("http://eyes.test/w/device/t1", {
        method: "POST",
        body: new Uint8Array(body),
        redirect: "manual",
      });
    const res = await post(callback(UDID));
    expect([res.status, res.headers.get("location")]).toEqual([
      301,
      "http://worker.eyes.test/install?registered=1",
    ]);
    expect(calls).toEqual([["t1", { udid: UDID, product: "iPhone18,1", version: "23F79" }]]);
    expect((await post(callback("not-a-udid"))).status).toBe(400);
    expect(calls).toHaveLength(1);
  });
});

describe("signup and join throttle", () => {
  it.each([
    ["/v1/signup", { name: "my-agent" }],
    ["/w/join", { name: "Ana Diaz", phone: "+14155550121", lat: 37.78246, lng: -122.40776 }],
  ])("allows 5 valid %s calls per hour per right-most X-Forwarded-For entry", async (path, body) => {
    const joined = {
      opt_in_instructions: "Text START.",
      inkbox_number: null,
      connect_url: null,
    };
    const { fetch, clock } = setup(
      { joinWorker: async () => joined },
      { INKBOX_PHONE_NUMBER: "+14155550199" },
    );
    const call = (forwardedFor: string, json: unknown = body) =>
      fetch(`http://eyes.test${path}`, {
        method: "POST",
        headers: { "x-forwarded-for": forwardedFor },
        body: JSON.stringify(json),
      });

    for (let i = 0; i < 5; i++) expect((await call("203.0.113.9", {})).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await call(`198.51.100.${i}, 203.0.113.9`)).status).toBe(200);
    const limited = await call("198.51.100.99, 203.0.113.9");
    expect(limited.status).toBe(429);
    const err = await limited.json();
    expect(err).toMatchObject({ error: "rate_limited", retry_after_s: 3600 });
    expect(err.fix).toContain("Wait 3600 seconds");
    expect((await call("203.0.113.9, 203.0.113.10")).status).toBe(200);
    clock.advance(3600 * 1000);
    expect((await call("203.0.113.9")).status).toBe(200);
  });

  const caller = () => {
    const { fetch } = setup(
      {
        joinWorker: async () => ({
          opt_in_instructions: "Text START.",
          inkbox_number: null,
          connect_url: null,
        }),
      },
      { INKBOX_PHONE_NUMBER: "+14155550199" },
    );
    return (path: string, forwardedFor: string) =>
      fetch(`http://eyes.test${path}`, {
        method: "POST",
        headers: { "x-forwarded-for": forwardedFor },
        body: JSON.stringify(
          path === "/w/join"
            ? { name: "Ana Diaz", phone: "+14155550121", lat: 37.78246, lng: -122.40776 }
            : { name: "my-agent" },
        ),
      });
  };

  it("gives signup and join separate budgets for one address", async () => {
    const call = caller();
    for (let i = 0; i < 5; i++) await call("/v1/signup", "203.0.113.9");
    expect((await call("/v1/signup", "203.0.113.9")).status).toBe(429);
    expect((await call("/w/join", "203.0.113.9")).status).toBe(200);
  });

  it("keys a client on the first 64 characters of its address", async () => {
    const call = caller();
    const long = "x".repeat(64);
    for (let i = 0; i < 5; i++) expect((await call("/v1/signup", `${long}${i}`)).status).toBe(200);
    expect((await call("/v1/signup", `${long}9`)).status).toBe(429);
  });

  it("keys an IPv6 client on its /64 and an IPv4-mapped client on its IPv4 address", async () => {
    const call = caller();
    for (const address of [
      "2001:db8:1:2::1",
      "2001:0DB8:0001:0002:ffff::9",
      "2001:db8:1:2:3:4:5:6",
      "2001:db8:1:2::1.2.3.4",
      "2001:db8:1:2::",
    ]) {
      expect((await call("/v1/signup", address)).status).toBe(200);
    }
    expect((await call("/v1/signup", "2001:db8:1:2:aaaa:bbbb:cccc:dddd")).status).toBe(429);
    expect((await call("/v1/signup", "2001:db8:1::2:3:4:5")).status).toBe(200);
    expect((await call("/v1/signup", "2001:db8:1:3::1")).status).toBe(200);

    for (let i = 0; i < 5; i++) await call("/v1/signup", "::ffff:198.51.100.7");
    expect((await call("/v1/signup", "198.51.100.7")).status).toBe(429);
    expect((await call("/v1/signup", "::ffff:198.51.100.8")).status).toBe(200);
  });

  it("forgets the oldest address once 10,000 are held", async () => {
    const { fetch } = setup();
    const signup = (forwardedFor: string) =>
      fetch("http://eyes.test/v1/signup", {
        method: "POST",
        headers: { "x-forwarded-for": forwardedFor },
        body: JSON.stringify({ name: "my-agent" }),
      });
    for (let i = 0; i < 5; i++) await signup("203.0.113.9");
    expect((await signup("203.0.113.9")).status).toBe(429);
    for (let i = 0; i < 9_998; i++) await signup(`10.0.${i >> 8}.${i & 255}`);
    expect((await signup("203.0.113.9")).status).toBe(429);
    await signup("10.1.0.0");
    expect((await signup("203.0.113.9")).status).toBe(200);
  }, 30_000);
});

describe("MCP tools", () => {
  it("lists every tool with read-only and idempotent hints", async () => {
    const client = await connect(setup().fetch);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOLS).sort());
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const name of [
      "quote_task",
      "await_answer",
      "get_task",
      "list_tasks",
      "get_balance",
      "get_spend_policy",
    ]) {
      expect(hints[name]?.readOnlyHint, name).toBe(true);
    }
    expect(hints.ask_eyes).toMatchObject({ readOnlyHint: false, idempotentHint: true });
    expect(tools.every((t) => t.outputSchema && (t.description ?? "").includes("Next:"))).toBe(true);
  });

  it("returns structuredContent that matches the output schema", async () => {
    const client = await connect(setup().fetch);
    const result = await client.callTool({
      name: "quote_task",
      arguments: { location: "Blue Bottle Coffee, Mint Plaza, San Francisco", task_type: "line_length" },
    });
    expect(result.isError).toBeFalsy();
    expect(QuoteTaskOutput.parse(result.structuredContent)).toEqual(QUOTE);
    expect(parseText(result)).toEqual(QUOTE);
  });

  it("turns an EyesError into isError with the catalog body and fix", async () => {
    const client = await connect(setup().fetch);
    const result = await client.callTool({
      name: "ask_eyes",
      arguments: {
        question: "How long is the line?",
        location: "Blue Bottle Coffee, Mint Plaza, San Francisco",
        task_type: "line_length",
        idempotency_key: "k1",
      },
    });
    expect(result.isError).toBe(true);
    const body = parseText(result);
    expect(body).toMatchObject({ error: "insufficient_balance", balance_usd: 1.2, needed_usd: 3.5 });
    expect(body.fix).toContain("https://eyes.test/topup/abc");
  });

  it("answers ask_eyes with no workers nearby as not_sent, not an error; REST keeps the 409", async () => {
    const { fetch } = setup({
      askEyes: async () => {
        throw new EyesError("no_workers_nearby");
      },
    });
    const args = {
      question: "How long is the line?",
      location: "Ferry Building, San Francisco",
      task_type: "line_length",
      idempotency_key: "k2",
    };
    const result = await (await connect(fetch)).callTool({ name: "ask_eyes", arguments: args });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      status: "not_sent",
      reason: "no_workers_nearby",
      charged_usd: 0,
      message: ERRORS.no_workers_nearby.message,
      fix: ERRORS.no_workers_nearby.fix,
    });
    const rest = await fetch("http://eyes.test/v1/tasks", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body: JSON.stringify(args),
    });
    expect(rest.status).toBe(409);
    expect(await rest.json()).toMatchObject({ error: "no_workers_nearby" });
  });

  it("does not leak the message of an unexpected error", async () => {
    const client = await connect(setup().fetch);
    const result = await client.callTool({ name: "get_task", arguments: { task_id: TASK_ID } });
    expect(result.isError).toBe(true);
    expect(parseText(result)).toEqual(new EyesError("internal_error").toBody());
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("passes an AbortSignal to awaitAnswer and reports progress", async () => {
    const { fetch, awaitSignals } = setup();
    const client = await connect(fetch);
    const progress: unknown[] = [];
    const result = await client.callTool(
      { name: "await_answer", arguments: { task_id: TASK_ID, timeout_seconds: 5 } },
      { onprogress: (p) => progress.push(p) },
    );
    expect(result.structuredContent).toMatchObject({ task_id: TASK_ID, answered: false });
    expect(awaitSignals[0]).toBeInstanceOf(AbortSignal);
    expect(progress[0]).toMatchObject({ progress: 0, total: 5 });
  });
});

describe("REST mirror", () => {
  it("serves list_tasks at GET /v1/tasks from query parameters with the default limit", async () => {
    const inputs: unknown[] = [];
    const { fetch } = setup({
      listTasks: async (_agent, input) => {
        inputs.push(input);
        return { tasks: [], next_step: "Call ask_eyes." };
      },
    });
    const get = (query: string) =>
      fetch(`http://eyes.test/v1/tasks${query}`, { headers: { authorization: `Bearer ${KEY}` } });
    expect((await get("?status=dispatched&limit=5")).status).toBe(200);
    expect((await get("")).status).toBe(200);
    expect((await get("?status=&limit=")).status).toBe(200);
    for (const bad of ["?limit=51", "?limit=abc", "?status=lost"]) {
      const res = await get(bad);
      expect(res.status, bad).toBe(400);
      expect(await res.json(), bad).toMatchObject({ error: "invalid_input" });
    }
    expect(inputs).toEqual([{ status: "dispatched", limit: 5 }, { limit: 20 }, { limit: 20 }]);
  });

  it("returns the EyesError status code and body", async () => {
    const { fetch } = setup();
    const res = await fetch(`http://eyes.test/v1/tasks/${TASK_ID}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.status).toBe(ERRORS.task_not_cancellable.status);
    expect(await res.json()).toEqual(new EyesError("task_not_cancellable").toBody());
  });

  it("rejects an invalid body with invalid_input and issues", async () => {
    const { fetch } = setup();
    const res = await fetch("http://eyes.test/v1/quote", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ location: "Ferry Building, San Francisco", task_type: "spy_on_neighbor" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "invalid_input" });
    expect(body.issues).toEqual([expect.objectContaining({ path: "task_type" })]);
    expect(body.fix).toBe(`${ERRORS.invalid_input.fix} task_type: ${body.issues[0].message}`);
  });

  it("refuses ask_eyes with a missing, empty or too long idempotency_key, saying what to pass, before anything runs", async () => {
    let asked = 0;
    const { fetch } = setup({
      askEyes: async () => {
        asked++;
        throw new EyesError("no_workers_nearby");
      },
    });
    const args = {
      question: "How long is the line?",
      location: "Ferry Building, San Francisco",
      task_type: "line_length",
    };
    const explains =
      /idempotency_key: Required\. Pass any unique string for each task you intend to create.*send the same key again when you retry that task/;
    const res = await fetch("http://eyes.test/v1/tasks", {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}` },
      body: JSON.stringify(args),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({
      error: "invalid_input",
      issues: [expect.objectContaining({ path: "idempotency_key" })],
    });
    expect(body.fix).toMatch(explains);
    const result = await (await connect(fetch)).callTool({ name: "ask_eyes", arguments: args });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(explains);
    for (const [key, says] of [
      ["", "idempotency_key: Must not be empty."],
      ["k".repeat(129), "idempotency_key: At most 128 characters."],
    ]) {
      const bad = await fetch("http://eyes.test/v1/tasks", {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ ...args, idempotency_key: key }),
      });
      const { fix } = await bad.json();
      expect(fix).toContain(says);
      expect(fix).not.toContain("Required.");
    }
    expect(asked).toBe(0);
  });

  it("does not leak the message of an unexpected error", async () => {
    const { fetch } = setup();
    const res = await fetch(`http://eyes.test/v1/tasks/${TASK_ID}`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(new EyesError("internal_error").toBody());
    expect(text).not.toContain("hunter2");
  });
});

describe("worker capture", () => {
  const token = signToken(SECRET, "offer-1");
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const captureForm = (extra: Record<string, string | File> = {}) => {
    const form = new FormData();
    const fields = {
      lat: "37.78246",
      lng: "-122.40776",
      accuracy_m: "12",
      captured_at: "2026-10-17T19:05:00.000Z",
      ...extra,
    };
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    return form;
  };
  const post = (fetch: ReturnType<typeof setup>["fetch"], t: string, init: RequestInit) =>
    fetch(`http://eyes.test/w/offers/${t}/capture`, { method: "POST", ...init });

  it("parses the multipart form into CaptureFields and a photo typed by its bytes", async () => {
    const { fetch, captures } = setup();
    const body = captureForm({
      answer_text: " About 4 people in line ",
      answer_bool: "true",
      photo: new File([jpeg], "photo", { type: "application/octet-stream" }),
    });
    const res = await post(fetch, token, { body });
    expect(res.status).toBe(200);
    expect(captures).toEqual([
      {
        token,
        fields: {
          lat: 37.78246,
          lng: -122.40776,
          accuracy_m: 12,
          captured_at: "2026-10-17T19:05:00.000Z",
          answer_text: "About 4 people in line",
          answer_bool: true,
        },
        photo: { bytes: jpeg, content_type: "image/jpeg" },
      },
    ]);
  });

  it("treats blank answer fields and a missing photo as null", async () => {
    const { fetch, captures } = setup();
    await post(fetch, token, { body: captureForm({ answer_text: "   ", answer_bool: " " }) });
    expect(captures[0]?.fields).toMatchObject({ answer_text: null, answer_bool: null });
    expect(captures[0]?.photo).toBeNull();
  });

  it("rejects a file that is not a JPEG, PNG or WebP image even when labelled image/jpeg", async () => {
    const { fetch, captures } = setup();
    const html = new File(["<html><script>alert(1)</script></html>"], "photo.jpg", { type: "image/jpeg" });
    const res = await post(fetch, token, { body: captureForm({ photo: html }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: "invalid_input", issues: [{ path: "photo" }] });
    expect(body.fix).toEqual(expect.any(String));
    expect(captures).toEqual([]);
  });

  it.each([
    ["unsigned", "tok123"],
    ["expired", signToken(SECRET, "offer-1", new Date("2026-10-17T18:00:00.000Z"))],
  ])("rejects an %s link token with offer_invalid before reading the body", async (_, t) => {
    const { fetch, captures } = setup();
    const res = await post(fetch, t, { body: captureForm() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(new EyesError("offer_invalid").toBody());
    expect(captures).toEqual([]);
  });

  it("answers a malformed multipart body with invalid_input", async () => {
    const { fetch, captures } = setup();
    const res = await post(fetch, token, {
      headers: { "content-type": "multipart/form-data; boundary=zzz" },
      body: "not multipart at all",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
    expect(captures).toEqual([]);
  });

  const neverEnding = () => {
    let pulls = 0;
    const body = new ReadableStream(
      {
        pull: () => {
          pulls += 1;
          return new Promise<void>(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    return { body, pulls: () => pulls };
  };
  const postStream = (fetch: ReturnType<typeof setup>["fetch"], t: string, body: ReadableStream) =>
    fetch(`http://eyes.test/w/offers/${t}/capture`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=zzz" },
      body,
      duplex: "half",
    } as RequestInit);
  const holdSubmits = () => {
    let release = () => {};
    let entered = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submitCapture: EyesService["submitCapture"] = async () => {
      entered += 1;
      await gate;
      return {
        task_id: TASK_ID,
        status: "submitted",
        verification: { gps_ok: true, fresh_ok: true, vision_ok: true, vision_reason: "ok" },
        message: "Thanks!",
      };
    };
    return { release, submitCapture, entered: () => entered };
  };
  const unknownOffer = async (): Promise<OfferView> => {
    throw new EyesError("offer_invalid");
  };
  const cases: [string, Partial<EyesService>, string, number, string][] = [
    ["an unsigned token", {}, "tok123", 404, "offer_invalid"],
    ["an unknown offer", { getOffer: unknownOffer }, token, 404, "offer_invalid"],
    [
      "a submitted offer",
      { getOffer: async () => ({ ...OFFER, status: "submitted" }) },
      token,
      404,
      "offer_invalid",
    ],
    [
      "another worker's offer",
      { getOffer: async () => ({ ...OFFER, claimed_by_you: false }) },
      token,
      409,
      "task_already_claimed",
    ],
  ];

  it.each(cases)("rejects %s without pulling a byte of the body", async (_, overrides, t, status, error) => {
    const { fetch, captures } = setup(overrides);
    const stream = neverEnding();
    const res = await postStream(fetch, t, stream.body);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error });
    expect(stream.pulls()).toBe(0);
    expect(captures).toEqual([]);
  });

  it("lets a fifth worker upload while four other workers' uploads are in flight", async () => {
    const held = holdSubmits();
    const { fetch } = setup({ submitCapture: held.submitCapture });
    const inFlight = [1, 2, 3, 4].map((n) =>
      post(fetch, signToken(SECRET, `offer-${n}`), { body: captureForm() }),
    );
    await vi.waitFor(() => expect(held.entered()).toBe(4));

    const fifth = post(fetch, signToken(SECRET, "offer-5"), { body: captureForm() });
    await vi.waitFor(() => expect(held.entered()).toBe(5));
    held.release();

    const done = await Promise.all([...inFlight, fifth]);
    expect(done.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
  });

  it("allows one upload per token at a time", async () => {
    const held = holdSubmits();
    const { fetch } = setup({ submitCapture: held.submitCapture });
    const first = post(fetch, token, { body: captureForm() });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const stream = neverEnding();
    const second = await postStream(fetch, token, stream.body);
    const variant = neverEnding();
    const suffixed = await postStream(fetch, `${token}.a`, variant.body);
    held.release();

    expect(second.status).toBe(429);
    expect(stream.pulls()).toBe(0);
    expect(suffixed.status).toBe(404);
    expect(await suffixed.json()).toMatchObject({ error: "offer_invalid" });
    expect(variant.pulls()).toBe(0);
    expect((await first).status).toBe(200);
    expect((await post(fetch, token, { body: captureForm() })).status).toBe(200);
  });
});

describe("routes", () => {
  it("mounts the Stripe routes at the root", async () => {
    const onboarded: string[] = [];
    const { fetch } = setup(
      { markWorkerOnboarded: async (id) => void onboarded.push(id) },
      { EYES_FAKE_WEBHOOKS: "1" },
    );
    const webhook = await fetch("http://eyes.test/webhooks/stripe", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": FAKE_STRIPE_SIGNATURE },
      body: JSON.stringify({ type: "worker.onboarded", account_id: "acct_123" }),
    });
    expect(webhook.status).toBe(200);
    expect(await webhook.json()).toEqual({ received: true });
    expect(onboarded).toEqual(["acct_123"]);
    const done = await fetch("http://eyes.test/topup/done");
    expect(done.status).toBe(200);
    expect(done.headers.get("content-type")).toContain("text/html");
  });

  it("refuses a fake-signed Stripe webhook while payments are fake unless EYES_FAKE_WEBHOOKS=1", async () => {
    const credited: unknown[] = [];
    const topup = (env: Record<string, string>) =>
      setup({ creditTopup: async (input) => void credited.push(input) }, env).fetch(
        "http://eyes.test/webhooks/stripe",
        {
          method: "POST",
          headers: { "content-type": "application/json", "stripe-signature": FAKE_STRIPE_SIGNATURE },
          body: JSON.stringify({
            type: "topup.completed",
            agent_id: AGENT.id,
            amount_cents: 100_000,
            ref: "cs_forged",
          }),
        },
      );
    const fakePayments: Record<string, string>[] = [
      {},
      { EYES_PROVIDERS: "live" },
      { STRIPE_SECRET_KEY: "sk_test_x" },
    ];
    for (const env of fakePayments) {
      const res = await topup(env);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ message: "Unknown route.", path: "/webhooks/stripe" });
    }
    expect(credited).toEqual([]);
    const done = await setup().fetch("http://eyes.test/topup/done");
    expect(done.status).toBe(200);
    expect((await topup({ EYES_FAKE_WEBHOOKS: "1" })).status).toBe(200);
    expect((await topup({ EYES_PROVIDERS: "live", STRIPE_SECRET_KEY: "sk_test_x" })).status).toBe(200);
    expect(credited).toHaveLength(2);
  });

  it("reports each provider as live only in live mode with its key", async () => {
    const health = async (env: Record<string, string>) =>
      (await (await setup({}, env).fetch("http://eyes.test/healthz")).json()).providers;
    const insforge = { INSFORGE_BASE_URL: "https://x.insforge.test", INSFORGE_API_KEY: "ik_test" };
    expect(await health({ EYES_PROVIDERS: "live", ...insforge })).toMatchObject({
      storage: "live",
      vision: "fake",
      geo: "live",
    });
    expect(await health({ EYES_PROVIDERS: "live", INSFORGE_API_KEY: "ik_test" })).toMatchObject({
      storage: "fake",
    });
    expect(await health(insforge)).toMatchObject({ storage: "fake", geo: "fake" });
  });

  it("shows each provider, the database and the deployed commit on /status", async () => {
    const env = { EYES_PROVIDERS: "live", INKBOX_API_KEY: "ik_test", EYES_COMMIT: "0123456789abcdef" };
    const res = await setup({}, env).fetch("http://eyes.test/status");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Texting: live");
    expect(page).toContain("Email: simulated");
    expect(page).toContain("Payments: simulated");
    expect(page).toContain("Photos: simulated");
    expect(page).toContain("Photo moderation: simulated");
    expect(page).toContain("Database: live");
    expect(page).toContain("money ledger (InsForge)");
    expect(page).toContain("<code>0123456789ab</code>");
    const rows =
      page
        .split('<ul class="rows">')[1]
        ?.split("</ul>")[0]
        ?.match(/<li>.*?<\/li>/g) ?? [];
    expect(rows).toHaveLength(9);
    for (const row of rows)
      expect(row).toMatch(/^<li><span class="dot (live|simulated|neutral)" aria-hidden="true"><\/span><b>/);
    expect(rows[0]).toContain('class="dot live"');
    expect(rows[1]).toContain('class="dot simulated"');
    const bare = await (
      await setup({}, { DATABASE_URL: "postgres://x" }).fetch("http://eyes.test/status")
    ).text();
    expect(bare).toContain("Texting: simulated");
    expect(bare).toContain("money ledger (Postgres)");
    expect(bare).not.toContain("Deployed commit");
    expect(bare).not.toContain("not recorded");
  });

  it("says on /status and the home page what is simulated and whether the safety classifier is on", async () => {
    const page = async (env: Record<string, string>, path: string) =>
      (await setup({}, env).fetch(`http://eyes.test${path}`)).text();
    const secret = "sk-ant-never-shown";
    const live = {
      EYES_PROVIDERS: "live",
      INKBOX_API_KEY: "ik_test",
      STRIPE_SECRET_KEY: "sk_test",
      PRIMITIVE_API_KEY: "pk_test",
      ANTHROPIC_API_KEY: secret,
    };
    for (const path of ["/status", "/"]) {
      const fake = await page({}, path);
      expect(fake, path).toContain("This is a simulated deploy");
      expect(fake, path).toContain("Texting is simulated: no worker gets a text, so no task gets answered.");
      expect(fake, path).toContain("Payments are simulated: no real money moves.");
      expect(fake, path).toContain("Email is simulated");
      expect(fake, path).toContain(
        "Place lookup is simulated: only {lat, lng} coordinates and these demo places",
      );
      for (const place of [
        "Blue Bottle Coffee, Mint Plaza, San Francisco",
        "Ferry Building, San Francisco",
      ]) {
        expect(fake, path).toContain(place);
      }
      const real = await page(live, path);
      expect(real, path).not.toContain("simulated deploy");
      expect(real, path).not.toContain(secret);
      const texting = await page({ EYES_PROVIDERS: "live", INKBOX_API_KEY: "ik_test" }, path);
      expect(texting, path).not.toContain("Texting is simulated");
      expect(texting, path).toContain("Payments are simulated");
      expect(texting, path).not.toContain("Place lookup is simulated");
      expect(texting, path).not.toContain("Ferry Building");
    }
    expect(await page({}, "/status")).toContain("Safety check: rules only");
    expect(await page({ ANTHROPIC_API_KEY: secret }, "/status")).toContain(
      "Safety check: rules and AI classifier",
    );
    expect(await page({}, "/")).toContain("Safety review is rules only here");
    expect(await page({ ANTHROPIC_API_KEY: secret }, "/")).toContain(
      "Every task passes the safety rules and an AI safety classifier",
    );
  });

  it("refuses /w/join without INKBOX_PHONE_NUMBER and never stores the phone", async () => {
    const joinWorker = vi.fn(async () => ({
      opt_in_instructions: "Text START.",
      inkbox_number: null,
      connect_url: null,
    }));
    const { fetch } = setup({ joinWorker });
    const res = await fetch("http://eyes.test/w/join", {
      method: "POST",
      body: JSON.stringify({ name: "Ana Diaz", phone: "+14155550121", lat: 37.78246, lng: -122.40776 }),
    });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: "not_implemented",
      message: "Worker sign-up is not open yet.",
      fix: "Worker sign-up opens once the Eyes texting line is set up.",
    });
    expect(joinWorker).not.toHaveBeenCalled();
  });

  it("fills the Inkbox number on /w/join from INKBOX_PHONE_NUMBER when the engine has none", async () => {
    const join = async (inkbox_number: string | null) => {
      const { fetch } = setup(
        {
          joinWorker: async () => ({
            opt_in_instructions: "Text START.",
            inkbox_number,
            connect_url: null,
          }),
        },
        { INKBOX_PHONE_NUMBER: "+14155550199" },
      );
      const res = await fetch("http://eyes.test/w/join", {
        method: "POST",
        body: JSON.stringify({ name: "Ana Diaz", phone: "+14155550121", lat: 37.78246, lng: -122.40776 }),
      });
      return (await res.json()).inkbox_number;
    };
    expect(await join(null)).toBe("+14155550199");
    expect(await join("+14155550100")).toBe("+14155550100");
  });

  it("answers an unknown route in a browser with an HTML page that links to the landing page", async () => {
    const res = await setup().fetch("http://eyes.test/no-such-page", {
      headers: { accept: "text/html,*/*" },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe(PAGE_HEADERS["Content-Security-Policy"]);
    const body = await res.text();
    expect(body).toContain("Page not found");
    expect(body).toContain('href="https://eyes.pictures"');
  });

  it("serves the display font of the server-rendered pages as an immutable woff2", async () => {
    const res = await setup().fetch("http://eyes.test/fonts/instrument-sans.woff2");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 4))).toBe("wOF2");
  });

  it("answers an unknown route with a JSON error that points at the docs", async () => {
    const res = await setup().fetch("http://eyes.test/nope");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ error: "invalid_input", message: "Unknown route.", path: "/nope" });
    expect(body.fix).toContain("/openapi.json");
  });
});

describe("page headers", () => {
  it("sends a CSP, no referrer and no-store on every public page and its error pages, and leaves JSON alone", async () => {
    const refuse = async () => {
      throw new EyesError("offer_invalid");
    };
    const { fetch } = setup({ topupCheckoutUrl: refuse, workerConnectUrl: refuse });
    for (const path of [
      "/",
      "/status",
      "/topup/done?amount_cents=500",
      "/topup/cancel",
      "/topup/not-a-token",
      "/w/connect/done",
      "/w/connect/not-a-token",
    ]) {
      const res = await fetch(`http://eyes.test${path}`);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      expect(res.headers.get("content-security-policy"), path).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      );
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
    const health = await fetch("http://eyes.test/healthz");
    expect([...health.headers.keys()].sort()).toEqual(["content-type"]);
  });
});

describe("agent docs", () => {
  const LINK = '</llms.txt>; rel="describedby", </openapi.json>; rel="service-desc"';
  let docsDir = "";

  beforeAll(async () => {
    docsDir = await mkdtemp(join(tmpdir(), "eyes-docs-"));
    await mkdir(join(docsDir, ".well-known"));
    await writeFile(join(docsDir, "robots.txt"), "User-agent: *\nAllow: /\n");
    await writeFile(
      join(docsDir, ".well-known/agent-card.json"),
      JSON.stringify({
        name: "Eyes",
        documentationUrl: "/llms.txt",
        supportedInterfaces: [{ url: "/mcp", protocolBinding: "https://example.test/spec" }],
        description: "/not-a-url-field",
      }),
    );
  });

  afterAll(async () => {
    await rm(docsDir, { recursive: true, force: true });
  });

  it("serves the home page with links and a Link header", async () => {
    const res = await setup({}, { EYES_DOCS_DIR: docsDir }).fetch("http://eyes.test/");
    expect(res.status).toBe(200);
    expect(res.headers.get("link")).toBe(LINK);
    const html = await res.text();
    expect(html).toContain("AI agents pay people nearby about $3 to check public places.");
    expect(html).toContain('<a class="button" href="http://worker.eyes.test">');
    expect(html).toContain("Reply <b>STOP</b> to stop all texts from Eyes");
    for (const href of [
      "/llms.txt",
      "/openapi.json",
      "/.well-known/agent-card.json",
      "/agents.md",
      "/status",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain("<code>POST /mcp</code>");
    expect(html).toContain("<code>POST /v1/signup</code>");
  });

  it("serves docs files with a Link header and 404s missing ones cleanly", async () => {
    const { fetch } = setup({}, { EYES_DOCS_DIR: docsDir });
    const robots = await fetch("http://eyes.test/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.headers.get("content-type")).toContain("text/plain");
    expect(robots.headers.get("link")).toBe(LINK);
    expect(await robots.text()).toContain("User-agent: *");
    const agents = await fetch("http://eyes.test/agents.md");
    expect(agents.status).toBe(404);
    expect(agents.headers.get("link")).toBe(LINK);
    expect(await agents.json()).toMatchObject({ path: "/agents.md", fix: expect.any(String) });
  });

  it("rewrites relative URLs in the agent card to absolute ones", async () => {
    const res = await setup({}, { EYES_DOCS_DIR: docsDir }).fetch(
      "http://eyes.test/.well-known/agent-card.json",
    );
    expect(await res.json()).toEqual({
      name: "Eyes",
      documentationUrl: "http://api.eyes.test/llms.txt",
      supportedInterfaces: [
        { url: "http://api.eyes.test/mcp", protocolBinding: "https://example.test/spec" },
      ],
      description: "/not-a-url-field",
    });
  });

  it("answers a malformed agent card with the clean not_implemented 404", async () => {
    const bad = await mkdtemp(join(tmpdir(), "eyes-docs-bad-"));
    await mkdir(join(bad, ".well-known"));
    await writeFile(join(bad, ".well-known/agent-card.json"), "{not json");
    const res = await setup({}, { EYES_DOCS_DIR: bad }).fetch("http://eyes.test/.well-known/agent-card.json");
    await rm(bad, { recursive: true, force: true });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: "not_implemented",
      path: "/.well-known/agent-card.json",
    });
  });
});

describe("ops dashboard", () => {
  const PAGES = ["/ops", "/ops/live", "/ops/allowlist"];
  const FEEDS = ["/ops/feed", "/ops/events", "/ops/tickets"];
  type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

  async function signIn(fetch: Fetch) {
    const res = await fetch(`http://localhost/ops/${OPS_KEY}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/ops");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(
      /^__Host-eyes_ops=[^;]+; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
    );
    return cookie.split(";")[0] ?? "";
  }

  it("sends browsers without a session to the sign-in page and answers feeds 401, without reading anything", async () => {
    const { fetch, rpcCalls } = setup({}, { EYES_OPS_KEY: OPS_KEY });
    for (const path of PAGES) {
      const res = await fetch(`http://localhost${path}`, { headers: { accept: "text/html" } });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/ops/login");
    }
    for (const path of [...PAGES, ...FEEDS]) {
      const res = await fetch(`http://localhost${path}`, { headers: { cookie: "__Host-eyes_ops=forged" } });
      expect(res.status).toBe(401);
    }
    expect(rpcCalls).toEqual([]);
  });

  it("answers a wrong or unset break-glass key exactly like an unknown route", async () => {
    const { fetch } = setup({}, { EYES_OPS_KEY: OPS_KEY });
    for (const key of [OPS_KEY.slice(0, -1), `${OPS_KEY}0`, OPS_KEY.toUpperCase()]) {
      const res = await fetch(`http://localhost/ops/${key}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    const unset = setup({}, { EYES_OPS_KEY: "" });
    expect((await unset.fetch(`http://localhost/ops/${OPS_KEY}`)).status).toBe(404);
  });

  it("signs in with the break-glass key and then serves the ops page, the live map and the feed, uncached, with a CSP that allows only each page's own script, and worker positions rounded to 3 decimals", async () => {
    const { fetch, rpcCalls } = setup({}, { EYES_OPS_KEY: OPS_KEY });
    const cookie = await signIn(fetch);
    const headers = { cookie };
    const ops = await fetch("http://localhost/ops", { headers });
    const live = await fetch("http://localhost/ops/live", { headers });
    const feed = await fetch("http://localhost/ops/feed", { headers });

    expect(feed.status).toBe(200);
    expect(await feed.json()).toMatchObject({
      ...FEED,
      workers: [{ lat: 37.782, lng: -122.408, available: true, opted_in: true }],
      ops: {
        operator: "break-glass",
        health: { db: "insforge", classifier: "rules only", commit: null, db_error: null },
        workers: { total: 1, opted_in: 1, online: 1 },
        queue: [],
        errors: [],
      },
    });
    expect(rpcCalls).toEqual([{ fn: "eyes_dashboard_feed", args: { p_limit: 500 } }]);
    for (const [res, page] of [
      [ops, OPS_PAGE],
      [live, PAGE],
    ] as const) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toBe(page);
      const inline = [...body.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
        ([, script = ""]) => `'sha256-${createHash("sha256").update(script).digest("base64")}'`,
      );
      expect(inline).toHaveLength(1);
      expect(res.headers.get("content-security-policy")).toBe(
        `default-src 'none'; script-src https://unpkg.com ${inline.join(" ")}; style-src https://unpkg.com 'unsafe-inline'; img-src https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      );
      // same-origin, not no-referrer: under no-referrer the page's own fetch POSTs carry `Origin: null`.
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
    }
    for (const res of [ops, live, feed]) expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("still serves health and the error log when the database read fails, with the failure redacted", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const events = createEventLog();
    events.log({ kind: "log", level: "error", summary: "boom" });
    const server = createServer({
      service: {} as EyesService,
      providers: fakeProviders(),
      config: AppConfig.parse({
        public_api_url: "http://api.eyes.test",
        worker_web_url: "http://worker.eyes.test",
        link_secret: SECRET,
      }),
      env: { EYES_OPS_KEY: OPS_KEY, CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_TOKEN: "t" },
      rpc: (async () => {
        throw new Error("connect ECONNREFUSED postgres://admin:hunter2@db.internal");
      }) as Rpc,
      events,
    });
    const fetch: Fetch = (url, init) => server.fetch(new Request(url, init));
    const res = await fetch("http://localhost/ops/feed", { headers: { cookie: await signIn(fetch) } });
    quiet.mockRestore();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ops.health).toMatchObject({
      classifier: "clef",
      db_error: "connect ECONNREFUSED postgres://[redacted]@db.internal",
    });
    expect(body.ops.errors).toMatchObject([{ kind: "log", level: "error", summary: "boom" }]);
    expect(body.tasks).toEqual([]);
  });

  it("logs 404s and smoke probes as info, other 4xx as warnings", async () => {
    const logged: { level?: string; summary: string }[] = [];
    const server = createServer({
      service: {} as EyesService,
      providers: fakeProviders(),
      config: AppConfig.parse({
        public_api_url: "http://api.eyes.test",
        worker_web_url: "http://worker.eyes.test",
        link_secret: SECRET,
      }),
      env: { EYES_OPS_KEY: OPS_KEY },
      events: { log: (e) => void logged.push(e), recent: () => [], flush: async () => {} } satisfies EventLog,
    });
    const smoke = { "user-agent": `${SMOKE_UA}1 (deliberate probes)` };
    const missing = await server.fetch(new Request("http://eyes.test/nope"));
    const denied = await server.fetch(new Request("http://eyes.test/v1/balance"));
    const probe = await server.fetch(new Request("http://eyes.test/v1/balance", { headers: smoke }));
    expect([missing.status, denied.status, probe.status]).toEqual([404, 401, 401]);
    expect(logged.map(({ level, summary }) => [level, summary.replace(/\d+ ms/, "ms")])).toEqual([
      ["info", "GET /nope 404 ms"],
      ["warn", "GET /v1/balance 401 ms"],
      ["info", "GET /v1/balance 401 ms (smoke probe)"],
    ]);
  });
});

describe("ChatGPT and Claude widget", () => {
  const WIDGET_TOOLS = ["quote_task", "ask_eyes", "await_answer", "get_task", "get_balance"];

  it("binds the five card tools to ui://eyes/card.html in both MCP Apps and ChatGPT metadata", async () => {
    const client = await connect(setup().fetch);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const meta = tool._meta as Record<string, unknown> | undefined;
      if (WIDGET_TOOLS.includes(tool.name)) {
        expect(meta, tool.name).toMatchObject({
          ui: { resourceUri: "ui://eyes/card.html" },
          "openai/outputTemplate": "ui://eyes/card.html",
        });
      } else {
        expect(meta?.ui, tool.name).toBeUndefined();
      }
    }
  });

  it("serves the card as an MCP Apps resource with the photo hosts in its CSP", async () => {
    const client = await connect(setup().fetch);
    const { contents } = await client.readResource({ uri: "ui://eyes/card.html" });
    const [card] = contents as unknown as {
      mimeType: string;
      text: string;
      _meta: { ui: { csp: { resourceDomains: string[] } } };
    }[];
    expect(card?.mimeType).toBe("text/html;profile=mcp-app");
    expect(card?.text).toContain('"ui/initialize"');
    expect(card?.text).toContain("ui/notifications/tool-result");
    expect(card?._meta.ui.csp.resourceDomains).toEqual([
      "https://pagp38bu.us-west.insforge.app",
      "https://cdn.insforge.dev",
    ]);
  });
});

describe("Claude sandbox domain", () => {
  const claudeDomain = `${createHash("sha256").update("http://api.eyes.test/mcp").digest("hex").slice(0, 32)}.claudemcpcontent.com`;
  const read = async (name: string, userAgent?: string) => {
    const { fetch } = setup();
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://eyes.test/mcp"), {
        fetch,
        requestInit: {
          headers: { authorization: `Bearer ${KEY}`, ...(userAgent ? { "user-agent": userAgent } : {}) },
        },
      }),
    );
    const { contents } = await client.readResource({ uri: "ui://eyes/card.html" });
    return (contents[0] as unknown as { _meta: { ui: { domain?: string }; "openai/widgetDomain": string } })
      ._meta;
  };

  it("sends Claude the hashed connector URL as ui.domain", async () => {
    expect((await read("mcp-client", "Claude-User/1.0"))?.ui.domain).toBe(claudeDomain);
  });

  it("leaves ui.domain out for other hosts and keeps openai/widgetDomain for ChatGPT", async () => {
    const meta = await read("openai-mcp", "openai-mcp/1.0.0");
    expect(meta?.ui.domain).toBeUndefined();
    expect(meta?.["openai/widgetDomain"]).toBe("http://api.eyes.test");
  });
});

describe("OAuth for connectors", () => {
  const OAUTH_SECRET = "s".repeat(64);
  const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
  const VERIFIER = "v".repeat(43);
  const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

  async function begin(overrides: Partial<EyesService> = {}) {
    const ctx = setup(overrides, { EYES_OAUTH_SECRET: OAUTH_SECRET });
    const reg = await ctx.fetch("http://eyes.test/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [REDIRECT] }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = await reg.json();
    const params = {
      response_type: "code",
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "st8",
    };
    const page = await ctx.fetch(`http://eyes.test/oauth/authorize?${new URLSearchParams(params)}`);
    const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const csrf = cookie.split("=")[1] ?? "";
    const submit = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
      ctx.fetch("http://eyes.test/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie, ...headers },
        body: new URLSearchParams({ ...params, csrf, ...fields }),
      });
    const token = (fields: Record<string, string>) =>
      ctx.fetch("http://eyes.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id,
          redirect_uri: REDIRECT,
          code_verifier: VERIFIER,
          ...fields,
        }),
      });
    return { ...ctx, client_id, params, page, submit, token };
  }

  it("publishes discovery metadata and challenges /mcp with resource_metadata", async () => {
    const { fetch } = setup({}, { EYES_OAUTH_SECRET: OAUTH_SECRET });
    const prm = await (await fetch("http://eyes.test/.well-known/oauth-protected-resource")).json();
    expect(prm).toMatchObject({
      resource: "http://api.eyes.test/mcp",
      authorization_servers: ["http://api.eyes.test"],
    });
    const as = await (await fetch("http://eyes.test/.well-known/oauth-authorization-server")).json();
    expect(as).toMatchObject({
      issuer: "http://api.eyes.test",
      registration_endpoint: "http://api.eyes.test/oauth/register",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    const res = await fetch("http://eyes.test/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://api.eyes.test/.well-known/oauth-protected-resource"',
    );
  });

  it("runs register, authorize with a key, token with PKCE, then MCP with the token", async () => {
    const { page, submit, token, fetch } = await begin();
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Connect ChatGPT to Eyes");
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' https://chatgpt.com");
    const redirect = await submit({ action: "key", api_key: KEY });
    expect(redirect.status).toBe(302);
    const back = new URL(redirect.headers.get("location") ?? "");
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st8");
    expect(back.searchParams.get("iss")).toBe("http://api.eyes.test");
    const res = await token({ code: back.searchParams.get("code") ?? "" });
    expect(res.status).toBe(200);
    const { access_token, token_type } = await res.json();
    expect(token_type).toBe("Bearer");
    const client = new Client({ name: "chatgpt-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://eyes.test/mcp"), {
        fetch,
        requestInit: { headers: { authorization: `Bearer ${access_token}` } },
      }),
    );
    expect((await client.listTools()).tools.length).toBe(Object.keys(TOOLS).length);
    const quote = await client.callTool({
      name: "quote_task",
      arguments: { location: "Blue Bottle Coffee, Mint Plaza, San Francisco", task_type: "line_length" },
    });
    expect(quote.structuredContent).toEqual(QUOTE);
  });

  it("creates a key through signup, shows it with its balance, and shares the /v1/signup budget", async () => {
    const { submit, fetch } = await begin();
    const ip = { "x-forwarded-for": "203.0.113.9" };
    for (let i = 0; i < 4; i++)
      await fetch("http://eyes.test/v1/signup", { method: "POST", headers: ip, body: '{"name":"my-agent"}' });
    const shown = await submit({ action: "create" }, ip);
    expect(shown.status).toBe(200);
    const body = await shown.text();
    expect(body).toContain(KEY);
    expect(body).toContain("$20.00");
    expect(body).toContain("code=");
    const limited = await submit({ action: "create" }, ip);
    expect(limited.status).toBe(400);
    expect(await limited.text()).toContain("calls per hour");
  });

  it("rejects a wrong verifier, an expired code, a tampered client_id and a redirect_uri mismatch", async () => {
    const { submit, token, params, fetch, client_id } = await begin();
    const code = new URL(
      (await submit({ action: "key", api_key: KEY })).headers.get("location") ?? "",
    ).searchParams.get("code") as string;
    const wrong = await token({ code, code_verifier: "w".repeat(43) });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
    expect((await token({ code, redirect_uri: "https://evil.example/cb" })).status).toBe(400);
    expect((await token({ code: `${code.slice(0, -2)}AA` })).status).toBe(400);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);
    try {
      expect(await (await token({ code })).json()).toMatchObject({ error: "invalid_grant" });
    } finally {
      vi.restoreAllMocks();
    }
    const tampered = { ...params, client_id: `${client_id.slice(0, -2)}AA` };
    expect((await fetch(`http://eyes.test/oauth/authorize?${new URLSearchParams(tampered)}`)).status).toBe(
      400,
    );
    const otherRedirect = { ...params, redirect_uri: "https://evil.example/cb" };
    const mismatch = await fetch(`http://eyes.test/oauth/authorize?${new URLSearchParams(otherRedirect)}`);
    expect(mismatch.status).toBe(400);
    expect(mismatch.headers.get("location")).toBeNull();
    const bad = await submit({ action: "key", api_key: "eyes_test_nope" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("That key is not valid");
    const noCsrf = await submit({ action: "key", api_key: KEY }, { cookie: "" });
    expect(noCsrf.status).toBe(400);
    expect(await noCsrf.text()).toContain("This form expired");
  });

  it("refuses non-https redirect_uris at registration and is off without EYES_OAUTH_SECRET", async () => {
    const { fetch } = setup({}, { EYES_OAUTH_SECRET: OAUTH_SECRET });
    const reg = await fetch("http://eyes.test/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
    });
    expect(reg.status).toBe(400);
    const off = setup();
    expect((await off.fetch("http://eyes.test/oauth/register", { method: "POST", body: "{}" })).status).toBe(
      404,
    );
  });

  it("validates registration bodies: bad JSON, non-string or unparsable URIs, hash, loopback, default name", async () => {
    const { fetch } = setup({}, { EYES_OAUTH_SECRET: OAUTH_SECRET });
    // mcp-use answers malformed application/json itself; text/plain bodies reach the route, whose
    // c.req.json() parses regardless of content type, so the catch for bad JSON is exercised.
    for (const body of [
      "{not json",
      ...[
        [],
        [123],
        ["not a url"],
        [`https://a.example/${"x".repeat(2000)}`],
        ["https://a.example/cb#f"],
      ].map((redirect_uris) => JSON.stringify({ redirect_uris })),
    ]) {
      const res = await fetch("http://eyes.test/oauth/register", { method: "POST", body });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
    }
    const loop = await fetch("http://eyes.test/oauth/register", {
      method: "POST",
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:3000/cb"], client_name: 7 }),
    });
    expect(loop.status).toBe(201);
    expect(await loop.json()).toMatchObject({
      client_name: "MCP client",
      redirect_uris: ["http://127.0.0.1:3000/cb"],
    });
  });

  it("refuses authorize without a client, with a code as client_id, or without S256 PKCE", async () => {
    const { submit, params, fetch } = await begin();
    const code = new URL(
      (await submit({ action: "key", api_key: KEY })).headers.get("location") ?? "",
    ).searchParams.get("code") as string;
    const { client_id: _, ...noClient } = params;
    const { code_challenge: __, ...noChallenge } = params;
    const refused: [Record<string, string>, string][] = [
      [noClient, "This app is not registered with Eyes"],
      [{ ...params, client_id: code }, "This app is not registered with Eyes"],
      [{ ...params, code_challenge_method: "plain" }, "PKCE (S256)"],
      [noChallenge, "PKCE (S256)"],
    ];
    for (const [q, message] of refused) {
      const res = await fetch(`http://eyes.test/oauth/authorize?${new URLSearchParams(q)}`);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(message);
    }
    const post = await submit({ action: "key", api_key: KEY, client_id: "nope" });
    expect(post.status).toBe(400);
    expect(await post.text()).toContain("Can't connect");
  });

  it("omits state when absent and treats a missing api_key as invalid", async () => {
    const { submit } = await begin();
    const back = new URL(
      (await submit({ action: "key", api_key: KEY, state: "" })).headers.get("location") ?? "",
    );
    expect(back.searchParams.has("state")).toBe(false);
    expect(back.searchParams.get("code")).toBeTruthy();
    const missing = await submit({ action: "key" });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain("That key is not valid");
  });

  it("shows the signup error message, or a generic one when the failure has no body", async () => {
    const withMessage = await begin({
      signupAgent: async () => {
        throw Object.assign(new Error("x"), { toBody: () => ({ message: "Signups are paused." }) });
      },
    });
    const paused = await withMessage.submit({ action: "create" });
    expect(paused.status).toBe(400);
    expect(await paused.text()).toContain("Signups are paused.");
    const plain = await begin({
      signupAgent: async () => {
        throw new Error("db down");
      },
    });
    const generic = await plain.submit({ action: "create" });
    expect(generic.status).toBe(400);
    const text = await generic.text();
    expect(text).toContain("Could not create a key. Try again later.");
    expect(text).not.toContain("db down");
  });

  it("rejects other grant types and a missing code_verifier at the token endpoint", async () => {
    const { submit, token, fetch, client_id } = await begin();
    const code = new URL(
      (await submit({ action: "key", api_key: KEY })).headers.get("location") ?? "",
    ).searchParams.get("code") as string;
    const refresh = await token({ code, grant_type: "refresh_token" });
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: "unsupported_grant_type" });
    const noVerifier = await fetch("http://eyes.test/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id,
        redirect_uri: REDIRECT,
      }),
    });
    expect(noVerifier.status).toBe(400);
    expect(await noVerifier.json()).toMatchObject({
      error: "invalid_grant",
      error_description: "code_verifier does not match the code_challenge.",
    });
    expect((await token({ code })).status).toBe(200);
  });
});

describe("ops data routes", () => {
  const T = { id: TASK_ID, lat: 37.78, lng: -122.4 };
  function opsServer(rpc: (fn: string, args: Record<string, unknown>) => unknown, extra: object = {}) {
    const events = createEventLog();
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const server = createServer({
      service: {} as EyesService,
      providers: fakeProviders(),
      config: AppConfig.parse({
        public_api_url: "http://api.eyes.test",
        worker_web_url: "http://worker.eyes.test",
        link_secret: SECRET,
      }),
      env: { EYES_OPS_KEY: OPS_KEY },
      rpc: (async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return rpc(fn, args);
      }) as Rpc,
      events,
      ...extra,
    });
    const fetch = (url: string, init?: RequestInit) => server.fetch(new Request(url, init));
    const cookie = async () => {
      const signin = await fetch(`http://localhost/ops/${OPS_KEY}`);
      return (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    };
    const get = async (path: string) =>
      fetch(`http://localhost${path}`, { headers: { cookie: await cookie() } });
    const post = async (path: string, body: unknown) =>
      fetch(`http://localhost${path}`, {
        method: "POST",
        headers: {
          cookie: await cookie(),
          origin: "http://api.eyes.test",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    return { get, post, calls, events };
  }

  it("serves time series from ClickHouse when it answers, with its drop count", async () => {
    const queries: string[] = [];
    const { get } = opsServer(() => [], {
      clickhouse: {
        query: async (sql: string) => {
          queries.push(sql);
          return [];
        },
        dropped: () => 3,
      },
    });
    const body = await (await get("/ops/series")).json();
    expect(body).toMatchObject({ source: "clickhouse", dropped: 3 });
    expect(queries.length).toBeGreaterThan(0);
  });

  it("falls back to Postgres series when ClickHouse fails, and to an empty feed when Postgres fails too", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const ch = {
      query: async () => {
        throw new Error("ch down");
      },
      dropped: () => 1,
    };
    const ok = opsServer(() => [{ tasks: [], ledger: [] }], { clickhouse: ch });
    expect(await (await ok.get("/ops/series")).json()).toMatchObject({ source: "postgres", dropped: 1 });
    expect(errors).toHaveBeenCalledWith("ops series: clickhouse read failed:", "ch down");
    const ch2 = { query: () => Promise.reject("raw"), dropped: () => 0 };
    const down = opsServer(
      () => {
        throw new Error("db down");
      },
      { clickhouse: ch2 },
    );
    expect(await (await down.get("/ops/series")).json()).toMatchObject({ source: "postgres", dropped: 0 });
    expect(errors).toHaveBeenCalledWith("ops series: clickhouse read failed:", "raw");
    const plain = opsServer(() => null);
    expect(await (await plain.get("/ops/series")).json()).toMatchObject({ source: "postgres", dropped: 0 });
    errors.mockRestore();
  });

  it("reads the event log from the database with sanitised filters", async () => {
    const { get, calls } = opsServer(() => [{ id: 1, kind: "call", summary: "x" }]);
    const res = await get(`/ops/events?kind=call&level=warn&q=%20boom%20&task_id=${TASK_ID}&before=42`);
    expect(await res.json()).toEqual({ source: "database", events: [{ id: 1, kind: "call", summary: "x" }] });
    expect(calls.at(-1)).toEqual({
      fn: "eyes_events",
      args: { p_limit: 200, p_kind: "call", p_level: "warn", p_q: "boom", p_task_id: TASK_ID, p_before: 42 },
    });
    await get("/ops/events?task_id=not-a-uuid&before=4x&q=%20");
    expect(calls.at(-1)?.args).toMatchObject({
      p_kind: null,
      p_level: null,
      p_q: null,
      p_task_id: null,
      p_before: null,
    });
  });

  it("filters the in-memory ring when the database read fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { get, events } = opsServer(() => {
      throw new Error("db down");
    });
    events.log({ kind: "call", level: "warn", task_id: TASK_ID, summary: "get_task task_not_found" });
    events.log({
      kind: "call",
      level: "info",
      task_id: TASK_ID,
      summary: "get_task ok",
      data: { Needle: 1 },
    });
    events.log({ kind: "text", level: "info", task_id: null, summary: "offer sent" });
    const summaries = async (query: string) => {
      const body = await (await get(`/ops/events${query}`)).json();
      expect(body.source).toBe("memory");
      return body.events.map((e: { summary: string }) => e.summary).sort();
    };
    expect(await summaries("")).toEqual(
      expect.arrayContaining(["break-glass login", "get_task ok", "get_task task_not_found", "offer sent"]),
    );
    expect(await summaries("?kind=call")).toEqual(["get_task ok", "get_task task_not_found"]);
    expect(await summaries("?kind=call&level=warn")).toEqual(["get_task task_not_found"]);
    expect(await summaries(`?task_id=${TASK_ID}&q=NEEDLE`)).toEqual(["get_task ok"]);
    expect(errors).toHaveBeenCalledWith("ops events: database read failed:", "db down");
    const raw = opsServer(() => Promise.reject("raw"));
    expect((await (await raw.get("/ops/events")).json()).source).toBe("memory");
    expect(errors).toHaveBeenCalledWith("ops events: database read failed:", "raw");
    errors.mockRestore();
  });

  it("lists tickets without worker ids, with the submission distance when there is one", async () => {
    const { get, calls } = opsServer(() => [
      { ...T, ticket_id: 1, worker_id: "w1", submission_lat: 37.78, submission_lng: -122.4 },
      { ...T, ticket_id: 2, worker_id: "w2", submission_lat: null, submission_lng: -122.4 },
      { ...T, ticket_id: 3, worker_id: "w3", submission_lat: 37.78, submission_lng: null },
    ]);
    const { tickets } = await (await get("/ops/tickets")).json();
    expect(tickets).toEqual([
      { ...T, ticket_id: 1, distance_m: 0 },
      { ...T, ticket_id: 2, distance_m: null },
      { ...T, ticket_id: 3, distance_m: null },
    ]);
    expect(calls).toEqual([{ fn: "eyes_tickets", args: { p_limit: 50 } }]);
  });

  it("reports Claude as the classifier, a non-Error db failure, and works without an event log", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { get } = opsServer(() => Promise.reject("socket closed"), {
      env: { EYES_OPS_KEY: OPS_KEY, ANTHROPIC_API_KEY: "sk-ant-test" },
      events: undefined,
    });
    const feed = await (await get("/ops/feed")).json();
    expect(feed.ops.health).toMatchObject({ classifier: "Claude", db_error: "socket closed" });
    expect(feed.ops.errors).toEqual([]);
    expect(await (await get("/ops/series")).json()).toMatchObject({ source: "postgres" });
    expect(await (await get("/ops/events?q=x")).json()).toEqual({ source: "memory", events: [] });
    errors.mockRestore();
  });

  it("rethrows a resolve failure that is not an already-resolved task", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failures = [new Error("db down"), new EyesError("invalid_input", { status: "dispatched" })];
    const { post } = opsServer(() => [], {
      service: {
        resolveTask: async () => {
          throw failures.shift();
        },
      },
    });
    expect((await post(`/ops/tasks/${TASK_ID}/resolve`, { outcome: "release" })).status).toBe(500);
    const res = await post(`/ops/tasks/${TASK_ID}/resolve`, { outcome: "refund" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
    errors.mockRestore();
  });

  it("logs a dispute decision as a warning when the reversal is owed, and marks a repeat click", async () => {
    const outcome = (reversal: string, already_resolved: boolean) => ({
      ticket_id: 7,
      task_id: TASK_ID,
      reversal,
      already_resolved,
    });
    const { post, events } = opsServer(() => [], {
      service: {
        confirmFraud: async () => outcome("owed", false),
        rejectDispute: async () => outcome("none", true),
      },
    });
    expect(await (await post("/ops/tickets/7/confirm_fraud", { note: "fake photo" })).json()).toMatchObject({
      reversal: "owed",
    });
    await post("/ops/tickets/7/reject_dispute", { note: "answer stands" });
    const ops = events.recent().filter((e) => e.kind === "ops");
    expect(ops.map((e) => [e.level, e.summary]).sort()).toEqual([
      ["info", "ticket #7 reject_dispute by break-glass (already resolved)"],
      ["warn", "ticket #7 confirm_fraud by break-glass"],
    ]);
  });

  it("shows task detail with or without a submission, and 404s unknown or malformed ids without querying", async () => {
    const task = { ...T, question: "q", place_label: "p", radius_m: 50, status: "paid", bounty_cents: 300 };
    const submission = {
      lat: 37.78,
      lng: -122.4,
      photo_url: "https://storage.eyes.test/p.jpg",
      answer_text: "short",
      answer_bool: true,
      gps_ok: true,
      fresh_ok: true,
      vision_ok: false,
      vision_reason: "blurry",
      confidence: 0.8,
      created_at: "2026-10-17T19:05:00.000Z",
    };
    let rows: unknown[] = [{ task, submission }];
    const { get, calls } = opsServer(() => rows);
    expect(await (await get(`/ops/tasks/${TASK_ID}`)).json()).toMatchObject({
      id: TASK_ID,
      status: "paid",
      photo_url: submission.photo_url,
      answer_bool: true,
      vision_ok: false,
      submitted_at: submission.created_at,
      distance_m: 0,
    });
    rows = [{ task, submission: null }];
    expect(await (await get(`/ops/tasks/${TASK_ID}`)).json()).toMatchObject({
      photo_url: null,
      answer_text: null,
      answer_bool: null,
      gps_ok: null,
      fresh_ok: null,
      vision_ok: null,
      vision_reason: null,
      confidence: null,
      submitted_at: null,
      distance_m: null,
    });
    rows = [];
    expect((await get(`/ops/tasks/${TASK_ID}`)).status).toBe(404);
    const before = calls.length;
    const bad = await get("/ops/tasks/nope");
    expect(bad.status).toBe(404);
    expect(await bad.json()).toMatchObject({ error: "task_not_found", message: "No task with this id." });
    expect(calls.length).toBe(before);
  });
});

describe("agent tools and REST mirrors forward the agent and parsed input", () => {
  const recorder = () => {
    const seen: { method: string; agent: unknown; input: unknown }[] = [];
    const fail =
      (method: string) =>
      async (agent: unknown, input?: unknown): Promise<never> => {
        seen.push({ method, agent: (agent as Agent).id, input });
        throw new EyesError("task_not_found");
      };
    const overrides = Object.fromEntries(
      ["listTasks", "cancelTask", "disputeAnswer", "getBalance", "getSpendPolicy", "awaitAnswer"].map((m) => [
        m,
        fail(m),
      ]),
    ) as Partial<EyesService>;
    return { seen, ...setup(overrides) };
  };

  it("runs list_tasks, cancel_task, dispute_answer, get_balance and get_spend_policy as tools", async () => {
    const { fetch, seen } = recorder();
    const client = await connect(fetch);
    const calls = [
      ["list_tasks", { status: "dispatched", limit: 5 }],
      ["cancel_task", { task_id: TASK_ID }],
      ["dispute_answer", { task_id: TASK_ID, reason: "The photo shows a different cafe." }],
      ["get_balance", {}],
      ["get_spend_policy", {}],
    ] as const;
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).toBe(true);
      expect(parseText(result)).toMatchObject({ error: "task_not_found" });
    }
    expect(seen.map((s) => [s.method, s.agent])).toEqual([
      ["listTasks", AGENT.id],
      ["cancelTask", AGENT.id],
      ["disputeAnswer", AGENT.id],
      ["getBalance", AGENT.id],
      ["getSpendPolicy", AGENT.id],
    ]);
    expect(seen[0]?.input).toMatchObject({ status: "dispatched", limit: 5 });
    expect(seen[2]?.input).toMatchObject({ task_id: TASK_ID, reason: "The photo shows a different cafe." });
  });

  it("serves await, cancel, dispute and spend-policy over REST with the path task id", async () => {
    const { fetch, seen } = recorder();
    const headers = { authorization: `Bearer ${KEY}` };
    const post = (path: string, body?: unknown) =>
      fetch(`http://eyes.test${path}`, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    for (const res of [
      await post(`/v1/tasks/${TASK_ID}/await`, { timeout_seconds: 5 }),
      await post(`/v1/tasks/${TASK_ID}/cancel`),
      await post(`/v1/tasks/${TASK_ID}/dispute`, { reason: "Wrong place entirely." }),
      await fetch("http://eyes.test/v1/spend-policy", { headers }),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "task_not_found" });
    }
    expect(seen.map((s) => [s.method, s.input])).toEqual([
      ["awaitAnswer", expect.objectContaining({ task_id: TASK_ID, timeout_seconds: 5 })],
      ["cancelTask", { task_id: TASK_ID }],
      ["disputeAnswer", { task_id: TASK_ID, reason: "Wrong place entirely." }],
      ["getSpendPolicy", undefined],
    ]);
  });

  it("refuses a body that is not JSON and treats an empty body as {}", async () => {
    const { fetch, seen } = recorder();
    const headers = { authorization: `Bearer ${KEY}` };
    const bad = await fetch(`http://eyes.test/v1/tasks/${TASK_ID}/dispute`, {
      method: "POST",
      headers,
      body: "{nope",
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: "invalid_input",
      issues: [{ path: "", message: "Request body is not valid JSON." }],
    });
    const empty = await fetch(`http://eyes.test/v1/tasks/${TASK_ID}/dispute`, {
      method: "POST",
      headers,
      body: " ",
    });
    expect(empty.status).toBe(400);
    expect((await empty.json()).fix).toContain("reason");
    expect(seen).toEqual([]);
  });
});

describe("await_answer progress and startup checks", () => {
  it("reports progress every 5 s while waiting, and not at all without a progress token", async () => {
    const held: (() => void)[] = [];
    const release = async () => {
      await vi.waitFor(() => expect(held.length).toBe(1));
      held.pop()?.();
    };
    const { fetch } = setup({
      awaitAnswer: async (_agent, input) => {
        await new Promise<void>((r) => held.push(r));
        return {
          task_id: input.task_id,
          status: "dispatched",
          answered: false,
          answer: null,
          next_step: "Call again.",
        };
      },
    });
    const client = await connect(fetch);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const progress: unknown[] = [];
      const call = client.callTool(
        { name: "await_answer", arguments: { task_id: TASK_ID, timeout_seconds: 30 } },
        { onprogress: (p) => progress.push(p) },
      );
      await vi.waitFor(() => expect(held.length).toBe(1));
      await vi.advanceTimersByTimeAsync(10_000);
      await release();
      await call;
      await vi.waitFor(() => expect(progress.length).toBe(3));
      expect(progress[0]).toMatchObject({
        progress: 0,
        total: 30,
        message: "Waiting for a worker to answer",
      });
      expect(vi.getTimerCount()).toBe(0);

      const quiet = client.callTool({
        name: "await_answer",
        arguments: { task_id: TASK_ID, timeout_seconds: 30 },
      });
      await release();
      expect((await quiet).structuredContent).toMatchObject({ answered: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to start with an EYES_OAUTH_SECRET under 32 characters", () => {
    expect(() => setup({}, { EYES_OAUTH_SECRET: "short" })).toThrow(
      "EYES_OAUTH_SECRET must be at least 32 characters.",
    );
  });
});
