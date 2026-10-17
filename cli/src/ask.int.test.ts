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

  const crashingAfterSend = () => {
    const stop = new AbortController();
    const crash: typeof fetch = async (input, init) => {
      await fetch(input, init);
      stop.abort();
      throw new DOMException("This operation was aborted", "AbortError");
    };
    return deps({ fetch: crash, signal: stop.signal });
  };

  it("escrows exactly once per question: repeated key, interrupted re-run, and concurrent different asks", async () => {
    expect(await run(["signup", "--name", "cli-int-agent", "--json"], deps())).toBe(0);
    const { agent_id } = JSON.parse(out[0] ?? "") as SignupOutput;
    const ask = (question: string, type: string) => [
      "ask",
      question,
      "--at",
      `${here.lat},${here.lng}`,
      "--type",
      type,
      "--no-wait",
      "--json",
    ];

    const withKey = [...ask("Is the cafe open right now?", "is_open"), "--idempotency-key", randomUUID()];
    out.length = 0;
    expect(await run(withKey, deps())).toBe(0);
    expect(await run(withKey, deps())).toBe(0);
    const [first, second] = out.map((line) => JSON.parse(line));
    expect(second.task_id).toBe(first.task_id);

    const line = ask("How long is the line right now?", "line_length");
    expect(await run(line, crashingAfterSend())).toBe(130);
    expect(await run(line, deps())).toBe(0);

    const bakery = ask("Is the bakery open right now?", "is_open");
    const plaza = ask("How crowded is the plaza right now?", "crowd_level");
    expect(await Promise.all([run(bakery, crashingAfterSend()), run(plaza, crashingAfterSend())])).toEqual([
      130, 130,
    ]);
    expect(await Promise.all([run(bakery, deps()), run(plaza, deps())])).toEqual([0, 0]);

    const rows = await sql<{ question: string; tasks: number; escrows: number }[]>`
      select t.question, count(distinct t.id)::int as tasks, count(l.id)::int as escrows
      from tasks t left join ledger l on l.task_id = t.id and l.type = 'escrow'
      where t.agent_id = ${agent_id}
      group by t.question
      order by t.question`;
    expect(rows.map((r) => [r.question, r.tasks, r.escrows])).toEqual([
      ["How crowded is the plaza right now?", 1, 1],
      ["How long is the line right now?", 1, 1],
      ["Is the bakery open right now?", 1, 1],
      ["Is the cafe open right now?", 1, 1],
    ]);
  });
});
