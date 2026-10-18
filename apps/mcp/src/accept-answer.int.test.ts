import { randomInt, randomUUID } from "node:crypto";
import { createServer as createHttpServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Agent,
  AppConfig,
  type EngineDeps,
  type EyesService,
  fakeProviders,
  TASK_STATUSES,
  TOOLS,
} from "@eyes/core";
import { createRpc, migrate } from "@eyes/db";
import { createEyesService } from "@eyes/engine";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toNodeListener } from "./http.ts";
import { createServer } from "./server.ts";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("answer acceptance on PostgreSQL over HTTP/MCP", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const providers = fakeProviders();
  let service: EyesService;
  let deps: EngineDeps;
  let base: string;
  let listener: RequestListener;
  const http = createHttpServer((req, res) => listener(req, res));
  const clients: Client[] = [];
  let owner: Agent;
  let ownerKey: string;
  let otherKey: string;
  let client: Client;
  let workerId: string;

  beforeAll(async () => {
    await migrate(url ?? "");
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const config = AppConfig.parse({
      public_api_url: base,
      worker_web_url: "http://worker.eyes.test",
      link_secret: "accept-answer-local-test-secret-123456",
      test_mode: true,
    });
    deps = {
      db: { kind: "postgres", url: url ?? "" },
      providers,
      config,
      assessTask: async () => ({ allowed: true, category: null, reason: null, fix: null, layer: null }),
      verifySubmission: async () => ({
        gps_ok: true,
        fresh_ok: true,
        vision_ok: true,
        vision_reason: "safe",
        worker_distance_m: 0,
        confidence: 1,
        auto_approve: true,
      }),
    };
    service = createEyesService(deps);
    const app = createServer({
      service,
      providers,
      config,
      env: {},
      rpc: createRpc({ kind: "postgres", url: url ?? "" }),
    });
    listener = toNodeListener((req) => app.fetch(req));
    const signup = await service.signupAgent({ name: "Acceptance owner" });
    ownerKey = signup.api_key;
    owner = (await service.authenticate(ownerKey)) as Agent;
    otherKey = (await service.signupAgent({ name: "Other agent" })).api_key;
    const phone = `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;
    await service.joinWorker({ name: "Local worker", phone, lat: 37, lng: -122 });
    const [worker] = await sql`select id from workers where phone = ${phone}`;
    workerId = String(worker?.id);
    client = new Client({ name: "acceptance-local-runtime", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${ownerKey}` } },
      }),
    );
    clients.push(client);
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await sql.end();
  });

  async function fixture(status: string, answered = true) {
    const taskId = randomUUID();
    await sql`insert into tasks(id, agent_id, question, task_type, place_label, lat, lng, bounty_cents, fee_cents, deadline_at, status, claimed_by, claimed_at)
      values(${taskId}, ${owner.id}, 'Is the cafe open?', 'is_open', 'Local test cafe', 37, -122, 300, 50, now() + interval '1 hour', ${status}, ${workerId}, now())`;
    if (answered)
      await sql`insert into submissions(task_id, worker_id, answer_text, answer_bool, photo_url, lat, lng, captured_at, gps_ok, fresh_ok, vision_ok, vision_reason, confidence, source)
      values(${taskId}, ${workerId}, 'It is open', true, 'https://photos.eyes.test/local.jpg', 37, -122, now(), true, true, true, 'safe', 1, 'capture')`;
    await sql`insert into ledger(agent_id, task_id, type, amount_cents) values(${owner.id}, ${taskId}, 'escrow', 350)`;
    return taskId;
  }
  const request = (taskId: string, key: string | null = ownerKey) =>
    fetch(`${base}/v1/tasks/${taskId}/accept`, {
      method: "POST",
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
  const call = (taskId: string) => client.callTool({ name: "accept_answer", arguments: { task_id: taskId } });
  const money = async (taskId: string) => ({
    ledger: await sql`select * from ledger where task_id = ${taskId} order by id`,
    balance: await service.getBalance(owner),
    transfers: [...providers.payments.transfers],
    messages: providers.messaging.outbox.length,
  });

  it("advertises authenticated model and app callable idempotent feedback", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.filter((tool) => tool._meta?.["openai/visibility"] !== "private")).toHaveLength(13);
    const accept = tools.find((tool) => tool.name === "accept_answer");
    expect(accept).toMatchObject({
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { "openai/widgetAccessible": true, ui: { visibility: ["model", "app"] } },
    });
    const taskId = await fixture("paid");
    expect((await request(taskId, null)).status).toBe(401);
    expect((await request(taskId, "invalid-local-key")).status).toBe(401);
    const denied = await request(taskId, otherKey);
    expect(denied.status).toBe(404);
    expect(await denied.json()).toMatchObject({ error: "task_not_found" });
    expect((await request(randomUUID())).status).toBe(404);
    expect((await sql`select accepted_at from tasks where id = ${taskId}`)[0]?.accepted_at).toBeNull();
  });

  it.each(["verified", "paid"])(
    "persists one acceptance for %s across concurrent HTTP/MCP retries with no money changes",
    async (status) => {
      const taskId = await fixture(status);
      const before = await money(taskId);
      const [first, second, third] = await Promise.all([
        call(taskId),
        call(taskId),
        request(taskId).then((r) => r.json()),
      ]);
      const accepted = TOOLS.accept_answer.output.parse(first.structuredContent);
      expect(accepted).toEqual({ task_id: taskId, status: "accepted", accepted_at: expect.any(String) });
      expect(second.structuredContent).toEqual(accepted);
      expect(third).toEqual(accepted);
      providers.clock.advance(1000);
      expect(await (await request(taskId)).json()).toEqual(accepted);
      const reloaded = createEyesService(deps);
      const task = await reloaded.getTask(owner, { task_id: taskId });
      expect(task).toMatchObject({
        status,
        accepted_at: accepted.accepted_at,
        answer: { answer_text: "It is open" },
      });
      expect(
        (await client.callTool({ name: "show_task", arguments: { task_id: taskId } })).structuredContent,
      ).toMatchObject({ status, accepted_at: accepted.accepted_at });
      expect(await service.awaitAnswer(owner, { task_id: taskId, timeout_seconds: 1 })).toMatchObject({
        accepted_at: accepted.accepted_at,
      });
      expect(
        (await service.listTasks(owner, { limit: 50 })).tasks.find((t) => t.task_id === taskId),
      ).toMatchObject({ accepted_at: accepted.accepted_at });
      expect(await money(taskId)).toEqual(before);
      const events =
        await sql`select data from events where task_id = ${taskId} and kind = 'answer_accepted'`;
      expect(events).toHaveLength(1);
      expect(events[0]?.data).toMatchObject({ agent_id: owner.id });
      expect(new Date(events[0]?.data.accepted_at).toISOString()).toBe(accepted.accepted_at);
      expect(
        (await sql`select accepted_at from tasks where id = ${taskId}`)[0]?.accepted_at.toISOString(),
      ).toBe(accepted.accepted_at);
      expect(
        await service.disputeAnswer(owner, {
          task_id: taskId,
          reason: "The answer was wrong after checking",
        }),
      ).toMatchObject({ status: "disputed" });
      const disputed = await request(taskId);
      expect(disputed.status).toBe(409);
      expect(await disputed.json()).toMatchObject({ error: "task_not_acceptable" });
    },
  );

  it.each(TASK_STATUSES.filter((status) => status !== "verified" && status !== "paid"))(
    "rejects %s without storing feedback or moving money",
    async (status) => {
      const taskId = await fixture(status);
      const before = await money(taskId);
      const response = await request(taskId);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "task_not_acceptable", fix: expect.any(String) });
      const tool = await call(taskId);
      expect(tool.isError).toBe(true);
      expect(await money(taskId)).toEqual(before);
      expect(
        await sql`select * from events where task_id = ${taskId} and kind = 'answer_accepted'`,
      ).toHaveLength(0);
      expect((await sql`select accepted_at from tasks where id = ${taskId}`)[0]?.accepted_at).toBeNull();
    },
  );

  it("refuses a verified task with no delivered submission and invalid task IDs", async () => {
    const taskId = await fixture("verified", false);
    expect((await request(taskId)).status).toBe(409);
    expect((await request("not-a-uuid")).status).toBe(400);
    expect((await client.callTool({ name: "accept_answer", arguments: { task_id: "bad" } })).isError).toBe(
      true,
    );
  });
});
