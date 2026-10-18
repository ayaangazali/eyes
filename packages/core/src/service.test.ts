import { describe, expect, it } from "vitest";
import { AppConfig } from "./service.ts";

const base = {
  public_api_url: "https://api.eyes.test",
  worker_web_url: "https://w.eyes.test",
  link_secret: "test-link-secret-0123456789",
};

describe("EYES_TESTFLIGHT_URL config", () => {
  it("is optional and stays undefined when unset", () => {
    expect(AppConfig.parse(base).testflight_url).toBeUndefined();
  });

  it("accepts a TestFlight join link, with or without a trailing slash", () => {
    const link = "https://testflight.apple.com/join/AbC123xy";
    expect(AppConfig.parse({ ...base, testflight_url: link }).testflight_url).toBe(link);
    expect(AppConfig.parse({ ...base, testflight_url: `${link}/` }).testflight_url).toBe(`${link}/`);
  });

  it.each([
    "http://testflight.apple.com/join/AbC123xy",
    "https://example.com/join/AbC123xy",
    "https://testflight.apple.com/join/",
    "https://testflight.apple.com/join/AbC123xy/extra",
    " https://testflight.apple.com/join/AbC123xy",
  ])("rejects a link that is not a TestFlight join link (%s)", (url) => {
    expect(AppConfig.safeParse({ ...base, testflight_url: url }).success).toBe(false);
  });
});
