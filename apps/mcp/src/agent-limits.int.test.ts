import { randomUUID } from "node:crypto";
import { AppConfig, fakeProviders } from "@eyes/core";
import { createRpc, migrate } from "@eyes/db";
import { createEyesService } from "@eyes/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./server.ts";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("agent request limits in Postgres", () => {
  const providers = fakeProviders();
  const config = AppConfig.parse({
    public_api_url: "http://api.eyes.test",
    worker_web_url: "http://worker.eyes.test",
    link_secret: "agent-limits-test-secret-0123456789",
    max_open_tasks: 1,
  });
  const db = { kind: "postgres" as const, url: url ?? "" };
  const deps = {
    db,
    providers,
    config,
    assessTask: async () => ({ allowed: true, category: null, reason: null, fix: null, layer: null }),
    verifySubmission: async () => {
      throw new Error("not used");
    },
  };
  const service = createEyesService(deps);
  // Two server processes: separate memory, one database.
  const env = { EYES_AGENT_TASKS_PER_HOUR: "3", EYES_AGENT_QUOTES_PER_HOUR: "2" };
  const makeServer = () =>
    createServer({ service: createEyesService(deps), providers, config, env, rpc: createRpc(db) });
  const [a, b] = [makeServer(), makeServer()];
  beforeAll(() => migrate(url ?? ""));

  const post = (server: typeof a, key: string, path: string, body: unknown) =>
    server.fetch(
      new Request(`http://api.eyes.test${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const ask = (server: typeof a, key: string) =>
    post(server, key, "/v1/tasks", {
      question: "Is this public cafe open?",
      location: { lat: 37.7, lng: -122.4 },
      task_type: "is_open",
      bounty_usd: 3,
      idempotency_key: randomUUID(),
    });

  it("returns 429 on call limit + 1 across two server processes, per agent", async () => {
    const { api_key: key } = await service.signupAgent({ name: "limit one" });
    const { api_key: other } = await service.signupAgent({ name: "limit two" });
    const statuses = [];
    for (const server of [a, b, a, b]) statuses.push((await ask(server, key)).status);
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses[3]).toBe(429);
    const limited = await ask(a, key);
    expect(await limited.json()).toMatchObject({ error: "rate_limited", fix: expect.any(String) });
    expect((await ask(a, other)).status).not.toBe(429);
  });

  it("limits quotes separately from task creates", async () => {
    const { api_key: key } = await service.signupAgent({ name: "limit quotes" });
    const quote = (server: typeof a) =>
      post(server, key, "/v1/quote", { location: { lat: 37.7, lng: -122.4 }, task_type: "is_open" });
    expect([(await quote(a)).status, (await quote(b)).status]).not.toContain(429);
    expect((await quote(a)).status).toBe(429);
    expect((await ask(b, key)).status).not.toBe(429);
  });

  it("refuses a task past the open-task cap, not before", async () => {
    await service.joinWorker({ name: "cap worker", phone: "+15559990001", lat: 37.7, lng: -122.4 });
    await service.handleWorkerReply({ phone: "+15559990001", intent: "start", text: "START" });
    const { api_key: key } = await service.signupAgent({ name: "open cap" });
    const first = await ask(a, key);
    expect(first.status, await first.clone().text()).toBe(200);
    const second = await ask(b, key);
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: "rate_limited" });
  });
});
