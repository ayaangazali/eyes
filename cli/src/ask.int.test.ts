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

  async function worker(at = here) {
    const phone = `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;
    await service.joinWorker({ name: "CLI Worker", phone, ...at });
    await service.handleWorkerReply({ phone, intent: "start", text: "START" });
  }

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
    await worker();
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
    const ask = (question: string, type: string, at = here) => [
      "ask",
      question,
      "--at",
      `${at.lat},${at.lng}`,
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

    await worker();
    const line = ask("How long is the line right now?", "line_length");
    expect(await run(line, crashingAfterSend())).toBe(130);
    expect(await run(line, deps())).toBe(0);

    const bakeryAt = { ...here, lat: here.lat + 0.1 };
    const plazaAt = { ...here, lat: here.lat - 0.1 };
    await worker(bakeryAt);
    await worker(plazaAt);
    const bakery = ask("Is the bakery open right now?", "is_open", bakeryAt);
    const plaza = ask("How crowded is the plaza right now?", "crowd_level", plazaAt);
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

  it("pages tasks through the CLI over HTTP", async () => {
    const signup = await service.signupAgent({ name: "cli-paging" });
    await sql`insert into tasks
      (agent_id, question, task_type, place_label, lat, lng, bounty_cents, fee_cents, deadline_at, created_at)
      select ${signup.agent_id}, 'Is it open?', 'is_open', 'Pier', 1, 1, 300, 0,
        '2026-10-20T12:00:00Z', '2026-10-20T11:00:00.123456Z'
      from generate_series(1, 55)`;
    const expected =
      await sql`select id from tasks where agent_id = ${signup.agent_id} order by created_at desc, id desc`;
    const output: string[] = [];
    const paging = deps({
      env: { EYES_API_URL: api, EYES_API_KEY: signup.api_key },
      out: (line) => output.push(line),
    });
    const args = ["tasks", "--status", "dispatched", "--limit", "50", "--json"];
    expect(await run(args, paging)).toBe(0);
    const first = JSON.parse(output[0] ?? "null");
    expect(first.tasks.map((task: { task_id: string }) => task.task_id)).toEqual(
      expected.slice(0, 50).map((row) => row.id),
    );
    expect(await run([...args, "--before", first.next_cursor], paging)).toBe(0);
    const last = JSON.parse(output[1] ?? "null");
    expect(last.tasks.map((task: { task_id: string }) => task.task_id)).toEqual(
      expected.slice(50).map((row) => row.id),
    );
    expect(last.next_cursor).toBeNull();
  });
});
