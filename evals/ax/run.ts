import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { mcpTools } from "@anthropic-ai/sdk/helpers/beta/mcp";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { toNodeListener } from "../../apps/mcp/src/http.ts";
import { createServer } from "../../apps/mcp/src/server.ts";
import {
  AppConfig,
  FAKE_PLACES,
  fakeGeo,
  fakeMessaging,
  fakeProviders,
  type Messaging,
  type OfferView,
  signToken,
  TASK_TYPES,
} from "../../packages/core/src/index.ts";
import { migrate } from "../../packages/db/src/index.ts";
import { createEyesService } from "../../packages/engine/src/index.ts";
import { createAssessTask } from "../../packages/safety/src/index.ts";
import { verifySubmission } from "../../packages/verify/src/index.ts";
import { type Call, type Expect, grade } from "./grade.ts";
import tasks from "./tasks.json" with { type: "json" };

type TaskSpec = {
  id: string;
  prompt: string;
  expect: Expect;
  max_bounty_usd?: number;
  scripted: { question: string; location: string; task_type: string };
};
type Recorded = Call & { result: Awaited<ReturnType<Client["callTool"]>> };
type Run = (
  spec: TaskSpec,
  mcp: Client,
  call: (tool: string, args: Record<string, unknown>) => Promise<Recorded>,
) => Promise<string>;

const OUT = new URL("out/", import.meta.url);
const SYSTEM = "You can use the Eyes tools. Answer the user's question.";
const MODEL = process.env.AX_MODEL || "claude-haiku-5-5";
const FINAL = ["expired", "refunded", "disputed"];
const INKBOX_KEY = "ax-eval-inkbox-signing-key";
const WORKER_DELAY_MS = 2000;
const ANSWER = "Open, short line of about 4 people";
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
const CAFE = FAKE_PLACES["blue bottle coffee, mint plaza, san francisco"] as {
  lat: number;
  lng: number;
  label: string;
};
const PLACES: Record<string, { lat: number; lng: number; label: string }> = {
  "blue bottle": CAFE,
  "pine st": { lat: 37.79235, lng: -122.39746, label: "12 Pine St, San Francisco" },
};
const WORKER = { name: "AX Worker", phone: "+14155550199", lat: CAFE.lat + 15 / 111_320, lng: CAFE.lng };

const DATABASE_URL = process.env.DATABASE_URL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!DATABASE_URL) {
  console.error(
    "Set DATABASE_URL to a Postgres database, e.g. postgres://postgres:eyes@127.0.0.1:54329/eyes",
  );
  process.exit(2);
}
await migrate(DATABASE_URL);

const serverLog: string[] = [];
console.log = (...args: unknown[]) => serverLog.push(args.join(" "));

let handle: ReturnType<typeof toNodeListener> | undefined;
const http = createHttpServer((req, res) => handle?.(req, res));
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const API = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} returned ${res.status}: ${await res.text()}`);
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
  if (!res.ok) throw new Error(`inkbox webhook returned ${res.status}: ${await res.text()}`);
}

async function capture(captureUrl: string) {
  const token = encodeURIComponent(new URL(captureUrl).searchParams.get("t") ?? "");
  const offer = (await (await fetch(`${API}/w/offers/${token}`)).json()) as OfferView;
  const form = new FormData();
  form.set("lat", String(offer.lat));
  form.set("lng", String(offer.lng));
  form.set("accuracy_m", "8");
  form.set("captured_at", new Date().toISOString());
  form.set("answer_text", ANSWER);
  form.set("photo", new Blob([JPEG], { type: "image/jpeg" }), "capture.jpg");
  const res = await fetch(`${API}/w/offers/${token}/capture`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`capture returned ${res.status}: ${await res.text()}`);
}

const later = (step: () => Promise<void>) =>
  setTimeout(() => step().catch((err) => console.error("simulated worker:", err)), WORKER_DELAY_MS);
const fake = fakeMessaging();
const messaging: Messaging = {
  ...fake,
  sendOffer: async (to, offer) => {
    if (to === WORKER.phone) later(() => textEyes(to, "YES"));
    return fake.sendOffer(to, offer);
  },
  sendCaptureLink: async (to, msg) => {
    later(() => capture(msg.capture_url));
    return fake.sendCaptureLink(to, msg);
  },
};
const baseGeo = fakeGeo();
const providers = {
  ...fakeProviders(),
  messaging,
  geo: {
    geocode: async (query: string) =>
      Object.entries(PLACES).find(([match]) => query.toLowerCase().includes(match))?.[1] ??
      baseGeo.geocode(query),
  },
  clock: { now: () => new Date() },
};
const config = AppConfig.parse({
  public_api_url: API,
  worker_web_url: `${API}/worker`,
  link_secret: "ax-eval-link-secret-0123456789abcdef",
});
const service = createEyesService({
  db: { kind: "postgres", url: DATABASE_URL },
  providers,
  assessTask: createAssessTask({}),
  verifySubmission,
  config,
});
setInterval(() => service.expireOverdue().catch((err) => console.error("expireOverdue failed", err)), 30_000);
handle = toNodeListener(
  createServer({
    service,
    providers,
    config,
    env: { INKBOX_WEBHOOK_SIGNING_KEY: INKBOX_KEY, INKBOX_PHONE_NUMBER: "+14155550100" },
  }).fetch,
);

await post("/w/join", WORKER);
await textEyes(WORKER.phone, "START");
const llms = await fetch(`${API}/llms.txt`);
const docs = llms.ok ? await llms.text() : null;
const docsNote = docs
  ? "GET /llms.txt served; client A gets it after the system prompt"
  : `tool descriptions only (GET /llms.txt returned ${llms.status})`;

const scripted: Run = async (spec, _mcp, call) => {
  const { question, location, task_type } = spec.scripted;
  const quote = await call("quote_task", { location, task_type });
  if (!quote.ok) return `${quote.body.message} ${quote.body.fix}`;
  if (!quote.body.allowed) return String(quote.body.reason_if_not);
  const args = {
    question,
    location,
    task_type,
    bounty_usd: quote.body.suggested_bounty_usd,
    deadline_minutes: 5,
    idempotency_key: randomUUID(),
  };
  let asked = await call("ask_eyes", args);
  if (!asked.ok && typeof asked.body.max_bounty_usd === "number") {
    asked = await call("ask_eyes", { ...args, bounty_usd: asked.body.max_bounty_usd });
  }
  if (!asked.ok) return `${asked.body.message} ${asked.body.fix}`;
  let waited: Call;
  do waited = await call("await_answer", { task_id: asked.body.task_id });
  while (waited.ok && !waited.body.answered && !FINAL.includes(String(waited.body.status)));
  const answer = waited.body.answer as {
    answer_text: string;
    photo_url: string;
    verification: Record<string, unknown>;
  } | null;
  if (!waited.body.answered || !answer) return `Task ${waited.body.status}: ${waited.body.next_step}`;
  const v = answer.verification;
  return `${answer.answer_text}. Photo: ${answer.photo_url}. Verification: gps_ok=${v.gps_ok} fresh_ok=${v.fresh_ok} vision_ok=${v.vision_ok} (${v.vision_reason}).`;
};

const claude: Run = async (spec, mcp, call) => {
  const { tools } = await mcp.listTools();
  const recorded = {
    callTool: async (p: { name: string; arguments?: Record<string, unknown> }) => {
      const { content, isError } = (await call(p.name, p.arguments ?? {})).result;
      return { content, isError };
    },
  };
  const reply = await new Anthropic({ apiKey: ANTHROPIC_API_KEY }).beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 4096,
    max_iterations: 30,
    system: docs ? `${SYSTEM}\n\n${docs}` : SYSTEM,
    messages: [{ role: "user", content: spec.prompt }],
    tools: mcpTools(tools, recorded),
  });
  return reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
};

async function runTask(client: string, run: Run, spec: TaskSpec) {
  const signup = await service.signupAgent({ name: `ax-${client}-${spec.id}` });
  const owner = signToken(config.link_secret, `p:${signup.agent_id}`);
  if (spec.max_bounty_usd !== undefined) {
    await service.updateSpendPolicy(owner, {
      max_bounty_usd: spec.max_bounty_usd,
      daily_cap_usd: 20,
      allowed_task_types: [...TASK_TYPES],
    });
  }
  const mcp = new Client({ name: `ax-eval-${client}`, version: "1.0.0" });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${API}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${signup.api_key}` } },
    }),
  );
  const calls: Call[] = [];
  const call = async (tool: string, args: Record<string, unknown>) => {
    const result = await mcp.callTool({ name: tool, arguments: args });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    let body: Record<string, unknown>;
    try {
      body = result.isError ? JSON.parse(text) : (result.structuredContent ?? {});
    } catch {
      body = { text };
    }
    const recorded = { tool, args, ok: !result.isError, body };
    calls.push(recorded);
    return Object.assign(recorded, { result });
  };
  let finalText: string;
  try {
    finalText = await run(spec, mcp, call);
  } catch (err) {
    finalText = `client error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    await mcp.close();
  }
  const { ledger } = await service.ownerConsole(owner);
  const transcript = {
    calls: calls.map(({ tool, args, ok, body }) => ({ tool, args, ok, body })),
    final_text: finalText,
    escrow_rows: ledger.filter((l) => l.type === "escrow").length,
  };
  const checks = grade(spec.expect, transcript);
  return { client, task: spec.id, pass: Object.values(checks).every(Boolean), checks, transcript };
}

const results = [];
for (const spec of tasks as TaskSpec[]) results.push(await runTask("scripted", scripted, spec));
if (ANTHROPIC_API_KEY)
  for (const spec of tasks as TaskSpec[]) results.push(await runTask("claude", claude, spec));

const rows = [
  ["client", "task", "result", "failed checks", "tool calls"],
  ...results.map((r) => [
    r.client,
    r.task,
    r.pass ? "PASS" : "FAIL",
    Object.entries(r.checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name)
      .join(", ") || "-",
    r.transcript.calls.map((c) => (c.ok ? c.tool : `${c.tool}!`)).join(" > "),
  ]),
];
const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => row[i]?.length ?? 0))) ?? [];
const table = [
  `docs: ${docsNote}`,
  `client A (claude): ${ANTHROPIC_API_KEY ? MODEL : "SKIPPED, ANTHROPIC_API_KEY is not set"}`,
  "client B (scripted): quote_task > ask_eyes > await_answer loop, from tool descriptions only",
  "",
  ...rows.map((row) =>
    row
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd(),
  ),
  "",
  "tool! = the call returned an error. Full transcripts: evals/ax/out/report.json",
].join("\n");

await mkdir(OUT, { recursive: true });
await writeFile(
  new URL("report.json", OUT),
  JSON.stringify(
    { ran_at: new Date().toISOString(), docs: docsNote, model: ANTHROPIC_API_KEY ? MODEL : null, results },
    null,
    2,
  ),
);
await writeFile(new URL("table.txt", OUT), `${table}\n`);
await writeFile(new URL("server.log", OUT), `${serverLog.join("\n")}\n`);
process.stdout.write(`${table}\n`);
process.exit(results.length > 0 && results.every((r) => r.pass) ? 0 : 1);
