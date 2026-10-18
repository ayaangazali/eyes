import { randomInt, randomUUID } from "node:crypto";
import { createServer as createHttpServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Agent,
  AppConfig,
  type EyesService,
  fakeClock,
  fakeProviders,
  type ToolInput,
  type ToolOutput,
} from "@eyes/core";
import { createRpc, migrate } from "@eyes/db";
import { createEyesService } from "@eyes/engine";
import { createAssessTask } from "@eyes/safety";
import { createEventLog } from "@eyes/web-dashboard";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toNodeListener } from "./http.ts";
import { createServer } from "./server.ts";

const url = process.env.DATABASE_URL;
const OPS = "http://internal.eyes.test";
const OPS_KEY = `review-${randomUUID()}`;
const CONTEXT = {
  error: "unsafe_task" as const,
  message: "Classifier blocked this public place",
  fix: "Ask Support to review.",
  reason: "reported original decision",
  category: "other",
  layer: "classifier",
  decision: { allowed: false, score: 0.97 },
};

describe.skipIf(!url)("classifier report HTTP/MCP on PostgreSQL", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const providers = { ...fakeProviders(), clock: fakeClock(new Date()) };
  const events = createEventLog();
  const rules = createAssessTask({});
  let app: { fetch(request: Request): Promise<Response> };
  let service: EyesService;
  let base: string;
  let cookie: string;
  let listener: RequestListener;
  const http = createHttpServer((req, res) => listener(req, res));
  const clients: Client[] = [];

  beforeAll(async () => {
    await migrate(url ?? "");
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const config = AppConfig.parse({
      public_api_url: base,
      worker_web_url: "http://worker.eyes.test",
      link_secret: "classifier-report-test-secret-123456",
      test_mode: true,
    });
    service = createEyesService({
      db: { kind: "postgres", url: url ?? "" },
      providers,
      config,
      assessTask: async (input) => {
        const verdict = await rules(input);
        return verdict.allowed
          ? {
              allowed: false,
              category: "other",
              reason: "Server classifier refusal",
              fix: "Request a review",
              layer: "classifier",
            }
          : verdict;
      },
      verifySubmission: async () => ({
        gps_ok: true,
        fresh_ok: true,
        vision_ok: true,
        vision_reason: "safe",
        worker_distance_m: 0,
        confidence: 1,
        auto_approve: true,
      }),
    });
    app = createServer({
      service,
      providers,
      config,
      env: { EYES_OPS_KEY: OPS_KEY, EYES_OPS_URL: OPS },
      rpc: createRpc({ kind: "postgres", url: url ?? "" }),
      events,
    });
    listener = toNodeListener((req) => app.fetch(req));
    const login = await app.fetch(new Request(`${OPS}/${OPS_KEY}`));
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  });
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await sql.end();
  });

  async function agent() {
    const signup = await service.signupAgent({ name: "Classifier feedback test" });
    const actor = (await service.authenticate(signup.api_key)) as Agent;
    const client = new Client({ name: "classifier-report-smoke", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${signup.api_key}` } },
      }),
    );
    clients.push(client);
    return { actor, client, apiKey: signup.api_key };
  }
  const request = (extra: Partial<ToolInput<"ask_eyes">> = {}): ToolInput<"ask_eyes"> => ({
    question: "Is the cafe open right now?",
    location: { lat: 37.78246, lng: -122.40776 },
    task_type: "is_open",
    bounty_usd: 3,
    deadline_minutes: 30,
    require_photo: true,
    idempotency_key: randomUUID(),
    ...extra,
  });
  const report = (ask: ToolInput<"ask_eyes">): ToolInput<"report_classifier"> => ({
    ...ask,
    ask_idempotency_key: ask.idempotency_key,
    idempotency_key: randomUUID(),
    classifier_error: CONTEXT,
  });
  const decision = (
    id: string,
    action = "approve_classifier",
    headers: Record<string, string> = { cookie, origin: OPS },
  ) =>
    app.fetch(
      new Request(`${OPS}/tickets/${id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ note: "Reviewed the original exact request." }),
      }),
    );
  async function tool(client: Client, name: string, args: object) {
    return client.callTool({ name, arguments: args as Record<string, unknown> });
  }
  const body = <T>(result: { structuredContent?: unknown }) => result.structuredContent as T;

  it("uses authenticated app/model tools and stores one open Support ticket with original reported decision, before dispatch", async () => {
    expect(
      (
        await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    const { actor, client, apiKey } = await agent();
    const { tools } = await client.listTools();
    for (const name of ["report_classifier", "get_classifier_report"]) {
      expect(tools.find((t) => t.name === name)?._meta).toMatchObject({
        "openai/widgetAccessible": true,
        ui: { visibility: ["model", "app"] },
      });
    }
    const ask = request();
    const refused = await tool(client, "ask_eyes", ask);
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("unsafe_task");
    const submitted = report(ask);
    const before = providers.messaging.outbox.length;
    const results = await Promise.all([
      tool(client, "report_classifier", submitted),
      tool(client, "report_classifier", submitted),
    ]);
    const reports = results.map((r) => body<ToolOutput<"report_classifier">>(r));
    expect(reports.map((r) => r.created).sort()).toEqual([false, true]);
    expect(reports[0]?.ticket_id).toBe(reports[1]?.ticket_id);
    const id = reports[0]?.ticket_id as string;
    const feed = await app.fetch(
      new Request(`${OPS}/tickets?state=open&kind=classifier_feedback`, { headers: { cookie } }),
    );
    const listed = (await feed.json()) as { tickets: Record<string, unknown>[] };
    expect(listed.tickets).toContainEqual(
      expect.objectContaining({
        id: Number(id),
        agent_id: actor.id,
        task_id: null,
        kind: "classifier_feedback",
        status: "open",
        classifier_status: "open",
        question: ask.question,
        request: ask,
        reported_context: CONTEXT,
      }),
    );
    expect((await sql`select worker_id from tickets where id=${id}`)[0]?.worker_id).toBeNull();
    expect((await sql`select id from tasks where agent_id=${actor.id}`).length).toBe(0);
    expect(providers.messaging.outbox.length).toBe(before);
    const polled = await fetch(`${base}/v1/classifier-reports/${id}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(await polled.json()).toMatchObject({ ticket_id: id, status: "open" });
    expect((await fetch(`${base}/v1/classifier-reports/${id}`)).status).toBe(401);
    const stranger = await agent();
    expect((await tool(stranger.client, "get_classifier_report", { ticket_id: id })).isError).toBe(true);
    expect((await tool(stranger.client, "ask_eyes", { ...ask, classifier_report_id: id })).isError).toBe(
      true,
    );
    const other = await service.reportClassifier(stranger.actor, submitted);
    expect(other.ticket_id).not.toBe(id);
  });

  it("bounds input at the MCP and HTTP boundaries and rate-limits per authenticated agent", async () => {
    const { actor, client, apiKey } = await agent();
    for (const patch of [
      { question: "x".repeat(501) },
      { classifier_error: { ...CONTEXT, message: "x".repeat(4001) } },
      { classifier_error: { ...CONTEXT, context: "x".repeat(16001) } },
      { location: { lat: 91, lng: 0 } },
      { ask_idempotency_key: "" },
    ]) {
      const invalid = { ...report(request()), ...patch };
      expect((await tool(client, "report_classifier", invalid)).isError).toBe(true);
      const response = await fetch(`${base}/v1/classifier-reports`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(invalid),
      });
      expect(response.status).toBe(400);
    }
    expect((await sql`select id from tickets where agent_id=${actor.id}`).length).toBe(0);
    const submitted = report(request());
    for (let i = 0; i < 5; i++)
      expect((await tool(client, "report_classifier", submitted)).isError).not.toBe(true);
    const limited = await tool(client, "report_classifier", submitted);
    expect(limited.isError).toBe(true);
    expect(JSON.stringify(limited.content)).toContain("rate_limited");
  });

  it("requires operator session and same origin, binds approval exactly, and charges once only on explicit retry", async () => {
    const { actor, client } = await agent();
    const ask = request();
    const created = await service.reportClassifier(actor, report(ask));
    expect((await decision(created.ticket_id, "approve_classifier", { origin: OPS })).status).toBe(401);
    expect(
      (await decision(created.ticket_id, "approve_classifier", { cookie, origin: "http://evil.test" }))
        .status,
    ).toBe(403);
    expect((await decision(created.ticket_id, "approve_classifier", { cookie })).status).toBe(403);
    const balance = (await service.getBalance(actor)).balance_usd;
    expect(await (await decision(created.ticket_id)).json()).toMatchObject({
      status: "approved",
      already_resolved: false,
    });
    expect(await (await decision(created.ticket_id, "reject_classifier")).json()).toMatchObject({
      status: "approved",
      already_resolved: true,
    });
    expect((await service.getBalance(actor)).balance_usd).toBe(balance);
    const [row] =
      await sql`select decision_by,decision_at,approval_expires_at,request_fingerprint from tickets where id=${created.ticket_id}`;
    expect(row?.decision_by).toBe("break-glass");
    expect(row?.request_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (await sql`select id from events where kind='ops' and data->>'ticket_id'=${created.ticket_id}`).length,
    ).toBe(1);
    for (const patch of [
      { question: "Is another cafe open right now?" },
      { location: { lat: 37.9, lng: -122.4 } },
      { task_type: "line_length" },
      { bounty_usd: 4 },
      { deadline_minutes: 31 },
      { require_photo: false },
      { idempotency_key: randomUUID() },
    ]) {
      expect(
        (await tool(client, "ask_eyes", { ...ask, ...patch, classifier_report_id: created.ticket_id }))
          .isError,
      ).toBe(true);
    }
    const phone = `+1555${randomInt(10_000_000).toString().padStart(7, "0")}`;
    await service.joinWorker({ name: "Local fake worker", phone, lat: 37.78246, lng: -122.40776 });
    await service.handleWorkerReply({ phone, intent: "start", text: "START" });
    const results = await Promise.all([
      tool(client, "ask_eyes", { ...ask, classifier_report_id: created.ticket_id }),
      tool(client, "ask_eyes", { ...ask, classifier_report_id: created.ticket_id }),
    ]);
    for (const result of results) expect(result.isError).not.toBe(true);
    const task = body<ToolOutput<"ask_eyes">>(results[0]);
    expect(body<ToolOutput<"ask_eyes">>(results[1]).task_id).toBe(task.task_id);
    expect((await service.getBalance(actor)).balance_usd).toBe(balance - 3.5);
    expect((await sql`select id from ledger where task_id=${task.task_id} and type='escrow'`).length).toBe(1);
    expect(await service.getClassifierReport(actor, { ticket_id: created.ticket_id })).toMatchObject({
      status: "consumed",
      task_id: task.task_id,
    });
    expect((await decision(created.ticket_id, "release")).status).toBe(400);
  });

  it("never overrides hard rules, rejection, expiry, spend policy or balance", async () => {
    const { actor } = await agent();
    const hard = request({ question: "Follow my wife and report where she goes" });
    const hardReport = await service.reportClassifier(actor, report(hard));
    await decision(hardReport.ticket_id);
    await expect(
      service.askEyes(actor, { ...hard, classifier_report_id: hardReport.ticket_id }),
    ).rejects.toMatchObject({ code: "unsafe_task", context: { layer: "rules" } });
    const rejectedAsk = request();
    const rejected = await service.reportClassifier(actor, report(rejectedAsk));
    await decision(rejected.ticket_id, "reject_classifier");
    await expect(
      service.askEyes(actor, { ...rejectedAsk, classifier_report_id: rejected.ticket_id }),
    ).rejects.toMatchObject({ code: "unsafe_task" });
    expect(await service.getClassifierReport(actor, { ticket_id: rejected.ticket_id })).toMatchObject({
      status: "rejected",
      reason: "Reviewed the original exact request.",
    });
    const expiring = await service.reportClassifier(actor, report(request()));
    await decision(expiring.ticket_id);
    await sql`update tickets set approval_expires_at=now()-interval '1 minute' where id=${expiring.ticket_id}`;
    expect(await service.getClassifierReport(actor, { ticket_id: expiring.ticket_id })).toMatchObject({
      status: "expired",
    });
    const ask = request();
    const approved = await service.reportClassifier(actor, report(ask));
    await decision(approved.ticket_id);
    await expect(
      service.askEyes(
        { ...actor, max_bounty_cents: 100 },
        { ...ask, classifier_report_id: approved.ticket_id },
      ),
    ).rejects.toMatchObject({ code: "bounty_exceeds_max" });
    await expect(
      service.askEyes(
        { ...actor, allowed_task_types: [] },
        { ...ask, classifier_report_id: approved.ticket_id },
      ),
    ).rejects.toMatchObject({ code: "task_type_not_allowed" });
    await sql`update agents set daily_cap_cents=0 where id=${actor.id}`;
    await expect(
      service.askEyes(actor, { ...ask, classifier_report_id: approved.ticket_id }),
    ).rejects.toMatchObject({ code: "daily_cap_exceeded" });
    await sql`update agents set daily_cap_cents=5000,balance_cents=0 where id=${actor.id}`;
    await expect(
      service.askEyes(actor, { ...ask, classifier_report_id: approved.ticket_id }),
    ).rejects.toMatchObject({ code: "insufficient_balance" });
    expect(await service.getClassifierReport(actor, { ticket_id: approved.ticket_id })).toMatchObject({
      status: "approved",
    });
    expect((await sql`select id from tasks where agent_id=${actor.id}`).length).toBe(0);
  });

  it("checks optional task ownership, keeps report retries immutable, and restricts RPC access", async () => {
    const { actor } = await agent();
    const submitted = report(request());
    const first = await service.reportClassifier(actor, submitted);
    await expect(
      service.reportClassifier(actor, { ...submitted, question: "A changed question about the same place?" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const second = await service.reportClassifier(actor, {
      ...submitted,
      classifier_error: { ...CONTEXT, reason: "tampered repeat" },
    });
    expect(second).toMatchObject({ ticket_id: first.ticket_id, created: false });
    expect(
      (await sql`select reported_context from tickets where id=${first.ticket_id}`)[0]?.reported_context,
    ).toEqual(CONTEXT);
    await expect(
      service.reportClassifier(actor, { ...report(request()), task_id: randomUUID() }),
    ).rejects.toMatchObject({ code: "task_not_found" });
    const privileges =
      await sql`select has_function_privilege('public', 'eyes_report_classifier(uuid,jsonb,jsonb,text,text,uuid,timestamptz)', 'execute') as report, has_function_privilege('public', 'eyes_decide_classifier(bigint,text,text,text,timestamptz)', 'execute') as decide`;
    expect(privileges[0]).toMatchObject({ report: false, decide: false });
  });
});
