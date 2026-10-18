import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { buildOpsScript, OUT } from "./build-ops-view.ts";

test("the committed ops script matches ops-view/*.ts (else run pnpm --filter @eyes/web-dashboard build)", () => {
  expect(readFileSync(OUT, "utf8")).toBe(buildOpsScript());
});
