import { describe, expect, it } from "vitest";
import { databaseUrlFromEnv } from "./migrate.ts";

describe("databaseUrlFromEnv", () => {
  it("returns DATABASE_URL when it is set", () => {
    expect(databaseUrlFromEnv({ DATABASE_URL: "postgres://u:p@h:1/db" })).toBe("postgres://u:p@h:1/db");
  });

  it("throws, naming the variable and an example, when DATABASE_URL is unset", () => {
    expect(() => databaseUrlFromEnv({})).toThrow(/DATABASE_URL is required, e\.g\. postgres:\/\//);
  });

  it("treats an empty DATABASE_URL as unset", () => {
    expect(() => databaseUrlFromEnv({ DATABASE_URL: "" })).toThrow(/DATABASE_URL is required/);
  });
});
