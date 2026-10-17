import { randomInt, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfig, fakeProviders, type SignupOutput } from "@eyes/core";
import { migrate } from "@eyes/db";
import { createEyesService } from "@eyes/engine";
import { toNodeListener } from "@eyes/mcp/src/http.ts";
import { createServer } from "@eyes/mcp/src/server.ts";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Deps, run } from "./main.ts";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("eyes ask against the real server and Postgres", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const providers = { ...fakeProviders(), clock: { now: () => new Date() } };
  const config = AppConfig.parse({
    public_api_url: "http://127.0.0.1",
    worker_web_url: "http://127.0.0.1",
    link_secret: "cli-int-link-secret-0123456789",
  });
  const service = createEyesService({
    db: { kind: "postgres", url: url ?? "" },
    providers,
    assessTask: async () => ({ allowed: true, category: null, reason: null, fix: null, layer: null }),
    verifySubmission: async () => ({
      gps_ok: true,
      fresh_ok: true,
      vision_ok: true,
      vision_reason: "unused",
      worker_distance_m: 0,
      confidence: 1,
      auto_approve: true,
    }),
    config,
  });
  const here = { lat: 10 + Math.random() * 40, lng: -120 + Math.random() * 60 };
  const configPath = join(mkdtempSync(join(tmpdir(), "eyes-cli-int-")), "config.json");
  const out: string[] = [];
  let http: Server | undefined;
  let api = "";

  const deps = (extra: Partial<Deps> = {}): Deps => ({
    fetch,
    env: { EYES_API_URL: api },
    configPath,
    out: (line) => out.push(line),
    err: () => undefined,
    sleep: async () => undefined,
    now: Date.now,
    ...extra,
  });

  beforeAll(async () => {
    await migrate(url ?? "");
    http = createHttpServer(toNodeListener(createServer({ service, providers, config, env: {} }).fetch));
    await new Promise<void>((resolve) => http?.listen(0, "127.0.0.1", resolve));
    api = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const phone = `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;
    await service.joinWorker({ name: "CLI Worker", phone, ...here });
    await service.handleWorkerReply({ phone, intent: "start", text: "START" });
  });

  afterAll(async () => {
    http?.close();
    await sql.end();
  });

  it("escrows exactly once per question for a repeated key and for an interrupted ask that is re-run", async () => {
    expect(await run(["signup", "--name", "cli-int-agent", "--json"], deps())).toBe(0);
    const { agent_id } = JSON.parse(out[0] ?? "") as SignupOutput;
    const at = `${here.lat},${here.lng}`;

    const keyed = ["ask", "Is the cafe open right now?", "--at", at, "--type", "is_open"];
    const withKey = [...keyed, "--idempotency-key", randomUUID(), "--no-wait", "--json"];
    out.length = 0;
    expect(await run(withKey, deps())).toBe(0);
    expect(await run(withKey, deps())).toBe(0);
    const [first, second] = out.map((line) => JSON.parse(line));
    expect(second.task_id).toBe(first.task_id);

    const plain = [
      "ask",
      "How long is the line right now?",
      "--at",
      at,
      "--type",
      "line_length",
      "--no-wait",
      "--json",
    ];
    const stop = new AbortController();
    const crashAfterSending: typeof fetch = async (input, init) => {
      await fetch(input, init);
      stop.abort();
      throw new DOMException("This operation was aborted", "AbortError");
    };
    expect(await run(plain, deps({ fetch: crashAfterSending, signal: stop.signal }))).toBe(130);
    out.length = 0;
    expect(await run(plain, deps())).toBe(0);
    const rerun = JSON.parse(out[0] ?? "");

    const tasks = await sql<{ id: string; escrows: number }[]>`
      select t.id, count(l.id)::int as escrows
      from tasks t left join ledger l on l.task_id = t.id and l.type = 'escrow'
      where t.agent_id = ${agent_id}
      group by t.id`;
    expect(tasks.map((t) => t.id).sort()).toEqual([first.task_id, rerun.task_id].sort());
    expect(tasks.map((t) => t.escrows)).toEqual([1, 1]);
  });
});
