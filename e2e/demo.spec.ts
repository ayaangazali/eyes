import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { toNodeListener } from "../apps/mcp/src/http.ts";
import { createServer } from "../apps/mcp/src/server.ts";
import { createDashboardServer } from "../apps/web/dashboard/src/server.ts";
import {
  AppConfig,
  FAKE_PLACES,
  fakeProviders,
  type SignupOutput,
  type ToolName,
  type ToolOutput,
} from "../packages/core/src/index.ts";
import { createRpc, migrate } from "../packages/db/src/index.ts";
import { createEyesService } from "../packages/engine/src/index.ts";
import { createAssessTask } from "../packages/safety/src/index.ts";
import { verifySubmission } from "../packages/verify/src/index.ts";

const WEB = "http://127.0.0.1:4174";
const WEB_API = "http://127.0.0.1:3399";
const INKBOX_KEY = "e2e-demo-inkbox-signing-key";
const PRIMITIVE_SECRET = "e2e-demo-primitive-webhook-secret";
const EMAIL_DOMAIN = "eyes-demo.primitive.email";
const WHERE = "Blue Bottle Coffee, Mint Plaza, San Francisco";
const CAFE = FAKE_PLACES[WHERE.toLowerCase()] as { lat: number; lng: number; label: string };
const CAFE_SHORT = CAFE.label.split(",")[0];
const QUESTION = "Is the line at Blue Bottle long right now?";
const ANSWER = "Short line, about 4 people";
const AGENT_EMAIL = "agent@agent.test";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const north = (meters: number) => ({ lat: CAFE.lat + meters / 111_320, lng: CAFE.lng });
const PAYEE = { name: "Demo Ana", phone: "+14155550131", ...north(40) };
const WORKERS = [
  PAYEE,
  { name: "Demo Ben", phone: "+14155550132", ...north(200) },
  { name: "Demo Cy", phone: "+14155550133", ...north(450) },
];

type Feed = {
  tasks: {
    id: string;
    status: string;
    lat: number;
    lng: number;
    place_label: string;
    workers_notified: number;
  }[];
  ledger: { type: string; amount_cents: number; task_id: string | null }[];
};

const providers = { ...fakeProviders(), clock: { now: () => new Date() } };
const sent = (to: string, kind: string) =>
  providers.messaging.outbox.filter((m) => m.to === to && m.kind === kind);
const captureLink = (phone: string) =>
  sent(phone, "capture_link").at(-1)?.payload as { task_id: string; capture_url: string } | undefined;

let admin: postgres.Sql | undefined;
let dbName = "";
let api: Server | undefined;
let dashboard: Server | undefined;
let API = "";
let DASHBOARD = "";
let client: Client;
let signup: SignupOutput;

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

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

async function feed(): Promise<Feed> {
  const res = await fetch(`${DASHBOARD}/feed`);
  expect(res.status).toBe(200);
  return res.json();
}

async function iMessageEyes(phone: string, content: string) {
  const body = JSON.stringify({
    id: `evt_${randomUUID()}`,
    event_type: "imessage.received",
    data: { message: { id: randomUUID(), remote_number: phone, content, is_group: false } },
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

async function emailEyes(to: string, messageId: string, subject: string, text: string) {
  const now = new Date().toISOString();
  const body = JSON.stringify({
    id: `evt_${randomBytes(32).toString("hex")}`,
    event: "email.received",
    version: "2025-12-14",
    delivery: { endpoint_id: "ep_demo", attempt: 1, attempted_at: now },
    email: {
      id: `em_${randomUUID()}`,
      thread_id: null,
      received_at: now,
      smtp: { helo: "mail.agent.test", mail_from: AGENT_EMAIL, rcpt_to: [to] },
      headers: { message_id: messageId, subject, from: `Demo Agent <${AGENT_EMAIL}>`, to, date: null },
      content: { raw: null, download: null },
      parsed: {
        status: "complete",
        error: null,
        body_text: text,
        body_html: null,
        reply_to: null,
        cc: null,
        bcc: null,
        to_addresses: [{ address: to, name: null }],
        in_reply_to: null,
        references: [],
        attachments: [],
        attachments_download_url: null,
      },
      analysis: {},
      auth: {
        spf: "pass",
        dmarc: "pass",
        dmarcPolicy: "none",
        dmarcFromDomain: "agent.test",
        dmarcSpfAligned: true,
        dmarcDkimAligned: true,
        dmarcSpfStrict: false,
        dmarcDkimStrict: false,
        dkimSignatures: [],
      },
    },
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", PRIMITIVE_SECRET).update(`${t}.${body}`).digest("hex");
  const res = await fetch(`${API}/webhooks/primitive`, {
    method: "POST",
    headers: { "content-type": "application/json", "primitive-signature": `t=${t},v1=${v1}` },
    body,
  });
  expect(await res.text()).toBe("ok");
}

test.skip(
  !DATABASE_URL && !process.env.CI,
  "Set DATABASE_URL to a Postgres server the spec may create a database on.",
);

test.beforeAll(async () => {
  if (!DATABASE_URL) throw new Error("CI must set DATABASE_URL: the G3 demo check cannot pass by skipping.");
  const sql = postgres(DATABASE_URL, { onnotice: () => {} });
  admin = sql;
  dbName = `eyes_demo_${randomBytes(4).toString("hex")}`;
  await sql.unsafe(`create database ${dbName}`);
  const url = new URL(DATABASE_URL);
  url.pathname = `/${dbName}`;
  await migrate(url.href);

  api = createHttpServer();
  API = await listen(api);
  const config = AppConfig.parse({
    public_api_url: API,
    worker_web_url: WEB,
    link_secret: "e2e-demo-link-secret-0123456789",
    email_domain: EMAIL_DOMAIN,
  });
  const db = { kind: "postgres" as const, url: url.href };
  const service = createEyesService({
    db,
    providers,
    assessTask: createAssessTask({}),
    verifySubmission,
    config,
  });
  const server = createServer({
    service,
    providers,
    config,
    env: { INKBOX_WEBHOOK_SIGNING_KEY: INKBOX_KEY, PRIMITIVE_WEBHOOK_SECRET: PRIMITIVE_SECRET },
  });
  api.on("request", toNodeListener(server.fetch));
  dashboard = createDashboardServer(createRpc(db));
  DASHBOARD = await listen(dashboard);

  for (const w of WORKERS) {
    await post("/w/join", w);
    await iMessageEyes(w.phone, "START");
  }
  const connectUrl = String(sent(PAYEE.phone, "text").at(-1)?.payload).match(/\S+\/w\/connect\/\S+/)?.[0];
  expect((await fetch(connectUrl ?? "", { redirect: "manual" })).status).toBe(302);

  signup = (await post("/v1/signup", { name: "demo-rehearsal-agent" })) as SignupOutput;
  client = new Client({ name: "demo-rehearsal", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${API}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${signup.api_key}` } },
    }),
  );
});

test.afterAll(async () => {
  await client?.close();
  for (const server of [api, dashboard]) {
    server?.closeAllConnections();
    server?.close();
  }
  if (dbName) await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
  await admin?.end();
});

test("demo: Claude asks about the cafe line, a texted worker answers on site, Claude gets a verified $3.50 answer and the worker gets $3", async ({
  page,
  context,
}) => {
  let taskId = "";
  await test.step("the agent calls quote_task then ask_eyes for the demo cafe", async () => {
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
  });

  const board = await context.newPage();
  await test.step("the dashboard shows the task pin and 3 workers notified", async () => {
    expect((await feed()).tasks.find((t) => t.id === taskId)).toMatchObject({
      status: "dispatched",
      lat: CAFE.lat,
      lng: CAFE.lng,
      place_label: CAFE.label,
      workers_notified: 3,
    });
    await board.route("https://unpkg.com/**", (route) => route.abort());
    await board.goto(DASHBOARD);
    await expect(board.getByRole("heading", { name: `3 workers notified near ${CAFE_SHORT}` })).toBeVisible();
  });

  let captureUrl = "";
  await test.step("a worker replies YES by iMessage and gets the capture link", async () => {
    await iMessageEyes(PAYEE.phone, "YES");
    const link = captureLink(PAYEE.phone);
    expect(link?.task_id).toBe(taskId);
    captureUrl = link?.capture_url ?? "";
    expect(captureUrl.startsWith(`${WEB}/capture.html?t=`)).toBe(true);
  });

  await test.step("the worker's capture page uploads a live photo with GPS at the cafe", async () => {
    await page.route(`${WEB_API}/**`, (route) =>
      route.continue({ url: route.request().url().replace(WEB_API, API) }),
    );
    await page.goto(captureUrl);
    await expect(page.getByRole("heading", { name: QUESTION })).toBeVisible();
    await page.getByRole("button", { name: "Take photo" }).click();
    await expect(page.getByAltText("What you captured")).toBeVisible();
    await page.getByLabel("Anything to add?").fill(ANSWER);
    await page.getByRole("button", { name: "Send to Eyes" }).click();
    await expect(page.getByText("Verified and paid. $3.00 is on its way to your account.")).toBeVisible();
  });

  await test.step("await_answer returns the verified answer, 3.50 total", async () => {
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
  });

  await test.step("the agent's $20 top-up, one $3.00 transfer, one row per money move, released on the dashboard", async () => {
    expect(providers.payments.transfers).toEqual([
      expect.objectContaining({ amount_cents: 300, task_id: taskId }),
    ]);
    const { ledger } = await feed();
    expect(ledger.filter((l) => l.type === "topup").map((l) => [l.amount_cents, l.task_id])).toEqual([
      [2000, null],
    ]);
    expect(
      ledger
        .filter((l) => l.task_id === taskId)
        .map((l) => [l.type, l.amount_cents])
        .sort(),
    ).toEqual([
      ["escrow", 350],
      ["fee", 50],
      ["payout", 300],
      ["release", 300],
    ]);
    await expect(
      board.getByRole("heading", { name: `Answered at ${CAFE_SHORT}, worker paid $3.00` }),
    ).toBeVisible();
    await expect(board.getByRole("listitem").filter({ hasText: "Released for the worker" })).toContainText(
      "$3.00",
    );
  });
});

test("demo: a task about a private house is refused with unsafe_task and a fix", async () => {
  const result = await client.callTool({
    name: "ask_eyes",
    arguments: {
      question: "Photograph the house at 123 Oak St",
      location: { lat: 37.7712, lng: -122.4413 },
      task_type: "photo_of_place",
      idempotency_key: randomUUID(),
    },
  });
  expect(result.isError).toBe(true);
  const [block] = result.content as { text: string }[];
  expect(JSON.parse(block?.text ?? "null")).toMatchObject({
    error: "unsafe_task",
    category: "private_residence",
    fix: expect.stringMatching(/\S/),
  });
});

test("demo: an agent emails its Eyes address and gets a threaded reply with the photo attached", async () => {
  const outbox = providers.email.outbox;
  const messageId = `<${randomUUID()}@agent.test>`;
  const address = signup.email_address ?? "";
  expect(address.endsWith(`@${EMAIL_DOMAIN}`)).toBe(true);

  await emailEyes(address, messageId, "Line check", `${QUESTION}\nLocation: ${WHERE}\nType: line_length`);
  expect(outbox.at(-1)).toMatchObject({
    to: AGENT_EMAIL,
    subject: "Re: Line check",
    in_reply_to: messageId,
    text: expect.stringContaining("3 workers notified"),
  });

  await iMessageEyes(PAYEE.phone, "YES");
  const link = captureLink(PAYEE.phone);
  const form = new FormData();
  form.set("lat", String(CAFE.lat));
  form.set("lng", String(CAFE.lng));
  form.set("accuracy_m", "8");
  form.set("captured_at", new Date().toISOString());
  form.set("answer_text", ANSWER);
  form.set("photo", new Blob([JPEG], { type: "image/jpeg" }), "photo.jpg");
  const token = new URL(link?.capture_url ?? WEB).searchParams.get("t");
  const capture = await fetch(`${API}/w/offers/${token}/capture`, { method: "POST", body: form });
  expect(await capture.json()).toMatchObject({ task_id: link?.task_id, status: "paid" });

  await expect
    .poll(() => outbox.find((m) => m.attachments?.length), { timeout: 15_000 })
    .toMatchObject({
      to: AGENT_EMAIL,
      subject: "Re: Line check",
      in_reply_to: messageId,
      references: [messageId],
      text: expect.stringContaining(ANSWER),
      attachments: [
        {
          content_type: "image/jpeg",
          url: expect.stringContaining(`https://storage.fake.test/photos/${link?.task_id}/`),
        },
      ],
    });
});
