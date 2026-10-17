import {
  type Agent,
  AppConfig,
  type CaptureFields,
  ERRORS,
  EyesError,
  type EyesService,
  fakeProviders,
  type PhotoUpload,
  QuoteTaskOutput,
  signToken,
  TOOLS,
} from "@eyes/core";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createServer } from "./server.ts";

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

function setup() {
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
    submitCapture: async (token, fields, photo) => {
      captures.push({ token, fields, photo });
      return {
        task_id: TASK_ID,
        status: "submitted",
        verification: { gps_ok: true, fresh_ok: true, vision_ok: true, vision_reason: "ok" },
        message: "Thanks!",
      };
    },
  };
  const config = AppConfig.parse({
    public_api_url: "http://api.eyes.test",
    worker_web_url: "http://worker.eyes.test",
    link_secret: SECRET,
  });
  const server = createServer({
    service: service as EyesService,
    providers: fakeProviders(),
    config,
    env: {},
  });
  const fetch = (url: string | URL, init?: RequestInit) => server.fetch(new Request(url, init));
  return { server, fetch, captures, awaitSignals };
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

describe("MCP tools", () => {
  it("lists all eight tools with read-only and idempotent hints", async () => {
    const client = await connect(setup().fetch);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOLS).sort());
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const name of ["quote_task", "await_answer", "get_task", "get_balance", "get_spend_policy"]) {
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
    expect(body).toMatchObject({ error: "invalid_input", fix: ERRORS.invalid_input.fix });
    expect(body.issues).toEqual([expect.objectContaining({ path: "task_type" })]);
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
});
