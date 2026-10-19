import { spawn } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { start } from "./main.ts";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const BASE_ENV = {
  PATH: process.env.PATH,
  EYES_PROVIDERS: "live",
  EYES_PUBLIC_API_URL: "http://127.0.0.1:3000",
  EYES_WORKER_WEB_URL: "http://127.0.0.1:5173",
  EYES_LINK_SECRET: "x".repeat(32),
  DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
  HOST: "127.0.0.1",
  PORT: "0",
};

function boot(env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [MAIN], { env: { ...BASE_ENV, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("listening")) child.kill();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("main.ts as a process", () => {
  it("exits 1 with the reason when the env is bad", async () => {
    const run = await boot({});
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("EYES_PROVIDERS=live needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
    expect(run.stdout).not.toContain("listening");
  });

  it("refuses EYES_SANDBOX=1 unless every provider is fake and no webhook or billed AI key is set", async () => {
    const refused: Record<string, string>[] = [
      { ANTHROPIC_API_KEY: "sk-ant-test" },
      { EYES_PROVIDERS: "fake", EYES_FAKE_WEBHOOKS: "1" },
      { EYES_PROVIDERS: "fake", ANTHROPIC_API_KEY: "sk-ant-test" },
      { EYES_PROVIDERS: "fake", CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "cf-test" },
    ];
    for (const env of refused) {
      const run = await boot({ EYES_SANDBOX: "1", ...env });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("EYES_SANDBOX=1 gives an agent with play money to anyone");
      expect(run.stdout).not.toContain("listening");
    }
    expect((await boot({ EYES_SANDBOX: "1", EYES_PROVIDERS: "fake" })).stdout).toContain("listening");
  }, 15_000);

  it("wires InsForge storage in live mode and starts serving", async () => {
    const run = await boot({
      ANTHROPIC_API_KEY: "sk-ant-test",
      INSFORGE_BASE_URL: "http://127.0.0.1:1",
      INSFORGE_API_KEY: "ik_test",
    });
    expect(run.stdout).toContain("provider storage: live");
    expect(run.stdout).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+\/mcp/);
  }, 15_000);
});

describe("start", () => {
  const exit = (message: string): never => {
    throw new Error(message);
  };
  const logs: string[] = [];
  const stops: (() => unknown)[] = [];
  // The booted event log flushes to an unreachable database on a timer that outlives each test and
  // reports to stderr; keep that noise out of the run for the whole file.
  beforeAll(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    logs.length = 0;
    vi.mocked(console.log).mockRestore();
  });
  const run = (env: Record<string, string | undefined>) => {
    vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    const app = start({ ...BASE_ENV, EYES_PROVIDERS: "fake", ...env }, exit);
    stops.push(app.stop);
    return app;
  };
  const serve = async (env: Record<string, string | undefined>) => {
    const { http } = run(env);
    await once(http, "listening");
    return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  };

  it("refuses an invalid EYES_* environment", () => {
    expect(() => run({ EYES_PUBLIC_API_URL: undefined, EYES_DISPATCH_RADIUS_M: "-5" })).toThrow(
      /Invalid EYES_\* environment/,
    );
  });

  it("refuses live mode without a classifier key", () => {
    expect(() => run({ EYES_PROVIDERS: "live" })).toThrow(
      /needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN/,
    );
  });

  it("refuses live storage with only one of the two InsForge variables", () => {
    expect(() =>
      run({ EYES_PROVIDERS: "live", ANTHROPIC_API_KEY: "sk-ant-test", INSFORGE_API_KEY: "ik" }),
    ).toThrow(/needs both INSFORGE_BASE_URL and INSFORGE_API_KEY/);
  });

  it("refuses an EYES_OPS_KEY shorter than 32 characters", () => {
    expect(() => run({ EYES_OPS_KEY: "demo" })).toThrow(/EYES_OPS_KEY must be at least 32 random characters/);
  });

  it.each(["abc", "3000.5", "70000", "-1", " ", "0x50", "1e3"])("refuses PORT=%j", (port) => {
    expect(() => run({ PORT: port })).toThrow(/PORT must be an integer from 0 to 65535/);
  });

  it("needs a database (checked before binding the default port)", () => {
    expect(() => run({ PORT: undefined, DATABASE_URL: undefined })).toThrow(
      "Set DATABASE_URL, or INSFORGE_BASE_URL and INSFORGE_API_KEY.",
    );
  });

  it("serves with fake providers and parses every optional EYES_* knob", async () => {
    const base = await serve({
      EYES_TEST_MODE: "true",
      EYES_DISPATCH_RADIUS_M: "1500",
      EYES_LOCATION_MAX_AGE_H: "6",
      EYES_LOCATION_PING: "false",
      EYES_LOCATION_MIN_INTERVAL_S: "60",
      EYES_LOCATION_DAILY_MAX: "20",
      EYES_TESTFLIGHT_URL: "https://testflight.apple.com/join/x",
      PRIMITIVE_DOMAIN: "mail.eyes.test",
      EYES_OPS_KEY: "k".repeat(32),
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        "provider messaging: FAKE",
        "provider vision: FAKE",
        "provider geo: FAKE",
        "db: postgres",
        "clickhouse: off",
        expect.stringMatching(/^Eyes MCP listening on http:\/\/127\.0\.0\.1:\d+\/mcp$/),
      ]),
    );
    const res = await fetch(`${base}/no-such-route`);
    expect(res.status).toBe(404);
  });

  it("wires every live provider, InsForge as the database and ClickHouse when configured", async () => {
    await serve({
      EYES_PROVIDERS: "live",
      DATABASE_URL: undefined,
      INSFORGE_BASE_URL: "http://127.0.0.1:1",
      INSFORGE_API_KEY: "ik_test",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      CLOUDFLARE_API_TOKEN: "cf",
      INKBOX_API_KEY: "ink",
      INKBOX_AGENT_HANDLE: "eyes-dispatch",
      PRIMITIVE_API_KEY: "prim",
      PRIMITIVE_DOMAIN: "mail.eyes.test",
      STRIPE_SECRET_KEY: "sk_test_x",
      CLICKHOUSE_URL: "http://127.0.0.1:1/",
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        "provider messaging: live",
        "provider email: live",
        "provider payments: live",
        "provider storage: live",
        "provider vision: live",
        "provider geo: live",
        "db: insforge",
        "clickhouse: http://127.0.0.1:1 (eyes)",
      ]),
    );
  });

  it("falls back to Claude vision without Cloudflare credentials and binds HOST 0.0.0.0 by default", async () => {
    const { http } = run({ EYES_PROVIDERS: "live", ANTHROPIC_API_KEY: "sk-ant-test", HOST: "" });
    await once(http, "listening");
    expect(logs).toContain("provider vision: live");
    expect(logs).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Eyes MCP listening on http:\/\/0\.0\.0\.0:/)]),
    );
  });

  it("runs the expiry and payout sweeps every 30 s and logs their failures", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      run({});
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => {
        expect(errors).toHaveBeenCalledWith("expireOverdue failed", expect.anything());
        expect(errors).toHaveBeenCalledWith("retryPayouts failed", expect.anything());
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
