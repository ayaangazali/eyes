import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { AppConfig, fakeProviders } from "@eyes/core";
import { migrate } from "@eyes/db";
import { createEyesService } from "@eyes/engine";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toNodeListener } from "./http.ts";
import { createServer } from "./server.ts";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("confirmed task intents over HTTP and PostgreSQL", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const providers = { ...fakeProviders(), clock: { now: () => new Date() } };
  const config = AppConfig.parse({
    public_api_url: "http://api.eyes.test",
    worker_web_url: "http://worker.eyes.test",
    link_secret: "confirmation-test-secret-123456789",
  });
  const service = createEyesService({
    db: { kind: "postgres", url: url ?? "" },
    providers,
    config,
    assessTask: async () => ({ allowed: true, category: null, reason: null, fix: null, layer: null }),
    verifySubmission: async () => {
      throw new Error("This regression must never submit an answer");
    },
  });
  const app = createServer({ service, providers, config, env: {} });
  const http = createHttpServer(toNodeListener((req) => app.fetch(req)));
  const clients: Client[] = [];
  let base: string;
  const location = { lat: 37.78246, lng: -122.40776 };
  let workerNumber = 0;

  async function worker() {
    const phone = `+1555${String(++workerNumber).padStart(7, "0")}`;
    await service.joinWorker({ name: "Synthetic confirmation worker", phone, ...location });
    await service.handleWorkerReply({ phone, intent: "start", text: "START" });
  }

  beforeAll(async () => {
    await migrate(url ?? "");
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  beforeEach(worker);
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await sql.end();
  });

  async function connect(name: string, apiKey: string, userAgent = name, apps = false, modern = apps) {
    const client = new Client(
      { name, version: "1" },
      modern
        ? {
            versionNegotiation: { mode: { pin: "2026-07-28" } },
            ...(apps && {
              capabilities: {
                extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
              },
            }),
          }
        : {},
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${apiKey}`, "user-agent": userAgent } },
      }),
    );
    clients.push(client);
    return client;
  }
  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as Record<string, unknown>;
  };
  const request = () => ({
    question: "Is this cafe open right now?",
    location,
    task_type: "is_open",
    bounty_usd: 3,
    deadline_minutes: 30,
    require_photo: true,
    idempotency_key: randomUUID(),
  });
  async function effects(agentId: string) {
    const [row] = await sql`
      select (select count(*)::int from tasks where agent_id = ${agentId}) as tasks,
        (select count(*)::int from ledger where agent_id = ${agentId} and type = 'escrow') as escrows,
        (select count(*)::int from offers where task_id in (select id from tasks where agent_id = ${agentId})) as offers`;
    return row;
  }

  it.each([
    ["chatgpt", "openai-mcp/1.0", false, false],
    ["mcp-client", "Claude-User/1.0", false, false],
    ["Claude-User", "generic-proxy/1.0", false, true],
    ["unknown-app-host", "unknown-host", true, true],
  ])(
    "requires card confirmation for %s, shares one intent across races, and permits a new confirmed intent",
    async (name, ua, apps, modern) => {
      const signup = await service.signupAgent({ name: "Synthetic confirmation agent" });
      const actor = await service.authenticate(signup.api_key);
      if (!actor) throw new Error("Missing synthetic agent");
      const model = await connect(name, signup.api_key, ua, apps, modern);
      const widget = await connect(name, signup.api_key, ua, apps, modern);
      const ask = { ...request(), deadline_minutes: 45, require_photo: false };
      const balanceBefore = await service.getBalance(actor);
      const before = providers.messaging.outbox.length;
      const { tools } = await model.listTools();
      const prepared = tools.find((tool) => tool.name === "ask_eyes");
      expect(prepared?.annotations?.readOnlyHint).toBe(true);
      expect(prepared?.outputSchema?.properties).toMatchObject({
        status: { const: "confirmation_required" },
      });
      for (const field of [
        "task_id",
        "workers_notified",
        "escrowed_usd",
        "charged_usd",
        "deadline_at",
        "reason",
        "message",
        "fix",
      ]) {
        expect(prepared?.outputSchema?.properties).not.toHaveProperty(field);
      }
      const confirmation = tools.find((tool) => tool.name === "confirm_ask");
      expect(confirmation?.annotations?.readOnlyHint).toBe(false);
      expect(confirmation?.outputSchema?.properties).toHaveProperty("task_id");
      expect(tools.find((tool) => tool.name === "confirm_ask")?._meta).toMatchObject({
        ui: { visibility: ["app"] },
        "openai/visibility": "private",
        "openai/widgetAccessible": true,
      });
      expect(confirmation?._meta).not.toHaveProperty("openai/outputTemplate");
      expect(confirmation?._meta).not.toHaveProperty("ui/resourceUri");
      expect(confirmation?._meta).not.toHaveProperty(["ui", "resourceUri"]);
      // Listing first makes the real MCP client validate each draft against its advertised output schema.
      const draft = await call(model, "ask_eyes", ask);
      expect(draft).toMatchObject({
        status: "confirmation_required",
        ...ask,
      });
      expect(await effects(actor.id)).toEqual({ tasks: 0, escrows: 0, offers: 0 });
      expect(await service.getBalance(actor)).toEqual(balanceBefore);
      expect(providers.messaging.outbox).toHaveLength(before);

      const raced = await Promise.all([
        call(widget, "confirm_ask", ask),
        call(model, "ask_eyes", ask),
        call(widget, "confirm_ask", ask),
      ]);
      const posted = raced[0];
      expect(posted).toMatchObject({ status: "dispatched", workers_notified: 1, escrowed_usd: 3.5 });
      expect(raced[1]?.status).toBe("confirmation_required");
      expect(raced[2]?.task_id).toBe(posted?.task_id);
      expect(await effects(actor.id)).toEqual({ tasks: 1, escrows: 1, offers: 1 });
      expect(providers.messaging.outbox.slice(before).filter((item) => item.kind === "offer")).toHaveLength(
        1,
      );
      expect((await service.getBalance(actor)).balance_usd).toBe(balanceBefore.balance_usd - 3.5);
      expect((await call(widget, "confirm_ask", ask)).task_id).toBe(posted?.task_id);
      // A follow-up model call cannot create a second task, even if it invents another key.
      await call(model, "ask_eyes", { ...ask, idempotency_key: randomUUID() });
      expect(await effects(actor.id)).toEqual({ tasks: 1, escrows: 1, offers: 1 });
      const saved = await call(widget, "get_task", { task_id: posted?.task_id });
      expect(saved.retry_context).toMatchObject({ deadline_minutes: 45, require_photo: false });
      await worker();
      const again = await call(widget, "confirm_ask", {
        ...(saved.retry_context as Record<string, unknown>),
        idempotency_key: randomUUID(),
      });
      expect(again.task_id).not.toBe(posted?.task_id);
      expect(await effects(actor.id)).toEqual({ tasks: 2, escrows: 2, offers: 2 });
    },
  );

  it.each(["eyes-cli", "claude-code", "Claude Code"])(
    "preserves %s and REST creation without content/time-window deduplication",
    async (name) => {
      const signup = await service.signupAgent({ name: "Synthetic automation agent" });
      const client = await connect(name, signup.api_key);
      const { tools } = await client.listTools();
      const direct = tools.find((tool) => tool.name === "ask_eyes");
      expect(direct?.annotations?.readOnlyHint).toBe(false);
      expect(direct?.outputSchema?.properties).toHaveProperty("task_id");
      const ask = request();
      const mcp = await call(client, "ask_eyes", ask);
      expect(mcp.status).toBe("dispatched");
      await worker();
      const response = await fetch(`${base}/v1/tasks`, {
        method: "POST",
        headers: { authorization: `Bearer ${signup.api_key}`, "content-type": "application/json" },
        body: JSON.stringify({ ...ask, idempotency_key: randomUUID() }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).task_id).not.toBe(mcp.task_id);
    },
  );
});
