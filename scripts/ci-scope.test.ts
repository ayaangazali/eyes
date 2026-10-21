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

  it("ignores generated release notes and version state without hiding code changes", () => {
    const metadata = ["CHANGELOG.md", ".release-please-manifest.json"];
    expect(scope(metadata)).toEqual(scope([]));
    expect(scope([...metadata, "apps/mcp/src/server.ts"])).toEqual(scope(["apps/mcp/src/server.ts"]));
    expect(scope([...metadata, "package.json"]).full).toBe(true);
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
        "apps/mcp/.mcp-use/build/index.js",
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

  it("selects the web suites for dashboard and landing changes", () => {
    for (const file of [
      "apps/web/dashboard/src/server.ts",
      "apps/web/dashboard/e2e/index.spec.ts",
      "apps/web/landing/src/pages/index.astro",
      "apps/web/landing/e2e/connect.spec.ts",
    ]) {
      expect(scope([file])).toMatchObject({ e2eWorker: true, web: true });
    }
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

// Execute the actual workflow shell so security guards cannot drift from their tests.
const workflowShell = (file: string, job: string) => {
  const text = readFileSync(join(REPO, ".github/workflows", file), "utf8");
  const block = text.split(`\n  ${job}:\n`)[1]?.split(/\n {2}[\w-]+:\n/)[0] ?? "";
  const shell = block.match(/ {8}run: \|\n((?: {10}[^\n]*\n?)+)/)?.[1];
  if (!shell) throw new Error(`Missing shell for ${file}:${job}`);
  return shell.replace(/^ {10}/gm, "");
};

const runWorkflowShell = (shell: string, env: Record<string, string | undefined> = {}) => {
  const output = join(mkdtempSync(join(tmpdir(), "ci-workflow-")), "output");
  const result = spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-e",
      "-o",
      "pipefail",
      "-c",
      `
    node() { :; }
    git() {
      case "$*" in
        *--name-only*) [ "\${DIFF_FAIL:-}" != names ] || return 1; printf '%s' "$FILES";;
        *--raw*) [ "\${DIFF_FAIL:-}" != modes ] || return 1; printf '%s' "\${MODES:-}";;
        *) return 91;;
      esac
    }
    gh() {
      printf '%s\\n' "$*" >&2
      case "$*" in
        *--disable-auto*) return "\${DISABLE_STATUS:-0}";;
        *autoMergeRequest*) [ "\${VIEW_FAIL:-}" != 1 ] || return 1; printf '%s' "\${ARMED:-false}";;
        *headRefOid*) [ "\${VIEW_FAIL:-}" != 1 ] || return 1; printf '%s' "$CURRENT";;
        *--match-head-commit*) return "\${MERGE_STATUS:-0}";;
        *) return 92;;
      esac
    }
    ${shell}
  `,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        EVENT: "pull_request",
        BASE: "origin/main",
        FILES: "README.md",
        GITHUB_OUTPUT: output,
        PR_URL: "https://github.com/owner/repo/pull/1",
        TESTED_HEAD: "tested",
        CURRENT: "tested\tfalse\tOPEN",
        ...env,
      },
    },
  );
  return {
    ...result,
    output: result.status === 0 ? readFileSync(output, { encoding: "utf8", flag: "a+" }) : "",
  };
};

describe("workflow docs classification", () => {
  for (const file of ["ci.yml", "claude-verifier.yml"]) {
    const shell = workflowShell(file, "scope");
    it(`${file}: accepts only non-executable documentation`, () => {
      for (const files of [
        "README.md\ndocs/archive/hackathon/STATUS.md\nLICENSE",
        "docs/DEPLOY.md\nintent/decisions/ADR-030.md",
      ]) {
        expect(runWorkflowShell(shell, { FILES: files }).output).toContain("docs_only=true");
      }
      for (const files of [
        "",
        "README.md\napps/mcp/src/server.ts",
        "docs/generated.js",
        "intent/run.sh",
        "apps/web/src/pages/index.md",
        ".github/README.md",
        "docs/.hidden/note.md",
        "docs/old.ts\ndocs/new.md",
        "package.json",
      ]) {
        expect(runWorkflowShell(shell, { FILES: files }).output, files).toContain("docs_only=false");
      }
      for (const modes of [
        ":100644 100755 abc def M\tREADME.md",
        ":100755 000000 abc def D\tREADME.md",
        ":000000 120000 abc def A\tdocs/link.md",
      ]) {
        expect(runWorkflowShell(shell, { MODES: modes }).output).toContain("docs_only=false");
      }
    });
    it(`${file}: fails closed when either git diff fails`, () => {
      for (const failure of ["names", "modes"]) {
        expect(runWorkflowShell(shell, { DIFF_FAIL: failure }).status).not.toBe(0);
      }
      expect(shell).toContain("--no-renames --name-only");
      expect(shell).toContain("--no-renames --raw");
    });
  }
  it("never classifies push, schedule, or manual runs as docs-only", () => {
    for (const event of ["push", "schedule", "workflow_dispatch"]) {
      expect(runWorkflowShell(workflowShell("ci.yml", "scope"), { EVENT: event }).output).toContain(
        "docs_only=false",
      );
    }
  });
});

describe("workflow auto-merge guards", () => {
  const enable = workflowShell("ci.yml", "docs-automerge");
  const disable = workflowShell("ci.yml", "docs-automerge-disable");
  it("enables only the tested, open, non-draft head and binds merge to it", () => {
    const result = runWorkflowShell(enable);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("--auto --merge --match-head-commit tested");
    expect(result.stderr).not.toContain("--admin");
    for (const env of [
      { CURRENT: "newer\tfalse\tOPEN" },
      { CURRENT: "tested\ttrue\tOPEN" },
      { CURRENT: "tested\tfalse\tCLOSED" },
      { VIEW_FAIL: "1" },
    ]) {
      const failed = runWorkflowShell(enable, env);
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).not.toContain("--auto --merge");
    }
    expect(runWorkflowShell(enable, { MERGE_STATUS: "1" }).status).not.toBe(0);
  });
  it("accepts successful disable or confirmed unarmed state, never a failed lookup", () => {
    expect(runWorkflowShell(disable).status).toBe(0);
    expect(runWorkflowShell(disable, { DISABLE_STATUS: "1", ARMED: "false" }).status).toBe(0);
    for (const env of [{ ARMED: "true" }, { ARMED: "unexpected" }, { VIEW_FAIL: "1" }]) {
      expect(runWorkflowShell(disable, { DISABLE_STATUS: "1", ...env }).status).not.toBe(0);
    }
  });
});
