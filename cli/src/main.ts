#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  AskEyesInput,
  AwaitAnswerInput,
  CancelTaskInput,
  DisputeAnswerInput,
  GetTaskInput,
  QuoteTaskInput,
  SignupInput,
  type SignupOutput,
  TASK_TYPES,
  type ToolOutput,
} from "@eyes/core";
import type { z } from "zod";

type Json = Record<string, unknown>;
type Config = { api_url?: string; api_key?: string };
export type Deps = {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  configPath: string;
  self: string;
  out: (line: string) => void;
  err: (line: string) => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<unknown>;
  now: () => number;
  signal?: AbortSignal;
};

const COMMANDS = {
  signup: {
    args: 0,
    usage: "signup --name <name> [--email <owner email>]",
    about:
      "Create an API key. Prints it once, then saves api_url and api_key to ~/.config/eyes/config.json (0600).",
  },
  ask: {
    args: 1,
    usage:
      'ask "<question>" --at "<place or lat,lng>" --type <task_type> [--bounty 3] [--deadline 30] [--no-photo] [--idempotency-key <key>] [--no-wait]',
    about:
      "Pay a nearby human to check a public place. Prints the idempotency_key before sending and the task_id once created, then waits for the answer. Re-running with the same --idempotency-key never charges twice.",
  },
  await: {
    args: 1,
    usage: "await <task_id> [--timeout <seconds per poll, max 55>]",
    about: "Wait until the task is answered, expired, refunded or disputed, then print the answer.",
  },
  quote: {
    args: 0,
    usage: 'quote --at "<place or lat,lng>" --type <task_type>',
    about: "Free check of coverage, time to answer and suggested bounty.",
  },
  status: {
    args: 1,
    usage: "status <task_id>",
    about: "Show a task's status, and its answer once there is one.",
  },
  cancel: {
    args: 1,
    usage: "cancel <task_id>",
    about: "Cancel a task no worker has claimed yet; full refund.",
  },
  dispute: {
    args: 1,
    usage: 'dispute <task_id> --reason "<what is wrong>"',
    about: "Hold the worker payout and flag the answer for human review.",
  },
  balance: { args: 0, usage: "balance", about: "Show your balance, escrow and top_up_url." },
  policy: { args: 0, usage: "policy", about: "Show this API key's spend limits." },
} as const;
type Command = keyof typeof COMMANDS;

const NOTES = `--json prints one JSON object per line. -h or --help after a command shows its usage. task_type: ${TASK_TYPES.join(", ")}. EYES_API_URL and EYES_API_KEY override ~/.config/eyes/config.json.`;

const FLAGS: Record<string, string> = {
  question: '"<question>"',
  location: "--at",
  task_type: "--type",
  bounty_usd: "--bounty",
  deadline_minutes: "--deadline",
  idempotency_key: "--idempotency-key",
  task_id: "<task_id>",
  timeout_seconds: "--timeout",
  reason: "--reason",
  name: "--name",
  owner_email: "--email",
};
const FINAL = ["expired", "refunded", "disputed"];
const GIVE_UP_MS = 10 * 60_000;

const fail = (message: string, fix: string, error = "invalid_input", context: Json = {}): never => {
  throw Object.assign(new Error(message), { body: { error, message, fix, ...context } });
};

function check(schema: z.ZodType, value: Json, usage: string) {
  const result = schema.safeParse(value);
  if (result.success) return;
  const problems = new Set(
    result.error.issues.map((issue) => {
      const key = String(issue.path[0] ?? "");
      return `${FLAGS[key] ?? key} ${value[key] === undefined ? "is required" : `is invalid (${issue.message})`}`;
    }),
  );
  fail(`Invalid arguments: ${[...problems].join("; ")}.`, `Correct them and retry. Usage: ${usage}`);
}

const num = (value: string | undefined) =>
  value === undefined ? undefined : /^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN;

const location = (at: string | undefined) => {
  const m = at?.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : at;
};

const lines = (value: Json, prefix = ""): string[] =>
  Object.entries(value).flatMap(([key, v]) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? lines(v as Json, `${prefix}${key}.`)
      : [`${prefix}${key}: ${typeof v === "object" ? JSON.stringify(v) : v}`],
  );

async function loadConfig(deps: Deps): Promise<Config> {
  let file: Config = {};
  try {
    file = JSON.parse(await readFile(deps.configPath, "utf8"));
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") {
      fail(
        `Could not read ${deps.configPath}: ${(e as Error).message}`,
        `Fix or delete ${deps.configPath}, or set EYES_API_URL and EYES_API_KEY.`,
        "config_error",
      );
    }
  }
  return {
    api_url: deps.env.EYES_API_URL || file?.api_url,
    api_key: deps.env.EYES_API_KEY || file?.api_key,
  };
}

async function saveConfig(path: string, config: Config) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function run(argv: string[], deps: Deps): Promise<number> {
  const { self } = deps;
  const json = argv.includes("--json");
  const print = (value: Json) => deps.out(json ? JSON.stringify(value) : lines(value).join("\n"));
  try {
    const { values: o, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        name: { type: "string" },
        email: { type: "string" },
        at: { type: "string" },
        type: { type: "string" },
        bounty: { type: "string" },
        deadline: { type: "string" },
        timeout: { type: "string" },
        reason: { type: "string" },
        "idempotency-key": { type: "string" },
        "no-photo": { type: "boolean" },
        "no-wait": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    const [first, ...args] = positionals;
    const topic = first === "help" ? args[0] : first;
    if (!first || first === "help" || o.help) {
      if (topic && topic in COMMANDS) {
        const usage = `${self} ${COMMANDS[topic as Command].usage}`;
        const { about } = COMMANDS[topic as Command];
        deps.out(
          json ? JSON.stringify({ command: topic, usage, about }) : `Usage: ${usage}\n\n${about}\n\n${NOTES}`,
        );
      } else {
        const commands = Object.fromEntries(
          Object.entries(COMMANDS).map(([name, c]) => [
            name,
            { usage: `${self} ${c.usage}`, about: c.about },
          ]),
        );
        deps.out(
          json
            ? JSON.stringify({ commands, notes: NOTES })
            : `Usage:\n${Object.values(commands)
                .map((c) => `  ${c.usage}`)
                .join("\n")}\n\n${NOTES}`,
        );
      }
      return 0;
    }
    if (!(first in COMMANDS)) {
      return fail(`Unknown command "${first}".`, `Run \`${self} help\` for the list of commands.`);
    }
    const cmd = first as Command;
    const usage = `${self} ${COMMANDS[cmd].usage}`;
    if (args.length > COMMANDS[cmd].args) {
      fail(
        `Unexpected extra arguments: ${args.slice(COMMANDS[cmd].args).join(" ")}.`,
        `Put values with spaces in quotes. Usage: ${usage}`,
      );
    }
    const [arg] = args;
    const config = await loadConfig(deps);

    const call = async <T = Json>(route: string, body?: Json): Promise<T> => {
      const [method, path] = route.split(" ");
      const base = config.api_url
        ? config.api_url.replace(/\/+$/, "")
        : fail(
            "No Eyes server configured.",
            `Set EYES_API_URL to the Eyes server's origin (where /llms.txt is served), then run \`${self} signup --name <name>\`.`,
            "config_error",
          );
      const url = `${base}${path}`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.api_key) headers.authorization = `Bearer ${config.api_key}`;
      let res: Response;
      try {
        res = await deps.fetch(url, {
          method,
          headers,
          body: body && JSON.stringify(body),
          signal: deps.signal,
        });
      } catch (e) {
        if (deps.signal?.aborted) {
          return fail("Stopped by Ctrl-C.", "Run the command again if you still need it.", "interrupted");
        }
        return fail(
          `Could not reach ${url}: ${(e as Error).message}`,
          "Check EYES_API_URL and your network, then retry.",
          "network_error",
        );
      }
      const data = (await res.json().catch(() => null)) as Json | null;
      if (res.ok && data && typeof data === "object") return data as T;
      const error =
        !res.ok && typeof data?.error === "string" && typeof data.fix === "string"
          ? data
          : {
              error: "unexpected_response",
              message: `Unexpected HTTP ${res.status} reply from ${url}.`,
              fix: "Check that EYES_API_URL is the Eyes server's origin, then retry.",
            };
      throw Object.assign(new Error(String(error.message)), { body: error, status: res.status });
    };

    const waitFor = async (taskId: string, timeout: number | undefined, last: string, key?: string) => {
      try {
        let failingSince: number | null = null;
        let attempt = 0;
        for (;;) {
          let reply: Json;
          try {
            reply = await call(
              `POST /v1/tasks/${taskId}/await`,
              timeout === undefined ? {} : { timeout_seconds: timeout },
            );
          } catch (e) {
            const { body, status = 0 } = e as { body?: Json; status?: number };
            const retry = body?.error === "rate_limited" || body?.error === "network_error" || status >= 500;
            failingSince ??= deps.now();
            if (!retry || deps.now() - failingSince >= GIVE_UP_MS) throw e;
            const seconds =
              typeof body?.retry_after_s === "number" ? body.retry_after_s : Math.min(2 ** attempt++, 30);
            deps.err(
              json
                ? JSON.stringify({ retrying_in_s: seconds, error: body?.error, message: body?.message })
                : `${body?.message} Retrying in ${seconds}s.`,
            );
            await deps.sleep(seconds * 1000, deps.signal).catch(() => undefined);
            if (deps.signal?.aborted) fail("Stopped by Ctrl-C.", "The task keeps running.", "interrupted");
            continue;
          }
          failingSince = null;
          attempt = 0;
          const status = reply.status;
          if (typeof status !== "string") {
            return fail(
              "Unexpected reply from the await endpoint: it has no status.",
              "Check that EYES_API_URL is the Eyes server's origin.",
              "unexpected_response",
            );
          }
          const done = reply.answered === true || FINAL.includes(status);
          if (json && (status !== last || done)) deps.out(JSON.stringify(reply));
          if (!json && status !== last) deps.out(`status: ${status}`);
          if (done) {
            if (!json) deps.out(lines(reply).join("\n"));
            return reply.answered === true ? 0 : 1;
          }
          last = status;
        }
      } catch (e) {
        const body = (e as { body?: Json }).body;
        if (body) {
          Object.assign(body, {
            task_id: taskId,
            ...(key ? { idempotency_key: key } : {}),
            fix: `${body.fix} The task is not lost; resume with: ${self} await ${taskId}`,
          });
        }
        throw e;
      }
    };

    switch (cmd) {
      case "signup": {
        const input = { name: o.name, owner_email: o.email };
        check(SignupInput, input, usage);
        const out = await call<SignupOutput>("POST /v1/signup", input);
        print(out);
        try {
          await saveConfig(deps.configPath, { api_url: config.api_url, api_key: out.api_key });
        } catch (e) {
          return fail(
            `Could not save ${deps.configPath}: ${(e as Error).message}`,
            `Store the api_key printed above now; it is shown only once. Then set EYES_API_URL=${config.api_url} and EYES_API_KEY=<api_key> in your environment.`,
            "config_error",
          );
        }
        if (!json) deps.out(`Saved api_url and api_key to ${deps.configPath}`);
        return 0;
      }
      case "ask": {
        const key = o["idempotency-key"] ?? crypto.randomUUID();
        const input = {
          question: arg,
          location: location(o.at),
          task_type: o.type,
          bounty_usd: num(o.bounty),
          deadline_minutes: num(o.deadline),
          require_photo: o["no-photo"] ? false : undefined,
          idempotency_key: key,
        };
        check(AskEyesInput, input, usage);
        deps.err(JSON.stringify({ idempotency_key: key }));
        let task: ToolOutput<"ask_eyes">;
        try {
          task = await call<ToolOutput<"ask_eyes">>("POST /v1/tasks", input);
        } catch (e) {
          const body = (e as { body?: Json }).body;
          if (body) {
            Object.assign(body, {
              idempotency_key: key,
              fix: `${body.fix} When you retry, pass --idempotency-key ${key} so the task is never created twice.`,
            });
          }
          throw e;
        }
        print({ ...task, idempotency_key: key });
        if (o["no-wait"]) return 0;
        if (!json)
          deps.out(
            `Waiting for the answer. Ctrl-C stops waiting; resume with: ${self} await ${task.task_id}`,
          );
        return await waitFor(task.task_id, undefined, task.status, key);
      }
      case "await": {
        const input = { task_id: arg, timeout_seconds: num(o.timeout) };
        check(AwaitAnswerInput, input, usage);
        return await waitFor(input.task_id as string, input.timeout_seconds, "");
      }
      case "quote": {
        const input = { location: location(o.at), task_type: o.type };
        check(QuoteTaskInput, input, usage);
        print(await call("POST /v1/quote", input));
        return 0;
      }
      case "status":
        check(GetTaskInput, { task_id: arg }, usage);
        print(await call(`GET /v1/tasks/${arg}`));
        return 0;
      case "cancel":
        check(CancelTaskInput, { task_id: arg }, usage);
        print(await call(`POST /v1/tasks/${arg}/cancel`));
        return 0;
      case "dispute":
        check(DisputeAnswerInput, { task_id: arg, reason: o.reason }, usage);
        print(await call(`POST /v1/tasks/${arg}/dispute`, { reason: o.reason }));
        return 0;
      case "balance":
        print(await call("GET /v1/balance"));
        return 0;
      case "policy":
        print(await call("GET /v1/spend-policy"));
        return 0;
    }
  } catch (e) {
    const body = (e as { body?: Json }).body;
    if (!body && !(e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) throw e;
    const shown = body ?? {
      error: "invalid_input",
      message: (e as Error).message,
      fix: `Run \`${self} help\` for usage.`,
    };
    if (json) {
      deps.out(JSON.stringify(shown));
    } else {
      const { error, message, fix, ...context } = shown;
      deps.err(`Error (${error}): ${message}`);
      deps.err(`Fix: ${fix}`);
      for (const line of lines(context)) deps.err(line);
    }
    return shown.error === "interrupted" ? 130 : 1;
  }
}

if (import.meta.main) {
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  const script = process.argv[1] ?? "cli/src/main.ts";
  process.exitCode = await run(process.argv.slice(2), {
    fetch,
    env: process.env,
    configPath: join(homedir(), ".config", "eyes", "config.json"),
    self: `node ${/\s/.test(script) ? JSON.stringify(script) : script}`,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    sleep: (ms, signal) => delay(ms, undefined, { signal }),
    now: Date.now,
    signal: stop.signal,
  });
}
