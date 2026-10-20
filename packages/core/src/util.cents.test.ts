import { describe, expect, it } from "vitest";
import { EyesError } from "./errors.ts";
import { assertWholeCents, centsToUsd, usdToCents } from "./util.ts";

describe("assertWholeCents (eyes#117)", () => {
  it("accepts whole cents", () => {
    for (const v of [0, 1, 10, 10.5, 10.01, 10.99, "10.00", "3.50", "0.05"]) {
      expect(assertWholeCents(v)).toBe(v);
    }
  });

  it("rejects sub-cent values instead of rounding them", () => {
    for (const bad of [10.004, 10.006, 3.333, 0.001, 1.005, "10.004"]) {
      expect(() => assertWholeCents(bad)).toThrow(/at most 2 decimals/);
    }
  });

  it("reports invalid amounts as a documented 400 error", () => {
    expect(() => assertWholeCents(10.004, "bounty_usd")).toThrow(
      expect.objectContaining({ code: "invalid_input", status: 400 }),
    );
    expect(() => assertWholeCents(10.004)).toThrow(EyesError);
  });

  it("rejects non-numeric input", () => {
    for (const bad of ["abc", "", "1.2.3", "1,5", "1e2", "NaN", "Infinity"]) {
      expect(() => assertWholeCents(bad)).toThrow();
    }
  });

  it("names the offending field in the message", () => {
    expect(() => assertWholeCents(10.004, "bounty_usd")).toThrow(/bounty_usd/);
  });

  it("is strict about the decimal separator", () => {
    expect(() => assertWholeCents("10,00")).toThrow();
    expect(assertWholeCents("10.00")).toBe("10.00");
  });
});

describe("rounding boundary that motivated the fix", () => {
  it("10.004 exceeds a 10 cap when compared unrounded", () => {
    // Before: usdToCents(10.004) === 1000, which is NOT > 1000, so it passed.
    expect(usdToCents(10.004)).toBe(1000);
    // The fixed comparison uses the raw value:
    expect(10.004 > centsToUsd(1000)).toBe(true);
  });

  it("10.004 is now rejected outright", () => {
    expect(() => assertWholeCents(10.004)).toThrow();
  });

  it("3.333 is rejected rather than silently stored as 3.33", () => {
    expect(usdToCents(3.333)).toBe(333);
    expect(() => assertWholeCents(3.333)).toThrow();
  });
});

describe("usdToCents / centsToUsd remain unchanged", () => {
  it("still rounds, for display and balances", () => {
    expect(usdToCents(10.004)).toBe(1000);
    expect(usdToCents(10.006)).toBe(1001);
    expect(centsToUsd(1000)).toBe(10);
  });
});
