import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { pathToFileURL } from "node:url";

// Changing any of these can change what every other check means, so CI runs everything.
export const FULL_RUN_GLOBS = [
  "vitest.config.ts",
  "package.json",
  "pnpm-lock.yaml",
  ".github/**",
  "packages/core/**",
  "scripts/ci-scope.ts",
];

// Same include/exclude as vitest.config.ts coverage, applied to changed files.
const COVERAGE_INCLUDE = ["apps/**/*.{ts,js}", "packages/**/*.{ts,js}", "cli/**/*.{ts,js}"];
const COVERAGE_EXCLUDE = [
  "**/*.test.ts",
  "**/*.{contract,int,rules}.test.ts",
  "**/dist/**",
  "**/node_modules/**",
  "**/.wrangler/**",
  "**/.astro/**",
  "scripts/**",
  "apps/mobile/ios/**",
];
// Worker e2e covers the web app and the UI kit it renders.
const WORKER_E2E_GLOBS = ["apps/web/**", "packages/ui/**", "playwright.config.ts"];
// Golden-path e2e (e2e/) exercises the whole stack, so any package or the MCP server runs it.
const GOLDEN_E2E_GLOBS = ["e2e/**", "apps/mcp/**", "packages/**", "playwright.config.ts"];
const WEB_BUILD_GLOBS = ["apps/web/**", "packages/ui/**"];

export type CoverageMode = "full" | "changed" | "skip";

export type Scope = {
  full: boolean;
  changed: boolean;
  reason: string;
  coverageMode: CoverageMode;
  coverageInclude: string[];
  e2eWorker: boolean;
  e2eGolden: boolean;
  web: boolean;
};

const anyMatch = (file: string, globs: string[]) => globs.some((glob) => matchesGlob(file, glob));

export function fullScope(reason: string): Scope {
  return {
    full: true,
    changed: true,
    reason,
    coverageMode: "full",
    coverageInclude: [],
    e2eWorker: true,
    e2eGolden: true,
    web: true,
  };
}

export function scope(changed: string[]): Scope {
  const files = [...new Set(changed.map((file) => file.trim()).filter(Boolean))].sort();
  const shared = files.find((file) => anyMatch(file, FULL_RUN_GLOBS));
  if (shared) return fullScope(`shared file changed: ${shared}`);
  const sources = files.filter(
    (file) => anyMatch(file, COVERAGE_INCLUDE) && !anyMatch(file, COVERAGE_EXCLUDE),
  );
  return {
    full: false,
    changed: files.length > 0,
    reason: files.length ? `${files.length} changed file(s)` : "no changed files",
    coverageMode: sources.length ? "changed" : "skip",
    coverageInclude: sources,
    e2eWorker: files.some((file) => anyMatch(file, WORKER_E2E_GLOBS)),
    e2eGolden: files.some((file) => anyMatch(file, GOLDEN_E2E_GLOBS)),
    web: files.some((file) => anyMatch(file, WEB_BUILD_GLOBS)),
  };
}

function changedSince(base: string): string[] {
  try {
    return execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" }).split("\n");
  } catch {
    throw new Error(
      `ci-scope: cannot diff against ${base}; fetch the base first (actions/checkout fetch-depth: 0)`,
    );
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const base = args.find((arg) => !arg.startsWith("--")) ?? "origin/main";
  const result = args.includes("--full") ? fullScope("forced by event") : scope(changedSince(base));
  const lines = [
    `full=${result.full}`,
    `changed=${result.changed}`,
    `coverage_mode=${result.coverageMode}`,
    `coverage_include=${result.coverageInclude.join(",")}`,
    `e2e_worker=${result.e2eWorker}`,
    `e2e_golden=${result.e2eGolden}`,
    `web=${result.web}`,
    `reason=${result.reason}`,
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
