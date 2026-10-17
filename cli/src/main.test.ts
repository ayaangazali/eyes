import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { type Deps, run } from "./main.ts";

const TASK_ID = "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b";
const ASK = [
  "ask",
  "How long is the line?",
  "--at",
  "Ferry Building, San Francisco",
  "--type",
  "line_length",
];
const ASKED = {
  task_id: TASK_ID,
  status: "dispatched",
  workers_notified: 3,
  escrowed_usd: 3.5,
  deadline_at: "2026-10-17T19:30:00.000Z",
  next_step: "Call await_answer.",
};
const pending = (status: string) => ({
  task_id: TASK_ID,
  status,
  answered: false,
  answer: null,
  next_step: "Call await_answer again.",
});
const ANSWERED = {
  ...pending("verified"),
  answered: true,
  answer: { answer_text: "About 4 people in line", photo_url: "https://storage.test/p.jpg" },
};
const SIGNED_UP = {
  agent_id: "a1b2c3d4-0000-4000-8000-000000000000",
  api_key: "eyes_test_key",
  balance_usd: 20,
  top_up_url: "https://eyes.test/topup/abc",
  email_address: "ask+a1b2-0123456789abcdef@eyes.primitive.email",
  next_step: "Save api_key now.",
};
const KEYS = { EYES_API_URL: "https://eyes.test", EYES_API_KEY: "eyes_env_key" };

type Reply = [number, unknown] | Error;

function setup(replies: Reply[], env: Record<string, string> = KEYS) {
  const calls: {
    url: string;
    method?: string;
    auth?: string;
    body?: Record<string, unknown>;
    outSoFar: string;
  }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const deps: Deps = {
    fetch: async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        method: init?.method,
        auth: headers.authorization,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        outSoFar: out.join("\n"),
      });
      const reply = replies.shift() ?? [500, { unexpected: "call" }];
      if (reply instanceof Error) throw reply;
      const [status, body] = reply;
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    },
    env,
    configPath: join(mkdtempSync(join(tmpdir(), "eyes-cli-")), "eyes", "config.json"),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    sleep: async (ms) => sleeps.push(ms),
  };
  return { deps, calls, out, err, sleeps };
}

it("signup prints the key, saves it 0600 over an existing 0644 file, and later calls use it", async () => {
  const { deps, calls, out } = setup(
    [
      [200, SIGNED_UP],
      [200, { balance_usd: 20, escrowed_usd: 0, top_up_url: "https://eyes.test/topup/abc" }],
    ],
    { EYES_API_URL: "https://eyes.test" },
  );
  mkdirSync(dirname(deps.configPath), { recursive: true });
  writeFileSync(deps.configPath, "{}", { mode: 0o644 });

  expect(await run(["signup", "--name", "test-agent"], deps)).toBe(0);

  expect(calls[0]).toMatchObject({
    url: "https://eyes.test/v1/signup",
    auth: undefined,
    body: { name: "test-agent" },
  });
  expect(out.join("\n")).toContain("api_key: eyes_test_key");
  expect(out.join("\n")).toContain(`email_address: ${SIGNED_UP.email_address}`);
  expect(JSON.parse(readFileSync(deps.configPath, "utf8"))).toEqual({
    api_url: "https://eyes.test",
    api_key: "eyes_test_key",
  });
  expect(statSync(deps.configPath).mode & 0o777).toBe(0o600);

  expect(await run(["balance"], { ...deps, env: {} })).toBe(0);
  expect(calls[1]).toMatchObject({ url: "https://eyes.test/v1/balance", auth: "Bearer eyes_test_key" });
});

it("signup still prints the key when saving fails, then errors with a fix naming EYES_API_KEY", async () => {
  const { deps, out, err } = setup([[200, SIGNED_UP]], { EYES_API_URL: "https://eyes.test" });
  mkdirSync(dirname(deps.configPath), { recursive: true, mode: 0o500 });

  expect(await run(["signup", "--name", "test-agent"], deps)).toBe(1);

  expect(out.join("\n")).toContain("api_key: eyes_test_key");
  expect(err[0]).toMatch(/^Error \(config_error\)/);
  expect(err[1]).toContain("EYES_API_KEY");
});

it("env vars override an existing config file", async () => {
  const { deps, calls } = setup([[200, { balance_usd: 1, escrowed_usd: 0, top_up_url: null }]]);
  mkdirSync(dirname(deps.configPath), { recursive: true });
  writeFileSync(deps.configPath, JSON.stringify({ api_url: "https://file.test", api_key: "file_key" }));

  expect(await run(["balance"], deps)).toBe(0);
  expect(calls[0]).toMatchObject({ url: "https://eyes.test/v1/balance", auth: "Bearer eyes_env_key" });
});

it("ask prints task_id and idempotency_key before waiting, loops await until answered, then prints the answer", async () => {
  const { deps, calls, out } = setup([
    [200, ASKED],
    [200, pending("dispatched")],
    [200, pending("claimed")],
    [200, ANSWERED],
  ]);

  const argv = ["ask", "How long is the line?", "--at", "37.7825,-122.4078", "--type", "line_length"];
  expect(await run([...argv, "--no-photo", "--idempotency-key", "line-check-1"], deps)).toBe(0);

  expect(calls).toHaveLength(4);
  expect(calls[0]).toMatchObject({
    url: "https://eyes.test/v1/tasks",
    method: "POST",
    auth: "Bearer eyes_env_key",
    body: {
      question: "How long is the line?",
      location: { lat: 37.7825, lng: -122.4078 },
      task_type: "line_length",
      require_photo: false,
      idempotency_key: "line-check-1",
    },
  });
  expect(calls[1]?.outSoFar).toContain(`task_id: ${TASK_ID}`);
  expect(calls[1]?.outSoFar).toContain("idempotency_key: line-check-1");
  for (const call of calls.slice(1)) {
    expect(call).toMatchObject({ url: `https://eyes.test/v1/tasks/${TASK_ID}/await`, method: "POST" });
  }
  expect(out).toContain("status: claimed");
  expect(out.join("\n")).toContain("answer.answer_text: About 4 people in line");
});

it("ask --json and signup --json print only JSON lines, the ask result first", async () => {
  const { deps, calls, out } = setup([
    [200, ASKED],
    [200, pending("dispatched")],
    [200, pending("claimed")],
    [200, ANSWERED],
    [200, SIGNED_UP],
  ]);

  expect(await run([...ASK, "--json"], deps)).toBe(0);
  const key = calls[0]?.body?.idempotency_key;
  expect(key).toMatch(/^[0-9a-f-]{36}$/);
  expect(out.map((line) => JSON.parse(line))).toEqual([
    { ...ASKED, idempotency_key: key },
    pending("claimed"),
    ANSWERED,
  ]);

  out.length = 0;
  expect(await run(["signup", "--name", "test-agent", "--json"], deps)).toBe(0);
  expect(out.map((line) => JSON.parse(line))).toEqual([SIGNED_UP]);
});

it.each(["expired", "refunded", "disputed"])("ask stops waiting on %s and exits 1", async (status) => {
  const { deps, calls } = setup([
    [200, ASKED],
    [200, pending(status)],
  ]);

  expect(await run(ASK, deps)).toBe(1);
  expect(calls).toHaveLength(2);
});

it("treats an await reply without a string status as an unexpected response instead of looping", async () => {
  const { deps, calls, err } = setup([
    [200, ASKED],
    [200, { task_id: TASK_ID }],
  ]);

  expect(await run(ASK, deps)).toBe(1);
  expect(calls).toHaveLength(2);
  expect(err[0]).toMatch(/^Error \(unexpected_response\)/);
  expect(err[1]).toContain(`eyes await ${TASK_ID}`);
});

it("await retries in place on rate_limited, internal_error and network errors, and stops on other errors", async () => {
  const retried = setup([
    [429, { error: "rate_limited", message: "Too many requests.", fix: "Wait 7 seconds.", retry_after_s: 7 }],
    [500, { error: "internal_error", message: "Something went wrong.", fix: "Retry." }],
    new TypeError("fetch failed"),
    [200, ANSWERED],
  ]);
  expect(await run(["await", TASK_ID], retried.deps)).toBe(0);
  expect(retried.calls).toHaveLength(4);
  expect(retried.sleeps).toEqual([7000, 1000, 2000]);

  const stopped = setup([
    [404, { error: "task_not_found", message: "No task.", fix: "Use the task_id from ask." }],
  ]);
  expect(await run(["await", TASK_ID, "--timeout", "20"], stopped.deps)).toBe(1);
  expect(stopped.calls).toHaveLength(1);
  expect(stopped.calls[0]?.body).toEqual({ timeout_seconds: 20 });
  expect(stopped.sleeps).toEqual([]);
});

it("Ctrl-C while waiting prints how to resume and exits 130", async () => {
  const { deps, err } = setup([]);
  const stop = new AbortController();
  const fetch = async () => {
    stop.abort();
    throw new DOMException("This operation was aborted", "AbortError");
  };

  expect(await run(["await", TASK_ID], { ...deps, fetch, signal: stop.signal })).toBe(130);
  expect(err[1]).toBe(`Fix: Resume with: eyes await ${TASK_ID}`);
});

it("prints the error message and fix from an error body, keeps the idempotency key, and exits 1", async () => {
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

  expect(await run([...ASK, "--idempotency-key", "k-1"], deps)).toBe(1);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.body?.location).toBe("Ferry Building, San Francisco");
  expect(err).toEqual([
    "Error (insufficient_balance): Your balance is too low to escrow this task.",
    "Fix: Ask your user to top up at https://eyes.test/topup/abc, or lower bounty_usd to 0.7 or less. When you retry, pass --idempotency-key k-1 so the task is never created twice.",
    "balance_usd: 1.2",
    "idempotency_key: k-1",
  ]);
});

it.each([
  ["network_error", [new TypeError("fetch failed")], KEYS, null],
  ["unexpected_response", [[502, "<html>Bad gateway</html>"]], KEYS, null],
  ["config_error", [], KEYS, "{not json"],
  ["config_error", [], {}, null],
] as [string, Reply[], Record<string, string>, string | null][])(
  "reports %s with a fix and exit 1",
  async (code, replies, env, config) => {
    const { deps, out } = setup(replies, env);
    if (config !== null) {
      mkdirSync(dirname(deps.configPath), { recursive: true });
      writeFileSync(deps.configPath, config);
    }

    expect(await run(["balance", "--json"], deps)).toBe(1);
    const body = JSON.parse(out[0] ?? "");
    expect(body.error).toBe(code);
    expect(body.fix.length).toBeGreaterThan(10);
  },
);

it.each([
  [
    ["ask", "How", "long", "is", "it", "--at", "Ferry Building", "--type", "is_open"],
    "extra arguments: long is it",
  ],
  [[...ASK, "--bounty", "abc"], "--bounty is invalid"],
  [[...ASK, "--bounty", "99"], "--bounty is invalid"],
  [[...ASK, "--deadline", "2.5"], "--deadline is invalid"],
  [["quote", "--type", "is_open"], "--at is required"],
  [["status", "not-a-task-id"], "<task_id> is invalid"],
  [["frobnicate"], 'Unknown command "frobnicate"'],
  [["balance", "--frobnicate"], "Unknown option"],
])("rejects %j locally with a fix", async (argv, message) => {
  const { deps, calls, err } = setup([]);

  expect(await run(argv, deps)).toBe(1);
  expect(calls).toHaveLength(0);
  expect(err[0]).toContain(message);
  expect(err[1]).toMatch(/^Fix: \S/);
});

it("help works without config, per command and as JSON", async () => {
  const { deps, out } = setup([], {});
  mkdirSync(dirname(deps.configPath), { recursive: true });
  writeFileSync(deps.configPath, "{not json");

  expect(await run(["ask", "--help"], deps)).toBe(0);
  expect(out[0]).toMatch(/^Usage: eyes ask "<question>"/);
  expect(await run(["help", "--json"], deps)).toBe(0);
  expect(JSON.parse(out[1] ?? "").commands.await.usage).toBe("eyes await <task_id> [--timeout 50]");
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
