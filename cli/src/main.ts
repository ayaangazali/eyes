#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { type SignupOutput, TASK_TYPES, type ToolOutput } from "@eyes/core";

type Json = Record<string, unknown>;
type Config = { api_url?: string; api_key?: string };
export type Deps = {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  configPath: string;
  out: (line: string) => void;
  err: (line: string) => void;
};

const USAGE = `Usage: eyes <command> [options]

  signup --name <name> [--email <owner email>]
  ask "<question>" --at "<place or lat,lng>" --type <task_type> [--bounty 3] [--deadline 30] [--no-wait]
  quote --at "<place or lat,lng>" --type <task_type>
  status <task_id>
  cancel <task_id>
  dispute <task_id> --reason "<what is wrong>"
  balance
  policy

--json prints raw JSON. task_type: ${TASK_TYPES.join(", ")}.
EYES_API_URL and EYES_API_KEY override ~/.config/eyes/config.json; signup saves both there.`;

const FINAL = ["expired", "refunded", "disputed"];

const fail = (message: string, fix: string, error = "invalid_input"): never => {
  throw Object.assign(new Error(message), { body: { error, message, fix } });
};

const need = (value: string | undefined, what: string): string =>
  value || fail(`Missing ${what}.`, `Pass ${what}. Run \`eyes help\` for usage.`);

const location = (at: string) => {
  const m = at.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : at;
};

const lines = (value: Json, prefix = ""): string[] =>
  Object.entries(value).flatMap(([key, v]) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? lines(v as Json, `${prefix}${key}.`)
      : [`${prefix}${key}: ${typeof v === "object" ? JSON.stringify(v) : v}`],
  );

async function readConfig(path: string): Promise<Config> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return {};
    return fail(
      `Could not read ${path}.`,
      `Delete ${path} and run \`eyes signup\` again, or set EYES_API_URL and EYES_API_KEY.`,
    );
  }
}

async function saveConfig(path: string, config: Config) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function run(argv: string[], deps: Deps): Promise<number> {
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
        reason: { type: "string" },
        "no-wait": { type: "boolean" },
        json: { type: "boolean" },
      },
    });
    const [cmd, arg] = positionals;
    const taskPath = () => `/v1/tasks/${encodeURIComponent(need(arg, "<task_id>"))}`;
    const config: Config = { ...(await readConfig(deps.configPath)) };
    if (deps.env.EYES_API_URL) config.api_url = deps.env.EYES_API_URL;
    if (deps.env.EYES_API_KEY) config.api_key = deps.env.EYES_API_KEY;

    const call = async <T = Json>(route: string, body?: Json): Promise<T> => {
      const [method, path] = route.split(" ");
      const base = config.api_url
        ? config.api_url.replace(/\/+$/, "")
        : fail(
            "No Eyes server configured.",
            "Set EYES_API_URL to the Eyes server's origin (where /llms.txt is served), then run `eyes signup --name <name>`.",
          );
      const url = `${base}${path}`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.api_key) headers.authorization = `Bearer ${config.api_key}`;
      let res: Response;
      try {
        res = await deps.fetch(url, { method, headers, body: body && JSON.stringify(body) });
      } catch (e) {
        return fail(
          `Could not reach ${url}: ${(e as Error).message}`,
          "Check EYES_API_URL and your network, then retry.",
          "internal_error",
        );
      }
      const data = (await res.json().catch(() => null)) as Json | null;
      if (res.ok && data) return data as T;
      if (data && typeof data.error === "string" && typeof data.fix === "string") {
        throw Object.assign(new Error(String(data.message)), { body: data });
      }
      return fail(
        `Unexpected HTTP ${res.status} from ${url}.`,
        "Check that EYES_API_URL is the Eyes server's origin, then retry.",
        "internal_error",
      );
    };

    switch (cmd) {
      case "signup": {
        const out = await call<SignupOutput>("POST /v1/signup", {
          name: need(o.name, "--name"),
          owner_email: o.email,
        });
        await saveConfig(deps.configPath, { api_url: config.api_url, api_key: out.api_key });
        print(out);
        if (!json) deps.out(`Saved api_url and api_key to ${deps.configPath}`);
        return 0;
      }
      case "quote":
        print(
          await call("POST /v1/quote", {
            location: location(need(o.at, "--at")),
            task_type: need(o.type, "--type"),
          }),
        );
        return 0;
      case "ask": {
        const task = await call<ToolOutput<"ask_eyes">>("POST /v1/tasks", {
          question: need(arg, "the question"),
          location: location(need(o.at, "--at")),
          task_type: need(o.type, "--type"),
          bounty_usd: o.bounty === undefined ? undefined : Number(o.bounty),
          deadline_minutes: o.deadline === undefined ? undefined : Number(o.deadline),
          idempotency_key: crypto.randomUUID(),
        });
        if (o["no-wait"]) {
          print(task);
          return 0;
        }
        if (!json) deps.out(lines(task).join("\n"));
        let status = task.status as string;
        for (;;) {
          const result = await call<ToolOutput<"await_answer">>(`POST /v1/tasks/${task.task_id}/await`, {});
          if (!json && result.status !== status) deps.out(`status: ${result.status}`);
          status = result.status;
          if (result.answered || FINAL.includes(status)) {
            print(result);
            return result.answered ? 0 : 1;
          }
        }
      }
      case "status":
        print(await call(`GET ${taskPath()}`));
        return 0;
      case "cancel":
        print(await call(`POST ${taskPath()}/cancel`));
        return 0;
      case "dispute":
        print(
          await call(`POST ${taskPath()}/dispute`, {
            reason: need(o.reason, "--reason"),
          }),
        );
        return 0;
      case "balance":
        print(await call("GET /v1/balance"));
        return 0;
      case "policy":
        print(await call("GET /v1/spend-policy"));
        return 0;
      case undefined:
      case "help":
        deps.out(USAGE);
        return 0;
      default:
        return fail(`Unknown command "${cmd}".`, "Run `eyes help` for the list of commands.");
    }
  } catch (e) {
    const body = (e as { body?: Json }).body;
    if (!body && !(e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) throw e;
    const shown = body ?? {
      error: "invalid_input",
      message: (e as Error).message,
      fix: "Run `eyes help` for usage.",
    };
    if (json) {
      deps.out(JSON.stringify(shown));
    } else {
      const { error, message, fix, ...context } = shown;
      deps.err(`Error (${error}): ${message}`);
      deps.err(`Fix: ${fix}`);
      for (const line of lines(context)) deps.err(line);
    }
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), {
    fetch,
    env: process.env,
    configPath: join(homedir(), ".config", "eyes", "config.json"),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
