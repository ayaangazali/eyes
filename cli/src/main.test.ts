import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { type Deps, run } from "./main.ts";

const TASK_ID = "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b";
const OTHER_TASK_ID = "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
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
const SERVER_ERROR = { error: "internal_error", message: "Something went wrong.", fix: "Retry." };

type Reply = [number, unknown] | Error;

function setup(replies: Reply[], env: Record<string, string> = KEYS) {
  const calls: {
    url: string;
    method?: string;
    auth?: string;
    body?: Record<string, unknown>;
    outSoFar: string;
    errSoFar: string;
  }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const deps: Deps = {
    fetch: async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        method: init?.method,
        auth: headers.authorization,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        outSoFar: out.join("\n"),
        errSoFar: err.join("\n"),
      });
      const reply = replies.shift() ?? [400, { unexpected: "call" }];
      if (reply instanceof Error) throw reply;
      const [status, body] = reply;
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    },
    env,
    configPath: join(mkdtempSync(join(tmpdir(), "eyes-cli-")), "eyes", "config.json"),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, calls, out, err, sleeps };
}

const abortingFetch = (stop: AbortController) => async () => {
  stop.abort();
  throw new DOMException("This operation was aborted", "AbortError");
};

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

it("ask prints the key before sending and the task before waiting, loops await, and prints the answer once", async () => {
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
  expect(calls[0]?.errSoFar).toBe('{"idempotency_key":"line-check-1"}');
  expect(calls[1]?.outSoFar).toContain(`task_id: ${TASK_ID}`);
  expect(calls[1]?.outSoFar).toContain("idempotency_key: line-check-1");
  for (const call of calls.slice(1)) {
    expect(call).toMatchObject({ url: `https://eyes.test/v1/tasks/${TASK_ID}/await`, method: "POST" });
  }
  expect(out).toContain("status: claimed");
  expect(out.join("\n")).toContain("answer.answer_text: About 4 people in line");
  expect(out.join("\n").match(/status: verified/g)).toHaveLength(1);
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

it("re-running an ask reuses its key while the task is open, gets a new key once it settles, and --idempotency-key wins", async () => {
  const { deps, calls } = setup([
    [200, ASKED],
    [200, pending("claimed")],
    [200, ASKED],
    [200, pending("expired")],
    [200, { ...ASKED, task_id: OTHER_TASK_ID }],
    [200, { ...ASKED, task_id: OTHER_TASK_ID }],
  ]);
  const noWait = [...ASK, "--no-wait"];

  expect(await run(noWait, deps)).toBe(0);
  const first = calls[0]?.body?.idempotency_key;
  const pendingDir = join(dirname(deps.configPath), "pending-asks");
  const files = readdirSync(pendingDir);
  expect(files).toHaveLength(1);
  expect(statSync(pendingDir).mode & 0o777).toBe(0o700);
  expect(statSync(join(pendingDir, files[0] ?? "")).mode & 0o777).toBe(0o600);

  expect(await run(noWait, deps)).toBe(0);
  expect(calls[1]).toMatchObject({ method: "GET", url: `https://eyes.test/v1/tasks/${TASK_ID}` });
  expect(calls[2]?.body?.idempotency_key).toBe(first);

  expect(await run(noWait, deps)).toBe(0);
  expect(calls[3]).toMatchObject({ method: "GET", url: `https://eyes.test/v1/tasks/${TASK_ID}` });
  expect(calls[4]?.body?.idempotency_key).not.toBe(first);

  expect(await run([...noWait, "--idempotency-key", "mine"], deps)).toBe(0);
  expect(calls).toHaveLength(6);
  expect(calls[5]?.body?.idempotency_key).toBe("mine");
});

it("tasks sends --status and --limit as query parameters and checks the limit before calling", async () => {
  const listed = { tasks: [], next_step: "Call ask_eyes." };
  const { deps, calls } = setup([
    [200, listed],
    [200, listed],
  ]);
  expect(await run(["tasks", "--status", "dispatched", "--limit", "5"], deps)).toBe(0);
  expect(await run(["tasks"], deps)).toBe(0);
  expect(await run(["tasks", "--limit", "51"], deps)).toBe(1);
  expect(calls.map((c) => [c.method, c.url])).toEqual([
    ["GET", "https://eyes.test/v1/tasks?status=dispatched&limit=5"],
    ["GET", "https://eyes.test/v1/tasks"],
  ]);
});

it("status lookup 5xx keeps the key", async () => {
  const { deps, calls } = setup([
    [200, ASKED],
    [500, SERVER_ERROR],
    [200, ASKED],
  ]);

  expect(await run([...ASK, "--no-wait"], deps)).toBe(0);
  expect(await run([...ASK, "--no-wait"], deps)).toBe(0);

  expect(calls[1]).toMatchObject({ method: "GET", url: `https://eyes.test/v1/tasks/${TASK_ID}` });
  expect(calls[2]?.body?.idempotency_key).toBe(calls[0]?.body?.idempotency_key);
});

it("empty winner file is retried", async () => {
  const { deps, calls } = setup([
    [200, ASKED],
    [200, ASKED],
  ]);
  expect(await run([...ASK, "--no-wait"], deps)).toBe(0);
  const dir = join(dirname(deps.configPath), "pending-asks");
  const file = join(dir, readdirSync(dir)[0] ?? "");
  writeFileSync(file, "");
  setTimeout(() => writeFileSync(file, JSON.stringify({ idempotency_key: "winner-key", task_id: null })), 50);

  expect(await run([...ASK, "--no-wait"], deps)).toBe(0);

  expect(calls).toHaveLength(2);
  expect(calls[1]?.body?.idempotency_key).toBe("winner-key");
});

it.each([
  ["", "Nothing was sent. Delete"],
  ['{"idempotency_key"', "Pass --idempotency-key"],
])("a pending file holding %j stops the ask with a fix that says how to recover", async (content, fix) => {
  const { deps, calls, out } = setup([[200, ASKED]]);
  expect(await run([...ASK, "--no-wait"], deps)).toBe(0);
  const dir = join(dirname(deps.configPath), "pending-asks");
  const file = join(dir, readdirSync(dir)[0] ?? "");
  writeFileSync(file, content);

  expect(await run([...ASK, "--no-wait", "--json"], deps)).toBe(1);

  expect(calls).toHaveLength(1);
  const error = JSON.parse(out.at(-1) ?? "");
  expect(error.error).toBe("config_error");
  expect(error.fix).toContain(fix);
  if (content === "") expect(error.fix).toBe(`Nothing was sent. Delete ${file} and re-run.`);
});

it("an ask killed mid-request is re-sent with the same key on the next identical run", async () => {
  const { deps, calls, err } = setup([[200, ASKED]]);
  const stop = new AbortController();

  expect(await run([...ASK, "--no-wait"], { ...deps, fetch: abortingFetch(stop), signal: stop.signal })).toBe(
    130,
  );
  const { idempotency_key } = JSON.parse(err[0] ?? "");
  expect(err[2]).toContain(`re-run this exact command, which reuses idempotency_key ${idempotency_key}`);

  expect(await run([...ASK, "--no-wait"], deps)).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body?.idempotency_key).toBe(idempotency_key);
});

function fakeServer() {
  const keys: Record<string, string[]> = {};
  const tasks = new Map<string, string>();
  const expired = new Set<string>();
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (init?.method === "POST" && String(url).endsWith("/v1/tasks")) {
      const body = JSON.parse(String(init.body));
      keys[body.question] = [...(keys[body.question] ?? []), body.idempotency_key];
      const taskId = tasks.get(body.idempotency_key) ?? randomUUID();
      tasks.set(body.idempotency_key, taskId);
      return Response.json({ ...ASKED, task_id: taskId });
    }
    return Response.json(
      pending(expired.has(String(url).split("/").at(-1) ?? "") ? "expired" : "dispatched"),
    );
  };
  const expireAll = () => {
    for (const taskId of tasks.values()) expired.add(taskId);
  };
  return { fetch, keys, expireAll };
}

it("two different asks started together on one config dir each keep their own key across re-runs", async () => {
  const { deps } = setup([]);
  const server = fakeServer();
  const other = [
    "ask",
    "Is the bakery open right now?",
    "--at",
    "Ferry Building, San Francisco",
    "--type",
    "is_open",
  ];
  const both = () =>
    Promise.all([
      run([...ASK, "--no-wait"], { ...deps, fetch: server.fetch }),
      run([...other, "--no-wait"], { ...deps, fetch: server.fetch }),
    ]);

  expect(await both()).toEqual([0, 0]);
  expect(await both()).toEqual([0, 0]);

  const lineKeys = server.keys["How long is the line?"] ?? [];
  const bakeryKeys = server.keys["Is the bakery open right now?"] ?? [];
  expect(lineKeys).toHaveLength(2);
  expect(bakeryKeys).toHaveLength(2);
  expect(new Set(lineKeys).size).toBe(1);
  expect(new Set(bakeryKeys).size).toBe(1);
  expect(lineKeys[0]).not.toBe(bakeryKeys[0]);
});

it("same question with a different bounty gets a different key", async () => {
  const { deps } = setup([]);
  const server = fakeServer();

  expect(await run([...ASK, "--no-wait"], { ...deps, fetch: server.fetch })).toBe(0);
  expect(await run([...ASK, "--bounty", "5", "--no-wait"], { ...deps, fetch: server.fetch })).toBe(0);

  const keys = server.keys["How long is the line?"] ?? [];
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
});

it("two identical asks started at the same instant send the same key", async () => {
  const { deps } = setup([]);
  const server = fakeServer();

  const codes = await Promise.all(
    [1, 2, 3].map(() => run([...ASK, "--no-wait"], { ...deps, fetch: server.fetch })),
  );

  expect(codes).toEqual([0, 0, 0]);
  const keys = server.keys["How long is the line?"] ?? [];
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
});

it("identical re-runs at the same instant after the task settled agree on one new key", async () => {
  const { deps } = setup([]);
  const server = fakeServer();
  const ask = () => run([...ASK, "--no-wait"], { ...deps, fetch: server.fetch });

  expect(await ask()).toBe(0);
  server.expireAll();
  expect(await Promise.all([ask(), ask(), ask()])).toEqual([0, 0, 0]);

  const [first, ...rerun] = server.keys["How long is the line?"] ?? [];
  expect(rerun).toHaveLength(3);
  expect(new Set(rerun).size).toBe(1);
  expect(rerun[0]).not.toBe(first);
});

it.each(["GET", "POST"])(
  "a %s reply that arrives after the chain moved on never sends a later ask back to a settled task",
  async (method) => {
    const { deps } = setup([]);
    const server = fakeServer();
    const ask = (fetch = server.fetch) => run([...ASK, "--no-wait"], { ...deps, fetch });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const holding = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let first = true;
    const lateFetch: typeof fetch = async (url, init) => {
      const res = await server.fetch(url, init);
      if (first && init?.method === method) {
        first = false;
        reached();
        await held;
      }
      return res;
    };

    expect(await ask()).toBe(0);
    server.expireAll();
    const late = ask(lateFetch);
    await holding;
    expect(await ask()).toBe(0);
    server.expireAll();
    expect(await ask()).toBe(0);
    server.expireAll();
    expect(await ask()).toBe(0);
    const keys = () => server.keys["How long is the line?"] ?? [];
    const open = keys().at(-1);
    const sent = keys().length;
    expect(new Set(keys()).size).toBe(4);

    release();
    expect(await late).toBe(0);
    expect(await ask()).toBe(0);

    expect(new Set(keys().slice(sent))).toEqual(new Set([open]));
  },
);

it("after waiting to a final status, the next identical ask looks the task up and gets a new key", async () => {
  const { deps, calls } = setup([
    [200, ASKED],
    [200, ANSWERED],
    [200, ANSWERED],
    [200, { ...ASKED, task_id: OTHER_TASK_ID }],
  ]);

  expect(await run(ASK, deps)).toBe(0);
  expect(await run([...ASK, "--no-wait"], deps)).toBe(0);

  expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "GET", "POST"]);
  expect(calls[2]?.url).toBe(`https://eyes.test/v1/tasks/${TASK_ID}`);
  expect(calls[3]?.body?.idempotency_key).not.toBe(calls[0]?.body?.idempotency_key);
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
  expect(err[1]).toMatch(/^Error \(unexpected_response\)/);
  expect(err[2]).toContain(`resume with: eyes await ${TASK_ID}`);
});

it("await retries in place on rate_limited, 5xx and network errors, and stops on permanent errors without a resume line", async () => {
  const retried = setup([
    [429, { error: "rate_limited", message: "Too many requests.", fix: "Wait 7 seconds.", retry_after_s: 7 }],
    [500, SERVER_ERROR],
    new TypeError("fetch failed"),
    [200, ANSWERED],
  ]);
  expect(await run(["await", TASK_ID], retried.deps)).toBe(0);
  expect(retried.calls).toHaveLength(4);
  expect(retried.sleeps).toEqual([7000, 1000, 2000]);

  const stopped = setup([
    [404, { error: "task_not_found", message: "No task.", fix: "Use the task_id from ask." }],
  ]);
  expect(await run(["await", TASK_ID, "--timeout", "20", "--json"], stopped.deps)).toBe(1);
  expect(stopped.calls).toHaveLength(1);
  expect(stopped.calls[0]?.body).toEqual({ timeout_seconds: 20 });
  expect(stopped.sleeps).toEqual([]);
  expect(JSON.parse(stopped.out[0] ?? "")).toMatchObject({
    error: "task_not_found",
    task_id: TASK_ID,
    fix: "Use the task_id from ask.",
  });
});

it("a successful poll resets the backoff and the 10-minute failure window", async () => {
  const failures = (n: number) => Array.from({ length: n }, (): Reply => [500, SERVER_ERROR]);
  const { deps, sleeps } = setup([
    ...failures(22),
    [200, pending("claimed")],
    ...failures(22),
    [200, ANSWERED],
  ]);

  expect(await run(["await", TASK_ID], deps)).toBe(0);
  expect(sleeps).toHaveLength(44);
  expect(sleeps[22]).toBe(1000);
  expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThan(600_000);
});

it("a gateway 504 with an HTML body while waiting is retried, so the task is asked once and answered", async () => {
  const { deps, calls, sleeps } = setup([
    [200, ASKED],
    [504, "<html>Gateway Timeout</html>"],
    [200, ANSWERED],
  ]);

  expect(await run(ASK, deps)).toBe(0);
  expect(calls.filter((call) => call.url.endsWith("/v1/tasks"))).toHaveLength(1);
  expect(calls).toHaveLength(3);
  expect(sleeps).toEqual([1000]);
});

it.each([
  ["network_error", new TypeError("fetch failed"), "fetch failed. Gave up after 10 minutes of retries."],
  ["unexpected_response", [503, "<html>busy</html>"], "The server is temporarily failing (HTTP 503)"],
] as [string, Reply, string][])(
  "gives up after 10 minutes of %s with task_id, idempotency_key and the resume command",
  async (code, failure, message) => {
    const { deps, out, sleeps } = setup([[200, ASKED], ...Array.from({ length: 40 }, () => failure)]);

    expect(await run([...ASK, "--idempotency-key", "k-2", "--json"], deps)).toBe(1);

    const total = sleeps.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(600_000);
    expect(total).toBeLessThan(640_000);
    const error = JSON.parse(out.at(-1) ?? "");
    expect(error).toMatchObject({ error: code, task_id: TASK_ID, idempotency_key: "k-2" });
    expect(error.message).toContain(message);
    expect(error.fix).toContain(`resume with: eyes await ${TASK_ID}`);
  },
);

it("Ctrl-C while waiting says how to resume, never to run the command again, and exits 130", async () => {
  const { deps, err } = setup([]);
  const stop = new AbortController();

  expect(await run(["await", TASK_ID], { ...deps, fetch: abortingFetch(stop), signal: stop.signal })).toBe(
    130,
  );
  expect(err).toEqual([
    "Error (interrupted): Stopped by Ctrl-C.",
    `Fix: The task keeps running; resume with: eyes await ${TASK_ID}`,
    `task_id: ${TASK_ID}`,
  ]);
});

it("Ctrl-C during the ask request exits 130 with the idempotency key to retry with", async () => {
  const { deps, out } = setup([]);
  const stop = new AbortController();

  const code = await run([...ASK, "--idempotency-key", "k-3", "--json"], {
    ...deps,
    fetch: abortingFetch(stop),
    signal: stop.signal,
  });

  expect(code).toBe(130);
  const error = JSON.parse(out[0] ?? "");
  expect(error).toMatchObject({ error: "interrupted", idempotency_key: "k-3" });
  expect(error.fix).toContain("--idempotency-key k-3");
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
    '{"idempotency_key":"k-1"}',
    "Error (insufficient_balance): Your balance is too low to escrow this task.",
    "Fix: Ask your user to top up at https://eyes.test/topup/abc, or lower bounty_usd to 0.7 or less. To retry, pass --idempotency-key k-1 again, so the task is never created twice.",
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
  [[...ASK, "--bounty", "0x10"], "--bounty is invalid"],
  [[...ASK, "--bounty", "1e1"], "--bounty is invalid"],
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
  expect(JSON.parse(out[1] ?? "").commands.await.usage).toBe(
    "eyes await <task_id> [--timeout <seconds per poll, max 55>]",
  );
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

it("help <topic> --json, help <topic>, and plain help all print their shapes", async () => {
  const { deps, out } = setup([], {});
  expect(await run(["help", "cancel", "--json"], deps)).toBe(0);
  expect(JSON.parse(out[0] ?? "")).toMatchObject({ command: "cancel" });
  expect(await run(["help", "cancel"], deps)).toBe(0);
  expect(out[1]).toMatch(/^Usage: /);
  expect(await run(["help"], deps)).toBe(0);
  expect(out[2]).toMatch(/^Usage:\n/);
});

it("a config file holding JSON null counts as empty, so env keys still work", async () => {
  const { deps, calls } = setup([[200, { balance_usd: 1 }]]);
  mkdirSync(dirname(deps.configPath), { recursive: true });
  writeFileSync(deps.configPath, "null");
  expect(await run(["balance"], deps)).toBe(0);
  expect(calls[0]?.auth).toBe("Bearer eyes_env_key");
});

it("cancel posts to its route; a malformed task id is rejected before any call", async () => {
  const { deps, calls, out } = setup([[200, { task_id: TASK_ID, status: "cancelled" }]]);
  expect(await run(["cancel", TASK_ID, "--json"], deps)).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: "POST", url: `https://eyes.test/v1/tasks/${TASK_ID}/cancel` });
  expect(JSON.parse(out[0] ?? "")).toMatchObject({ status: "cancelled" });
  expect(await run(["cancel", "not-a-task", "--json"], deps)).toBe(1);
  expect(calls).toHaveLength(1);
  expect(JSON.parse(out[1] ?? "")).toMatchObject({ error: "invalid_input" });
});

it("dispute posts its reason to the dispute route", async () => {
  const { deps, calls } = setup([[200, { task_id: TASK_ID, status: "disputed" }]]);
  expect(await run(["dispute", TASK_ID, "--reason", "Photo shows a different line."], deps)).toBe(0);
  expect(calls[0]).toMatchObject({
    method: "POST",
    url: `https://eyes.test/v1/tasks/${TASK_ID}/dispute`,
    body: { reason: "Photo shows a different line." },
  });
});

it("quote and status send their requests and return 0", async () => {
  const { deps, calls } = setup([
    [200, { quote: 3.5 }],
    [200, { task_id: TASK_ID, status: "verified" }],
  ]);
  expect(await run(["quote", "--at", "37.7607,-122.3857", "--type", "line_length"], deps)).toBe(0);
  expect(calls[0]).toMatchObject({
    method: "POST",
    url: "https://eyes.test/v1/quote",
    body: { location: { lat: 37.7607, lng: -122.3857 }, task_type: "line_length" },
  });
  expect(await run(["status", TASK_ID], deps)).toBe(0);
  expect(calls[1]).toMatchObject({ method: "GET", url: `https://eyes.test/v1/tasks/${TASK_ID}` });
});

it("ask stops before sending when the pending-asks path is blocked, and says nothing was sent", async () => {
  const { deps, calls, out } = setup([]);
  mkdirSync(dirname(deps.configPath), { recursive: true });
  writeFileSync(join(dirname(deps.configPath), "pending-asks"), "not a directory");
  expect(await run([...ASK, "--json"], deps)).toBe(1);
  expect(calls).toHaveLength(0);
  expect(JSON.parse(out[0] ?? "")).toMatchObject({ error: "config_error" });
  expect(JSON.parse(out[0] ?? "").fix).toContain("Nothing was sent");
});

it("await exits 130 with a resume hint when Ctrl-C lands during a retry wait", async () => {
  const stop = new AbortController();
  const { deps, err } = setup([[503, SERVER_ERROR]]);
  deps.signal = stop.signal;
  deps.sleep = async () => {
    stop.abort();
  };
  expect(await run(["await", TASK_ID], deps)).toBe(130);
  expect(err.join("\n")).toContain("Error (interrupted): Stopped by Ctrl-C.");
  expect(err.join("\n")).toContain(`resume with: eyes await ${TASK_ID}`);
});

it("an unexpected internal error is rethrown, not dressed up as a CLI error", async () => {
  const { deps } = setup([[200, { balance_usd: 1 }]]);
  deps.out = () => {
    throw new Error("stdout closed");
  };
  await expect(run(["balance"], deps)).rejects.toThrow("stdout closed");
});

it("an ask whose pending file is a dangling symlink stops with a fix instead of spinning", async () => {
  const { deps, calls, err } = setup([new TypeError("offline")]);
  expect(await run(ASK, deps)).toBe(1);
  const dir = join(dirname(deps.configPath), "pending-asks");
  const file = join(dir, readdirSync(dir)[0] ?? "");
  const before = calls.length;
  rmSync(file);
  symlinkSync(join(dir, "nowhere"), file);
  expect(await run(ASK, deps)).toBe(1);
  expect(calls.length).toBe(before);
  expect(err.join("\n")).toContain("exists but cannot be read");
  expect(err.join("\n")).toContain("Nothing was sent");
});

it("an ask whose pending file is unreadable stops before sending and says why", async () => {
  const { deps, calls, err } = setup([new TypeError("offline")]);
  expect(await run(ASK, deps)).toBe(1);
  const dir = join(dirname(deps.configPath), "pending-asks");
  const file = join(dir, readdirSync(dir)[0] ?? "");
  const before = calls.length;
  chmodSync(file, 0o000);
  try {
    expect(await run(ASK, deps)).toBe(1);
  } finally {
    chmodSync(file, 0o600);
  }
  expect(calls.length).toBe(before);
  expect(err.join("\n")).toContain("Could not save");
  expect(err.join("\n")).toContain("Nothing was sent");
});

it("an ask that creates the task still reports it when the pending record cannot be updated", async () => {
  const { deps, out } = setup([]);
  const dir = join(dirname(deps.configPath), "pending-asks");
  deps.fetch = async () => {
    chmodSync(dir, 0o500);
    return new Response(JSON.stringify(ASKED), { status: 200 });
  };
  try {
    expect(await run([...ASK, "--no-wait", "--json"], deps)).toBe(0);
  } finally {
    chmodSync(dir, 0o700);
  }
  expect(JSON.parse(out[0] ?? "").task_id).toBe(TASK_ID);
});

it("a retry wait that rejects on Ctrl-C still stops with exit 130", async () => {
  const stop = new AbortController();
  const { deps, err } = setup([[503, SERVER_ERROR]]);
  deps.signal = stop.signal;
  deps.sleep = async () => {
    stop.abort();
    throw new DOMException("This operation was aborted", "AbortError");
  };
  expect(await run(["await", TASK_ID], deps)).toBe(130);
  expect(err.join("\n")).toContain("Stopped by Ctrl-C.");
});
