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
    expect(page).toContain("Payments: simulated");
    expect(page).toContain("Database: InsForge");
    expect(page).toContain("<code>0123456789ab</code>");
    const bare = await (
      await setup({}, { DATABASE_URL: "postgres://x" }).fetch("http://eyes.test/status")
    ).text();
    expect(bare).toContain("Texting: simulated");
    expect(bare).toContain("Database: Postgres");
    expect(bare).toContain("Deployed commit: not recorded");
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
    expect(await page({}, "/status")).toContain("Safety review: rules only");
    expect(await page({ ANTHROPIC_API_KEY: secret }, "/status")).toContain(
      "Safety review: rules and AI classifier",
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
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
    const res = await fetch(`http://eyes.test/ops/${OPS_KEY}`);
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
      const res = await fetch(`http://eyes.test${path}`, { headers: { accept: "text/html" } });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/ops/login");
    }
    for (const path of [...PAGES, ...FEEDS]) {
      const res = await fetch(`http://eyes.test${path}`, { headers: { cookie: "__Host-eyes_ops=forged" } });
      expect(res.status).toBe(401);
    }
    expect(rpcCalls).toEqual([]);
  });

  it("answers a wrong or unset break-glass key exactly like an unknown route", async () => {
    const { fetch } = setup({}, { EYES_OPS_KEY: OPS_KEY });
    for (const key of [OPS_KEY.slice(0, -1), `${OPS_KEY}0`, OPS_KEY.toUpperCase()]) {
      const res = await fetch(`http://eyes.test/ops/${key}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    const unset = setup({}, { EYES_OPS_KEY: "" });
    expect((await unset.fetch(`http://eyes.test/ops/${OPS_KEY}`)).status).toBe(404);
  });

  it("signs in with the break-glass key and then serves the ops page, the live map and the feed, uncached, with a CSP that allows only each page's own script, and worker positions rounded to 3 decimals", async () => {
    const { fetch, rpcCalls } = setup({}, { EYES_OPS_KEY: OPS_KEY });
    const cookie = await signIn(fetch);
    const headers = { cookie };
    const ops = await fetch("http://eyes.test/ops", { headers });
    const live = await fetch("http://eyes.test/ops/live", { headers });
    const feed = await fetch("http://eyes.test/ops/feed", { headers });

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
    const res = await fetch("http://eyes.test/ops/feed", { headers: { cookie: await signIn(fetch) } });
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
});
