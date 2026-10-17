import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./resolve-task.ts", import.meta.url));
const TASK_ID = "6f1c2b0e-8a4d-4c1e-9b7a-2d3e4f5a6b7c";

const run = (env: Record<string, string>) =>
  spawnSync(process.execPath, [SCRIPT, TASK_ID, "release", "Line is visible."], {
    env: { PATH: process.env.PATH ?? "", DATABASE_URL: "postgres://postgres:eyes@127.0.0.1:1/none", ...env },
    encoding: "utf8",
  });

describe("resolve-task", () => {
  it("exits before touching the database unless payments and messaging are live or fakes are asked for", () => {
    for (const env of [
      {} as Record<string, string>,
      { EYES_PROVIDERS: "live", STRIPE_SECRET_KEY: "sk_test_unit" },
      { EYES_PROVIDERS: "live", INKBOX_API_KEY: "ik_unit" },
    ]) {
      const out = run(env);
      expect(out.status).toBe(1);
      expect(out.stderr).toContain("Refusing to resolve with fake payments or messaging");
      expect(out.stdout).toBe("");
    }
    const fake = run({ EYES_PROVIDERS: "fake", DATABASE_URL: "" });
    expect(fake.status).toBe(1);
    expect(fake.stderr).toContain("Set DATABASE_URL");
    expect(fake.stderr).not.toContain("Refusing");
  }, 30_000);
});
