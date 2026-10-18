import { defineConfig } from "vitest/config";

const ignore = ["**/node_modules/**", "**/dist/**"];
const gate = process.env.COVERAGE_GATE === "1";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{apps,packages,cli,scripts}/**/*.test.ts", "evals/**/*.test.ts"],
          exclude: [...ignore, "**/*.{contract,int,rules}.test.ts"],
        },
      },
      { test: { name: "contract", include: ["packages/**/*.contract.test.ts"], exclude: ignore } },
      {
        test: {
          name: "integration",
          include: ["**/*.int.test.ts"],
          exclude: ignore,
          fileParallelism: false,
          setupFiles: ["scripts/int-db.ts"],
        },
      },
      { test: { name: "safety", include: ["{packages,evals}/**/*.rules.test.ts"], exclude: ignore } },
    ],
    coverage: {
      include: ["apps/**/*.{ts,js}", "packages/**/*.{ts,js}", "cli/**/*.{ts,js}"],
      exclude: [
        "**/*.test.ts",
        "**/*.{contract,int,rules}.test.ts",
        "**/dist/**",
        "**/node_modules/**",
        "**/.wrangler/**",
        "**/.astro/**",
        "scripts/**",
        // Widget dev harness: a browser preview page and a Playwright screenshot script.
        "apps/web/widget-task-card/{preview,scripts}/**",
        "apps/mobile/ios/**",
      ],
      thresholds: gate
        ? { perFile: true, statements: 95, branches: 95, functions: 95, lines: 95 }
        : undefined,
    },
  },
});
