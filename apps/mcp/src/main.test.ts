import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

describe("main.ts", () => {
  it("refuses to start in live mode without ANTHROPIC_API_KEY", async () => {
    const run = await boot({});
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("EYES_PROVIDERS=live needs ANTHROPIC_API_KEY");
    expect(run.stdout).not.toContain("listening");
  });

  it("refuses live storage with only one of the two InsForge variables", async () => {
    const run = await boot({ ANTHROPIC_API_KEY: "sk-ant-test", INSFORGE_API_KEY: "ik_test" });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("needs both INSFORGE_BASE_URL and INSFORGE_API_KEY");
  });

  it.each(["abc", "3000.5", "70000", "-1", " ", "0x50", "1e3"])("refuses PORT=%j", async (port) => {
    const run = await boot({ EYES_PROVIDERS: "fake", PORT: port });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("PORT must be an integer from 0 to 65535");
  });

  it("refuses an EYES_OPS_KEY shorter than 32 characters", async () => {
    const run = await boot({ EYES_PROVIDERS: "fake", EYES_OPS_KEY: "demo" });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("EYES_OPS_KEY must be at least 32 random characters");
    expect(run.stdout).not.toContain("listening");
  });

  it("refuses EYES_SANDBOX=1 unless every provider is fake and EYES_FAKE_WEBHOOKS and ANTHROPIC_API_KEY are unset", async () => {
    const refused: Record<string, string>[] = [
      { ANTHROPIC_API_KEY: "sk-ant-test" },
      { EYES_PROVIDERS: "fake", EYES_FAKE_WEBHOOKS: "1" },
      { EYES_PROVIDERS: "fake", ANTHROPIC_API_KEY: "sk-ant-test" },
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
