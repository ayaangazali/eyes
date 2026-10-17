import { SAFETY_CATEGORIES, type SafetyCategory, type SafetyInput, TASK_TYPES } from "@eyes/core";
import { describe, expect, it } from "vitest";
import fixtures from "../../../evals/safety/fixtures.json" with { type: "json" };
import { checkRules } from "./rules.ts";

type Fixture = SafetyInput & {
  expected: "allow" | "block";
  category?: SafetyCategory;
  rules_expected?: "allow" | "block";
};

const cases = fixtures as Fixture[];

describe("safety fixtures", () => {
  it("cover every category with enough allowed and blocked cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(cases.filter((f) => f.expected === "allow").length).toBeGreaterThanOrEqual(12);
    expect(cases.filter((f) => f.expected === "block").length).toBeGreaterThanOrEqual(18);
    expect(new Set(cases.map((f) => f.category).filter(Boolean))).toEqual(new Set(SAFETY_CATEGORIES));
    for (const f of cases) expect(TASK_TYPES).toContain(f.task_type);
  });
});

describe("rule layer", () => {
  it.each(cases.filter((f) => f.rules_expected))("$rules_expected: $question", (f) => {
    const verdict = checkRules(f);
    expect(verdict.layer).toBe("rules");
    if (f.rules_expected === "allow") {
      expect(verdict).toEqual({ allowed: true, category: null, reason: null, fix: null, layer: "rules" });
    } else {
      expect(verdict.allowed).toBe(false);
      expect(verdict.category).toBe(f.category);
      expect(verdict.reason).toBeTruthy();
      expect(verdict.fix).toBeTruthy();
    }
  });
});
