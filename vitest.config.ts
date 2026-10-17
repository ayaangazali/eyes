import { defineConfig } from "vitest/config";

const ignore = ["**/node_modules/**", "**/dist/**"];

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
        test: { name: "integration", include: ["**/*.int.test.ts"], exclude: ignore, fileParallelism: false },
      },
      { test: { name: "safety", include: ["{packages,evals}/**/*.rules.test.ts"], exclude: ignore } },
    ],
  },
});
