import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const script = fileURLToPath(new URL("./check-intent.ts", import.meta.url));
let cwd: string;
const manifest = { scripts: { test: "vitest" }, devDependencies: { vitest: "5.0.4" } };
const put = (file: string, value: string) => {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), value);
};
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const check = (...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, INTENT_BASE: "HEAD" },
  });

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "eyes-intent-"));
  git("init", "-q");
  put("package.json", JSON.stringify(manifest));
  put("apps/mobile/package.json", JSON.stringify(manifest));
  put("apps/mobile/package-lock.json", "{}");
  put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  put("apps/mobile/index.ts", "export const value = 1;\n");
  mkdirSync(join(cwd, "intent"));
  git("add", ".");
  expect(check("--write-index").status).toBe(0);
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

it("accepts dependency version updates with root and nested lockfiles without intent", () => {
  for (const file of ["package.json", "apps/mobile/package.json"]) {
    put(file, JSON.stringify({ ...manifest, devDependencies: { vitest: "5.0.5" } }));
  }
  put("pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages: {}\n");
  put("apps/mobile/package-lock.json", '{"lockfileVersion":3}');
  const result = check();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

it("requires intent for a package script change", () => {
  put("apps/mobile/package.json", JSON.stringify({ ...manifest, scripts: { test: "node test.js" } }));
  const result = check();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("apps/mobile/package.json: changed but no intent file changed");
});

it("requires intent for code changed alongside a lockfile", () => {
  put("apps/mobile/index.ts", "export const value = 2;\n");
  put("pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages: {}\n");
  const result = check();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("apps/mobile/index.ts: changed but no intent file changed");
});

it("requires intent for adding a dependency", () => {
  put("apps/mobile/package.json", JSON.stringify({ ...manifest, dependencies: { react: "19.0.0" } }));
  const result = check();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("apps/mobile/package.json: changed but no intent file changed");
});

it("requires intent when a version changes to a different package source", () => {
  put(
    "apps/mobile/package.json",
    JSON.stringify({ ...manifest, devDependencies: { vitest: "npm:other@1.0.0" } }),
  );
  const result = check();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("apps/mobile/package.json: changed but no intent file changed");
});
