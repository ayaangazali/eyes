import { createHmac, randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test } from "@playwright/test";
import { toNodeListener } from "../apps/mcp/src/http.ts";
import { createServer } from "../apps/mcp/src/server.ts";
import { offerText } from "../packages/comms/src/index.ts";
import {
  AppConfig,
  type AssessTask,
  EyesError,
  FAKE_PLACES,
  fakeProviders,
  type OfferMessage,
  type SignupOutput,
  type ToolName,
  type ToolOutput,
} from "../packages/core/src/index.ts";
import { createEyesService } from "../packages/engine/src/index.ts";
import { createAssessTask } from "../packages/safety/src/index.ts";
import { verifySubmission } from "../packages/verify/src/index.ts";

const API = "http://127.0.0.1:3399";
const WEB = "http://127.0.0.1:4174";
const INKBOX_KEY = "e2e-inkbox-signing-key";
const WHERE = "Blue Bottle Coffee, Mint Plaza, San Francisco";
const CAFE = FAKE_PLACES[WHERE.toLowerCase()] as { lat: number; lng: number; label: string };
const QUESTION = "Is the line at Blue Bottle long right now?";
const ANSWER = "Short line, about 4 people";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const north = (meters: number) => ({ lat: CAFE.lat + meters / 111_320, lng: CAFE.lng });
const PAYEE = { name: "Golden Ana", phone: "+14155550121", ...north(60) };
const RUNNER_UP = { name: "Golden Ben", phone: "+14155550122", ...north(250) };
const NEAR = [PAYEE, RUNNER_UP, { name: "Golden Cy", phone: "+14155550123", ...north(500) }];
const FAR = { name: "Golden Dee", phone: "+14155550124", lat: 37.8044, lng: -122.2712 };

const providers = { ...fakeProviders(), clock: { now: () => new Date() } };
const outbox = providers.messaging.outbox;
const sent = (to: string, kind: string) => outbox.filter((m) => m.to === to && m.kind === kind);

let http: Server | undefined;
let client: Client;
let safetyStubbed = false;
let taskId: string | undefined;

async function tool<N extends ToolName>(name: N, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return result.structuredContent as ToolOutput<N>;
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status, path).toBe(200);
  return res.json();
}

async function textEyes(phone: string, text: string) {
  const body = JSON.stringify({
    id: `evt_${randomUUID()}`,
    event_type: "text.received",
    data: { text_message: { id: randomUUID(), remote_phone_number: phone, text } },
  });
  const requestId = `req_${randomUUID()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", INKBOX_KEY)
    .update(`${requestId}.${timestamp}.${body}`)
    .digest("hex");
  const res = await fetch(`${API}/webhooks/inkbox`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-inkbox-request-id": requestId,
      "x-inkbox-timestamp": timestamp,
      "x-inkbox-signature": `sha256=${signature}`,
    },
    body,
  });
  expect(await res.text()).toBe("ok");
}

test.skip(!DATABASE_URL, "Set DATABASE_URL to a migrated Postgres database (pnpm db:migrate).");

test.beforeAll(async () => {
  const realSafety = createAssessTask({});
  safetyStubbed = await realSafety({ question: QUESTION, task_type: "line_length", place_label: CAFE.label })
    .then(() => false)
    .catch((err) => err instanceof EyesError && err.code === "not_implemented");
  const allow: AssessTask = async () => ({
    allowed: true,
    category: null,
    reason: null,
    fix: null,
    layer: null,
  });
  const config = AppConfig.parse({
    public_api_url: API,
    worker_web_url: WEB,
    link_secret: "e2e-golden-link-secret-0123456789",
  });
  const service = createEyesService({
    db: { kind: "postgres", url: DATABASE_URL },
    providers,
    assessTask: safetyStubbed ? allow : realSafety,
    verifySubmission,
    config,
  });
  const server = createServer({
    service,
    providers,
    config,
    env: { INKBOX_WEBHOOK_SIGNING_KEY: INKBOX_KEY, INKBOX_PHONE_NUMBER: "+14155550100" },
  });
  http = createHttpServer(toNodeListener(server.fetch));
  await new Promise<void>((resolve) => http?.listen(3399, "127.0.0.1", resolve));

  const signup = (await post("/v1/signup", { name: "g1-golden-agent" })) as SignupOutput;
  client = new Client({ name: "g1-golden-path", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${API}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${signup.api_key}` } },
    }),
  );
});

test.afterAll(async () => {
  if (taskId) await client.callTool({ name: "cancel_task", arguments: { task_id: taskId } });
  await client?.close();
  http?.closeAllConnections();
  http?.close();
});

test("an agent asks over MCP, a texted worker captures on site, the agent gets a verified answer and the worker is paid", async ({
  page,
}) => {
  for (const w of [...NEAR, FAR]) {
    await post("/w/join", w);
    await textEyes(w.phone, "START");
    expect(String(sent(w.phone, "text").at(-1)?.payload)).toContain("You are in.");
  }
  const connectUrl = String(sent(PAYEE.phone, "text").at(-1)?.payload).match(/\S+\/w\/connect\/\S+/)?.[0];
  expect(connectUrl?.startsWith(`${API}/w/connect/`)).toBe(true);
  const connect = await fetch(connectUrl ?? "", { redirect: "manual" });
  expect(connect.status).toBe(302);
  const account = connect.headers.get("location")?.split("https://connect.fake.test/onboard/")[1];
  expect(account).toMatch(/^acct_fake_[\da-f-]{36}$/);

  expect(await tool("get_balance")).toMatchObject({ balance_usd: 20, escrowed_usd: 0 });
  expect(await tool("quote_task", { location: WHERE, task_type: "line_length" })).toMatchObject({
    workers_nearby: 3,
    allowed: true,
    resolved_location: CAFE,
  });
  const asked = await tool("ask_eyes", {
    question: QUESTION,
    location: WHERE,
    task_type: "line_length",
    idempotency_key: randomUUID(),
  });
  taskId = asked.task_id;
  expect(asked).toMatchObject({ status: "dispatched", workers_notified: 3, escrowed_usd: 3.5 });

  const offers = outbox.filter((m) => m.kind === "offer" && (m.payload as OfferMessage).task_id === taskId);
  expect(offers.map((o) => o.to).sort()).toEqual(NEAR.map((w) => w.phone).sort());
  for (const o of offers) expect(offerText(o.payload as OfferMessage)).not.toContain(QUESTION);

  await textEyes(PAYEE.phone, "YES");
  await textEyes(RUNNER_UP.phone, "yes");
  expect(sent(RUNNER_UP.phone, "already_claimed")).toHaveLength(1);
  expect(sent(RUNNER_UP.phone, "capture_link")).toHaveLength(0);
  const link = sent(PAYEE.phone, "capture_link").at(-1)?.payload as { task_id: string; capture_url: string };
  expect(link.task_id).toBe(taskId);
  expect(link.capture_url.startsWith(`${WEB}/capture.html?t=`)).toBe(true);

  await page.goto(link.capture_url);
  await expect(page.getByRole("heading", { name: QUESTION })).toBeVisible();
  await page.getByRole("button", { name: "Take photo" }).click();
  await expect(page.getByAltText("What you captured")).toBeVisible();
  await page.getByLabel("Anything to add?").fill(ANSWER);
  await page.getByRole("button", { name: "Send to Eyes" }).click();
  await expect(page.getByText("Verified and paid. $3.00 is on its way to your account.")).toBeVisible();
  for (const check of ["Location matches the place", "Photo taken in time", "Photo answers the question"]) {
    await expect(page.getByText(`${check}: passed`)).toBeVisible();
  }

  let result = await tool("await_answer", { task_id: taskId, timeout_seconds: 10 });
  while (!result.answered) result = await tool("await_answer", { task_id: taskId, timeout_seconds: 10 });
  expect(result).toMatchObject({
    status: "paid",
    answer: {
      answer_text: ANSWER,
      photo_url: expect.stringMatching(/^https:\/\/storage\.fake\.test\/photos\//),
      verification: { gps_ok: true, fresh_ok: true, vision_ok: true },
      cost_usd: 3.5,
    },
  });
  expect(result.answer?.worker_distance_m).toBeLessThan(150);

  expect(await tool("get_balance")).toMatchObject({ balance_usd: 16.5, escrowed_usd: 0 });
  expect(providers.payments.transfers).toEqual([
    expect.objectContaining({
      amount_cents: 300,
      task_id: taskId,
      account_id: account,
    }),
  ]);
  expect(sent(PAYEE.phone, "paid").map((m) => m.payload)).toEqual([
    {
      task_id: taskId,
      place_label: CAFE.label,
      amount_cents: 300,
      earnings_url: expect.stringContaining(`${API}/w/earnings/`),
    },
  ]);
});

test("ask_eyes refuses a task about a private home with unsafe_task and a fix", async () => {
  test.skip(
    safetyStubbed,
    "@eyes/safety is still the T1.5 not_implemented stub, so there is no real verdict yet.",
  );
  const result = await client.callTool({
    name: "ask_eyes",
    arguments: {
      question: "Photograph the house at 123 Oak St",
      location: { lat: CAFE.lat, lng: CAFE.lng },
      task_type: "photo_of_place",
      idempotency_key: randomUUID(),
    },
  });
  expect(result.isError).toBe(true);
  const [block] = result.content as { text: string }[];
  expect(JSON.parse(block?.text ?? "null")).toMatchObject({
    error: "unsafe_task",
    fix: expect.stringMatching(/\S/),
  });
});
