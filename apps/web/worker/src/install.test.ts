import { describe, expect, it, vi } from "vitest";
import { Problem } from "./api.ts";
import {
  DEFAULT_MANIFEST_URL,
  type DeviceStatus,
  deviceStep,
  type InstallDeps,
  itmsUrl,
  readCode,
  startInstall,
} from "./install.ts";

const CODE = "a".repeat(43);
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";
const PROFILE = "https://api.eyes.pictures/w/device/profile/tkt";
const status = (over: Partial<DeviceStatus> = {}): DeviceStatus => ({
  profile_url: PROFILE,
  registered: false,
  ready: false,
  ...over,
});

function fakeDeps(over: Partial<InstallDeps> = {}): InstallDeps {
  return {
    hash: `#c=${CODE}`,
    pathname: "/install",
    search: "",
    userAgent: IPHONE,
    replaceUrl: vi.fn(),
    send: vi.fn(async () => status()),
    show: vi.fn(),
    setHref: vi.fn(),
    report: vi.fn(),
    ...over,
  };
}

describe("readCode", () => {
  it("reads a valid code, also among other fragment parameters", () => {
    expect(readCode(`#c=${CODE}`)).toBe(CODE);
    expect(readCode(`#x=1&c=${CODE}`)).toBe(CODE);
  });

  it.each([
    ["", ""],
    ["no c", `#x=${CODE}`],
    ["too short", "#c=short"],
    ["bad characters", `#c=${"a.".repeat(15)}`],
  ])("refuses %s", (_label, hash) => {
    expect(readCode(hash)).toBeNull();
  });
});

describe("itmsUrl", () => {
  it("encodes the manifest URL into the install link", () => {
    expect(itmsUrl("https://x.test/m.plist?a=1")).toBe(
      "itms-services://?action=download-manifest&url=https%3A%2F%2Fx.test%2Fm.plist%3Fa%3D1",
    );
  });

  it("falls back to the default manifest", () => {
    expect(itmsUrl()).toBe(
      `itms-services://?action=download-manifest&url=${encodeURIComponent(DEFAULT_MANIFEST_URL)}`,
    );
  });
});

describe("deviceStep", () => {
  it.each([
    [status(), false, "register"],
    [status(), true, "waiting"],
    [status({ registered: true }), false, "waiting"],
    [status({ registered: true, ready: true }), false, "install"],
  ] as const)("%o with registered=%s → %s", (s, param, step) => {
    expect(deviceStep(s, param)).toBe(step);
  });
});

describe("startInstall", () => {
  it("sends the code only as a Bearer header, clears the fragment, and shows the register step", async () => {
    const d = fakeDeps({ search: "?x=1" });
    expect(await startInstall(d)).toBe("register");
    expect(d.replaceUrl).toHaveBeenCalledWith("/install?x=1");
    expect(d.send).toHaveBeenCalledWith("/w/device", {
      method: "POST",
      headers: { Authorization: `Bearer ${CODE}` },
    });
    expect(d.setHref).toHaveBeenCalledWith("profile", PROFILE);
    expect(d.show).toHaveBeenCalledWith("register");
    expect(d.report).not.toHaveBeenCalled();
  });

  it("shows the waiting step once registered", async () => {
    const d = fakeDeps({ send: vi.fn(async () => status({ registered: true })) });
    expect(await startInstall(d)).toBe("waiting");
    expect(d.setHref).not.toHaveBeenCalled();
  });

  it("sets the install link when ready", async () => {
    const d = fakeDeps({ send: vi.fn(async () => status({ registered: true, ready: true })) });
    expect(await startInstall(d, "https://x.test/m.plist")).toBe("install");
    expect(d.setHref).toHaveBeenCalledWith("itms", itmsUrl("https://x.test/m.plist"));
    expect(d.show).toHaveBeenCalledWith("install");
  });

  it("treats ?registered=1 without a code as registered, without calling the API", async () => {
    const d = fakeDeps({ hash: "", search: "?registered=1" });
    expect(await startInstall(d)).toBe("waiting");
    expect(d.send).not.toHaveBeenCalled();
    expect(d.replaceUrl).not.toHaveBeenCalled();
  });

  it("explains how to get a link when there is no valid code", async () => {
    const d = fakeDeps({ hash: "#c=short" });
    expect(await startInstall(d)).toBe("missing");
    expect(d.replaceUrl).toHaveBeenCalledWith("/install");
    expect(d.send).not.toHaveBeenCalled();
  });

  it("asks for an iPhone on other devices, still clearing the fragment", async () => {
    const d = fakeDeps({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    expect(await startInstall(d)).toBe("not-iphone");
    expect(d.replaceUrl).toHaveBeenCalledWith("/install");
    expect(d.send).not.toHaveBeenCalled();
  });

  it("shows the expired step on 401", async () => {
    const d = fakeDeps({ send: vi.fn().mockRejectedValue(new Problem("x", "y", 401)) });
    expect(await startInstall(d)).toBe("expired");
    expect(d.report).not.toHaveBeenCalled();
  });

  it.each([
    ["a network failure", new Problem("Could not reach Eyes.", "Check your signal, then try again.")],
    ["a server error", new Problem("Eyes had a problem (HTTP 500).", "Wait a moment, then try again.", 500)],
    ["a non-Problem error", new Error("boom")],
  ])("reports %s", async (_label, err) => {
    const d = fakeDeps({ send: vi.fn().mockRejectedValue(err) });
    expect(await startInstall(d)).toBe("error");
    expect(d.report).toHaveBeenCalledWith(err);
    expect(d.show).toHaveBeenCalledWith("error");
  });
});
