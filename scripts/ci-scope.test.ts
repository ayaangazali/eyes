import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fullScope, scope } from "./ci-scope";

const SCRIPT = fileURLToPath(new URL("./ci-scope.ts", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));
const NOTHING = { e2eWorker: false, e2eGolden: false, web: false };

describe("scope", () => {
  it("runs everything when config, lockfile, workflows, shared core, or the scope script change", () => {
    for (const file of [
      "vitest.config.ts",
      "package.json",
      "pnpm-lock.yaml",
      ".github/workflows/ci.yml",
      "packages/core/src/index.ts",
      "scripts/ci-scope.ts",
    ]) {
      expect(scope([file]), file).toMatchObject({
        full: true,
        changed: true,
        coverageMode: "full",
        e2eWorker: true,
        e2eGolden: true,
        web: true,
      });
    }
  });

  it("names the first shared file, in sorted order, that forced a full run", () => {
    expect(scope(["vitest.config.ts", "docs/x.md", "pnpm-lock.yaml"]).reason).toBe(
      "shared file changed: pnpm-lock.yaml",
    );
  });

  it("skips coverage, e2e and build for docs-only changes", () => {
    expect(scope(["docs/DEPLOY.md"])).toEqual({
      full: false,
      changed: true,
      reason: "1 changed file(s)",
      coverageMode: "skip",
      coverageInclude: [],
      ...NOTHING,
    });
  });

  it("limits coverage to the changed source files, sorted", () => {
    expect(scope(["packages/db/src/rpc.ts", "cli/src/docs.ts"])).toMatchObject({
      coverageMode: "changed",
      coverageInclude: ["cli/src/docs.ts", "packages/db/src/rpc.ts"],
    });
  });

  it("does not measure tests, excluded paths, scripts, or non-ts/js files", () => {
    expect(
      scope([
        "cli/src/docs.test.ts",
        "packages/db/src/x.contract.test.ts",
        "packages/db/src/x.rules.test.ts",
        "packages/db/src/x.int.test.ts",
        "scripts/owner-link.ts",
        "apps/mobile/ios/App.ts",
        "apps/web/worker/dist/app.js",
        "apps/web/worker/.wrangler/x.js",
        "apps/web/worker/.astro/x.ts",
        "apps/web/worker/src/pages/index.astro",
        "cli/README.md",
      ]),
    ).toMatchObject({ changed: true, coverageMode: "skip", coverageInclude: [] });
  });

  it("splits e2e by suite: worker for the web app and UI kit, golden for the whole stack", () => {
    expect(scope(["apps/web/worker/src/api.ts"])).toMatchObject({
      e2eWorker: true,
      e2eGolden: false,
      web: true,
    });
    expect(scope(["apps/mcp/src/server.ts"])).toMatchObject({
      e2eWorker: false,
      e2eGolden: true,
      web: false,
    });
    expect(scope(["packages/engine/src/index.ts"])).toMatchObject({
      e2eWorker: false,
      e2eGolden: true,
      web: false,
    });
    expect(scope(["packages/ui/src/page.ts"])).toMatchObject({ e2eWorker: true, e2eGolden: true, web: true });
    expect(scope(["e2e/demo.spec.ts"])).toMatchObject({ e2eWorker: false, e2eGolden: true, web: false });
    expect(scope(["playwright.config.ts"])).toMatchObject({ e2eWorker: true, e2eGolden: true, web: false });
  });

  it("runs no e2e or web build for docs and root notes", () => {
    expect(scope(["README.md", "docs/DEPLOY.md"])).toMatchObject(NOTHING);
  });

  it("de-duplicates, trims, and ignores blank entries", () => {
    expect(scope(["  cli/src/docs.ts ", "cli/src/docs.ts", "", "   "])).toMatchObject({
      changed: true,
      coverageInclude: ["cli/src/docs.ts"],
      reason: "1 changed file(s)",
    });
  });

  it("treats an empty diff as nothing to run", () => {
    expect(scope([])).toEqual({
      full: false,
      changed: false,
      reason: "no changed files",
      coverageMode: "skip",
      coverageInclude: [],
      ...NOTHING,
    });
  });

  it("builds a full-run scope for events that are not pull requests", () => {
    expect(fullScope("forced by event")).toEqual({
      full: true,
      changed: true,
      reason: "forced by event",
      coverageMode: "full",
      coverageInclude: [],
      e2eWorker: true,
      e2eGolden: true,
      web: true,
    });
  });
});

describe("ci-scope CLI", () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: REPO,
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    });

  it("prints every output and appends the same lines to GITHUB_OUTPUT", () => {
    const out = join(mkdtempSync(join(tmpdir(), "ci-scope-")), "output");
    const result = run(["HEAD"], { GITHUB_OUTPUT: out });
    const expected = [
      "full=false",
      "changed=false",
      "coverage_mode=skip",
      "coverage_include=",
      "e2e_worker=false",
      "e2e_golden=false",
      "web=false",
      "reason=no changed files",
    ];
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(expected);
    expect(readFileSync(out, "utf8").trim().split("\n")).toEqual(expected);
  });

  it("runs everything for --full without needing a base to diff against", () => {
    const result = run(["--full"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("full=true");
    expect(result.stdout).toContain("e2e_worker=true");
    expect(result.stdout).toContain("e2e_golden=true");
  });

  it("fails loudly when the base cannot be diffed, instead of skipping checks", () => {
    const result = run(["origin/does-not-exist-ci-scope"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot diff against origin/does-not-exist-ci-scope");
    expect(result.stdout).toBe("");
  });
});
