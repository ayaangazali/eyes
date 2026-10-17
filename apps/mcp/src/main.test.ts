import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

describe("main.ts", () => {
  it("refuses to start in live mode without ANTHROPIC_API_KEY", () => {
    const run = spawnSync(process.execPath, [MAIN], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH,
        EYES_PROVIDERS: "live",
        EYES_PUBLIC_API_URL: "http://127.0.0.1:3000",
        EYES_WORKER_WEB_URL: "http://127.0.0.1:5173",
        EYES_LINK_SECRET: "x".repeat(32),
        DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
      },
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("EYES_PROVIDERS=live needs ANTHROPIC_API_KEY");
    expect(run.stdout).not.toContain("listening");
  });
});
