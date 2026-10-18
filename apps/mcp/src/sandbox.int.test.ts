import { randomInt, randomUUID } from "node:crypto";
import { AppConfig, fakeProviders, TOOLS, type ToolName, type ToolOutput } from "@eyes/core";
import { migrate } from "@eyes/db";
import { createAssessTask } from "@eyes/safety";
import { verifySubmission } from "@eyes/verify";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandboxService, SANDBOX } from "./sandbox.ts";
import { createServer } from "./server.ts";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("keyless sandbox on Postgres", () => {
  const providers = { ...fakeProviders(), clock: { now: () => new Date() } };
  const config = AppConfig.parse({
    public_api_url: "http://sandbox.eyes.test",
    worker_web_url: "http://worker.eyes.test",
    link_secret: "sandbox-int-link-secret-0123456789",
  });
  const service = createSandboxService({
    db: { kind: "postgres", url: url ?? "" },
    providers,
    assessTask: createAssessTask({}),
    verifySubmission,
    config,
  });
  const server = createServer({ service, providers, config, env: { EYES_SANDBOX: "1" } });

  const client = new Client({ name: "sandbox-int", version: "1.0.0" });
  const call = async <T extends ToolName>(name: T, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBeFalsy();
    return TOOLS[name].output.parse(result.structuredContent) as ToolOutput<T>;
  };
  const somewhere = () => ({ lat: 10 + Math.random() * 40, lng: -120 + Math.random() * 60 });

  beforeAll(async () => {
    await migrate(url ?? "");
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://sandbox.eyes.test/mcp"), {
        fetch: (input, init) => server.fetch(new Request(input, init)),
      }),
    );
  });
  afterAll(() => client.close());

  it("answers quote_task, ask_eyes and await_answer with no API key, verified, for parallel asks at one place", async () => {
    const place = somewhere();

    const quote = await call("quote_task", { location: place, task_type: "line_length" });
    expect(quote.allowed).toBe(true);
    expect(quote.workers_nearby).toBeGreaterThan(0);

    const asks = await Promise.all(
      ["line_length", "is_open", "crowd_level"].map((task_type) =>
        call("ask_eyes", {
          question: "What is it like there right now?",
          location: place,
          task_type,
          bounty_usd: quote.suggested_bounty_usd,
          idempotency_key: randomUUID(),
        }),
      ),
    );
    expect(asks.map((a) => a.workers_notified).every((n) => n > 0)).toBe(true);
    expect(asks[0]?.next_step).toContain(SANDBOX);

    const answers = await Promise.all(asks.map((a) => call("await_answer", { task_id: a.task_id })));
    for (const answer of answers) {
      expect(answer).toMatchObject({
        status: "verified",
        answered: true,
        answer: { verification: { gps_ok: true, fresh_ok: true, vision_ok: true } },
      });
      expect(answer.answer?.answer_text).toMatch(/^Simulated sandbox answer, nobody went: /);
      expect(answer.next_step).toContain(SANDBOX);
    }
  }, 30_000);

  it("never answers for a worker whose number is not a sandbox number", async () => {
    const place = somewhere();
    const phone = `+1415867${String(randomInt(10_000)).padStart(4, "0")}`;
    await service.joinWorker({ name: "Real Worker", phone, ...place });
    await service.handleWorkerReply({ phone, intent: "start", text: "START" });

    const asked = await call("ask_eyes", {
      question: "Is it open right now?",
      location: place,
      task_type: "is_open",
      idempotency_key: randomUUID(),
    });
    expect(asked.workers_notified).toBe(1);
    const sent = providers.messaging.outbox.filter((m) => m.to === phone).map((m) => m.kind);
    expect(sent).toContain("offer");

    const waited = await call("await_answer", { task_id: asked.task_id, timeout_seconds: 8 });
    expect(waited).toMatchObject({ status: "dispatched", answered: false });
    expect(providers.messaging.outbox.filter((m) => m.to === phone).map((m) => m.kind)).toEqual(sent);
  }, 30_000);
});
