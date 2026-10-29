import { describe, expect, it } from "vitest";
import { redirectSystemPath } from "../app/+native-intent.ts";

describe("native intent", () => {
  it("sends every incoming link to Home, which reads the setup link itself", () => {
    expect(redirectSystemPath()).toBe("/");
  });
});
