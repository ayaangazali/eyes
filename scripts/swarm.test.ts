import { describe, expect, it } from "vitest";
import { plan, refusal } from "./swarm.ts";

const LOCAL = "postgres://postgres:eyes@127.0.0.1:54329/eyes";

describe("swarm", () => {
  it("runs only on fake providers and a localhost database unless --allow-remote", () => {
    for (const url of [LOCAL, "postgresql://u:p@localhost/db", "postgres://u:p@[::1]:5432/db"]) {
      expect(refusal({ DATABASE_URL: url }, false)).toBeNull();
    }
    for (const url of [
      "postgres://u:p@db.example.com/eyes",
      "postgres://u:p@localhost.evil.test/db",
      "nope",
    ]) {
      expect(refusal({ DATABASE_URL: url }, false)).toMatch(/--allow-remote/);
      expect(refusal({ DATABASE_URL: url }, true)).toBeNull();
    }
    expect(refusal({}, true)).toMatch(/DATABASE_URL/);
    expect(refusal({ DATABASE_URL: LOCAL, EYES_PROVIDERS: "live" }, true)).toMatch(/fake providers/);
  });

  it("plans a repeatable mix of every outcome inside about a minute", () => {
    const tasks = plan(50, 2);
    expect(plan(50, 2)).toEqual(tasks);
    expect(tasks).toHaveLength(100);
    expect(new Set(tasks.map((t) => t.fate))).toEqual(new Set(["paid", "claimed", "cancelled", "expired"]));
    expect(tasks.filter((t) => t.fate === "paid").length).toBeGreaterThan(30);
    for (const t of tasks) {
      expect(0 <= t.postAt && t.postAt < t.actAt && t.actAt < t.captureAt && t.captureAt <= 60).toBe(true);
    }
  });
});
