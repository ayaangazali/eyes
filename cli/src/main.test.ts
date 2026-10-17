import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { type Deps, run } from "./main.ts";

const TASK_ID = "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b";

function setup(replies: [number, unknown][], env: Record<string, string> = {}) {
  const calls: { url: string; method?: string; auth?: string; body?: Record<string, unknown> }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: Deps = {
    fetch: async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        method: init?.method,
        auth: headers.authorization,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const [status, body] = replies.shift() ?? [500, { unexpected: "call" }];
      return new Response(JSON.stringify(body), { status });
    },
    env: { EYES_API_URL: "https://eyes.test", ...env },
    configPath: join(mkdtempSync(join(tmpdir(), "eyes-cli-")), "eyes", "config.json"),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { deps, calls, out, err };
}

it("signup saves api_url and api_key with 0600 permissions and later calls use them", async () => {
  const { deps, calls, out } = setup([
    [
      200,
      {
        agent_id: "a1b2c3d4-0000-4000-8000-000000000000",
        api_key: "eyes_test_key",
        balance_usd: 20,
        top_up_url: "https://eyes.test/topup/abc",
        next_step: "Save api_key now.",
      },
    ],
    [200, { balance_usd: 20, escrowed_usd: 0, top_up_url: "https://eyes.test/topup/abc" }],
  ]);

  expect(await run(["signup", "--name", "test-agent"], deps)).toBe(0);
  expect(calls[0]).toEqual({
    url: "https://eyes.test/v1/signup",
    method: "POST",
    auth: undefined,
    body: { name: "test-agent" },
  });
  expect(JSON.parse(readFileSync(deps.configPath, "utf8"))).toEqual({
    api_url: "https://eyes.test",
    api_key: "eyes_test_key",
  });
  expect(statSync(deps.configPath).mode & 0o777).toBe(0o600);
  expect(out.join("\n")).toContain("api_key: eyes_test_key");

  expect(await run(["balance"], { ...deps, env: {} })).toBe(0);
  expect(calls[1]).toMatchObject({ url: "https://eyes.test/v1/balance", auth: "Bearer eyes_test_key" });
});

it("ask sends an idempotency key, loops await until answered, then prints the answer", async () => {
  const pending = (status: string) => ({
    task_id: TASK_ID,
    status,
    answered: false,
    answer: null,
    next_step: "Call await_answer again.",
  });
  const { deps, calls, out } = setup(
    [
      [
        200,
        {
          task_id: TASK_ID,
          status: "dispatched",
          workers_notified: 3,
          escrowed_usd: 3.5,
          deadline_at: "2026-10-17T19:30:00.000Z",
          next_step: "Call await_answer.",
        },
      ],
      [200, pending("dispatched")],
      [200, pending("claimed")],
      [
        200,
        {
          ...pending("verified"),
          answered: true,
          answer: { answer_text: "About 4 people in line", photo_url: "https://storage.test/p.jpg" },
        },
      ],
    ],
    { EYES_API_KEY: "eyes_env_key" },
  );

  const code = await run(
    ["ask", "How long is the line?", "--at", "37.7825,-122.4078", "--type", "line_length"],
    deps,
  );

  expect(code).toBe(0);
  expect(calls).toHaveLength(4);
  expect(calls[0]).toMatchObject({
    url: "https://eyes.test/v1/tasks",
    method: "POST",
    auth: "Bearer eyes_env_key",
    body: {
      question: "How long is the line?",
      location: { lat: 37.7825, lng: -122.4078 },
      task_type: "line_length",
    },
  });
  expect(calls[0]?.body?.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
  for (const call of calls.slice(1)) {
    expect(call).toMatchObject({ url: `https://eyes.test/v1/tasks/${TASK_ID}/await`, method: "POST" });
  }
  expect(out).toContain("status: claimed");
  expect(out.join("\n")).toContain("answer.answer_text: About 4 people in line");
});

it("prints the error message and fix from an error body and exits 1", async () => {
  const { deps, calls, err } = setup([
    [
      402,
      {
        error: "insufficient_balance",
        message: "Your balance is too low to escrow this task.",
        fix: "Ask your user to top up at https://eyes.test/topup/abc, or lower bounty_usd to 0.7 or less.",
        balance_usd: 1.2,
      },
    ],
  ]);

  const code = await run(
    ["ask", "Is it open now?", "--at", "Ferry Building, San Francisco", "--type", "is_open"],
    deps,
  );

  expect(code).toBe(1);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body?.location).toBe("Ferry Building, San Francisco");
  expect(err).toEqual([
    "Error (insufficient_balance): Your balance is too low to escrow this task.",
    "Fix: Ask your user to top up at https://eyes.test/topup/abc, or lower bounty_usd to 0.7 or less.",
    "balance_usd: 1.2",
  ]);
});

it("--json prints the raw response body for success and for errors", async () => {
  const policy = {
    max_bounty_usd: 10,
    daily_cap_usd: 50,
    spent_today_usd: 3.5,
    remaining_today_usd: 46.5,
    allowed_task_types: ["is_open", "line_length"],
  };
  const unauthorized = {
    error: "unauthorized",
    message: "Missing or invalid API key.",
    fix: "Run eyes signup.",
  };
  const { deps, out } = setup([
    [200, policy],
    [401, unauthorized],
  ]);

  expect(await run(["policy", "--json"], deps)).toBe(0);
  expect(await run(["status", TASK_ID, "--json"], deps)).toBe(1);
  expect(out.map((line) => JSON.parse(line))).toEqual([policy, unauthorized]);
});
