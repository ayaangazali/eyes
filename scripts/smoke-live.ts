import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { TOOLS, type ToolName, type ToolOutput } from "../packages/core/src/index.ts";

const PLACE = "Ferry Building, San Francisco";
const TIMEOUT_MS = 15_000;
const DOCS = ["/llms.txt", "/openapi.json", "/.well-known/agent-card.json"];
const WEBHOOKS = ["inkbox", "stripe", "primitive"];

const secrets = new Set<string>();

export function redact(text: string, known: Iterable<string> = secrets): string {
  let out = text;
  for (const secret of known) if (secret) out = out.replaceAll(secret, "[redacted]");
  return out
    .replace(/eyes_(test|live)_[\w-]+/g, "eyes_$1_[redacted]")
    .replace(/ask\+[\w-]+@/g, "ask+[redacted]@")
    .replace(/[\w-]{16,}\.[\w-]{16,}/g, "[redacted]");
}

class Skip extends Error {}

let failed = false;

async function check(name: string, fn: () => Promise<string>) {
  const started = performance.now();
  let status = "PASS";
  let detail: string;
  try {
    detail = await fn();
  } catch (err) {
    status = err instanceof Skip ? "SKIP" : "FAIL";
    detail = err instanceof Error ? err.message : String(err);
  }
  if (status === "FAIL") failed = true;
  const ms = String(Math.round(performance.now() - started)).padStart(6);
  const [first = "", ...rest] = redact(detail).split("\n");
  console.log(`${status} ${ms}ms  ${name}  ${first}`.trimEnd());
  for (const line of rest) console.log(`                 ${line}`);
}

async function main() {
  const base = process.env.EYES_PUBLIC_API_URL?.replace(/\/+$/, "");
  if (!base) {
    console.error(
      "Set EYES_PUBLIC_API_URL to the server to test, e.g. EYES_PUBLIC_API_URL=https://dark-wave-wfmpm.run.mcp-use.com pnpm smoke:live",
    );
    process.exit(2);
  }
  console.log(`smoke:live against ${base}`);

  const call = async (method: string, path: string, init: { key?: string; body?: unknown } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(init.key && { authorization: `Bearer ${init.key}` }),
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, text: await res.text() };
  };
  const json = async (method: string, path: string, init: { key?: string; body?: unknown } = {}) => {
    const res = await call(method, path, init);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    return JSON.parse(res.text);
  };

  await check("GET /healthz", async () => {
    const health = (await json("GET", "/healthz")) as {
      ok: boolean;
      providers: Record<string, string>;
      db: string;
    };
    if (health.ok !== true) throw new Error(`ok is ${health.ok}`);
    const rows = [...Object.entries(health.providers), ["db", health.db]];
    return rows.map(([name, kind]) => `${String(name).padEnd(10)} ${kind}`).join("\n");
  });

  for (const path of DOCS) {
    await check(`GET ${path}`, async () => {
      const res = await call("GET", path);
      if (res.status === 404) throw new Skip("not published on this server yet");
      if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      if (path.endsWith(".json")) JSON.parse(res.text);
      return `${res.text.length} bytes`;
    });
  }

  let key = process.env.EYES_SMOKE_API_KEY;
  if (key) secrets.add(key);
  await check("POST /v1/signup", async () => {
    if (key) throw new Skip("EYES_SMOKE_API_KEY is set");
    const out = await json("POST", "/v1/signup", { body: { name: `smoke-${new Date().toISOString()}` } });
    key = out.api_key as string;
    secrets.add(key);
    if (out.email_address) secrets.add(out.email_address);
    return `agent_id=${out.agent_id} balance_usd=${out.balance_usd}`;
  });

  for (const path of ["/v1/balance", "/v1/spend-policy"]) {
    await check(`GET ${path}`, async () => {
      if (!key) throw new Skip("no API key");
      return JSON.stringify(await json("GET", path, { key }));
    });
  }

  let client: Client | undefined;
  await check("MCP tools/list", async () => {
    if (!key) throw new Skip("no API key");
    const mcp = new Client({ name: "eyes-smoke-live", version: "1.0.0" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    client = mcp;
    const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
    const want = [...Object.keys(TOOLS), "show_task"].sort();
    if (names.join() !== want.join()) throw new Error(`got ${names.join(", ")}; want ${want.join(", ")}`);
    return names.join(", ");
  });

  const tool = async <N extends ToolName>(name: N, args: Record<string, unknown> = {}) => {
    if (!client) throw new Skip("MCP not connected");
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
    return result.structuredContent as ToolOutput<N>;
  };

  await check("MCP get_balance", async () => JSON.stringify(await tool("get_balance")));
  await check(`MCP quote_task "${PLACE}" is_open`, async () =>
    JSON.stringify(await tool("quote_task", { location: PLACE, task_type: "is_open" })),
  );

  for (const name of WEBHOOKS) {
    await check(`POST /webhooks/${name} unsigned`, async () => {
      const res = await call("POST", `/webhooks/${name}`, { body: {} });
      if (res.status < 400 || res.status > 499) {
        throw new Error(`HTTP ${res.status}, want 4xx: ${res.text.slice(0, 200)}`);
      }
      return `HTTP ${res.status}`;
    });
  }

  await check("MCP ask_eyes then cancel_task refunds escrow", async () => {
    if (process.env.SMOKE_ASK !== "1")
      throw new Skip("set SMOKE_ASK=1 to run; in live mode it texts real workers");
    const before = await tool("get_balance");
    const asked = await tool("ask_eyes", {
      question: "Is the Ferry Building open right now?",
      location: PLACE,
      task_type: "is_open",
      bounty_usd: 1,
      idempotency_key: `smoke-${randomUUID()}`,
    });
    const cancelled = await tool("cancel_task", { task_id: asked.task_id }).catch((err: Error) => {
      throw new Error(
        `task ${asked.task_id} escrowed ${asked.escrowed_usd} USD and was not cancelled: ${err.message}`,
      );
    });
    const after = await tool("get_balance");
    const summary = `task ${asked.task_id}: workers_notified=${asked.workers_notified} escrowed_usd=${asked.escrowed_usd} refunded_usd=${cancelled.refunded_usd}; balance_usd ${before.balance_usd} -> ${after.balance_usd}, escrowed_usd ${before.escrowed_usd} -> ${after.escrowed_usd}`;
    if (after.balance_usd !== before.balance_usd || after.escrowed_usd !== before.escrowed_usd) {
      throw new Error(`money left in escrow: ${summary}`);
    }
    return summary;
  });

  await client?.close();
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
