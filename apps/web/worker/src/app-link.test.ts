import { describe, expect, it, vi } from "vitest";
import { type AppPageDeps, connectDeepLink, startApp } from "./app-link.ts";

const CODE = "a".repeat(20);
const DEEP = `eyes://connect#c=${CODE}`;

function fakeDeps(over: Partial<AppPageDeps> = {}): AppPageDeps {
  return {
    hash: `#c=${CODE}`,
    pathname: "/app",
    search: "?x=1",
    replaceUrl: vi.fn(),
    reveal: vi.fn(),
    setHref: vi.fn(),
    onLoad: vi.fn(),
    later: vi.fn(),
    navigate: vi.fn(),
    ...over,
  };
}

describe("connectDeepLink", () => {
  it("builds the app deep link for a valid code", () => {
    expect(connectDeepLink(`#c=${CODE}`)).toBe(DEEP);
  });

  it("accepts the length bounds and the hyphen and underscore characters", () => {
    expect(connectDeepLink(`#c=${"a".repeat(200)}`)).not.toBeNull();
    expect(connectDeepLink(`#c=${"-_".repeat(10)}`)).not.toBeNull();
  });

  it.each([
    ["19 characters, below the minimum", "a".repeat(19)],
    ["201 characters, above the maximum", "a".repeat(201)],
    ["characters outside the allowed set", "abc.def.ghi.jkl.mno.pqr"],
  ])("refuses a code of %s", (_label, code) => {
    expect(connectDeepLink(`#c=${code}`)).toBeNull();
  });

  it("refuses an empty fragment or one without a c parameter", () => {
    expect(connectDeepLink("")).toBeNull();
    expect(connectDeepLink(`#x=${CODE}`)).toBeNull();
  });

  it("finds c among other fragment parameters", () => {
    expect(connectDeepLink(`#x=1&c=${CODE}`)).toBe(DEEP);
  });
});

describe("startApp", () => {
  it("clears the code from the address bar, shows the app link, and opens the app after load", () => {
    const d = fakeDeps();
    expect(startApp(d)).toBe(DEEP);
    expect(d.replaceUrl).toHaveBeenCalledWith("/app?x=1");
    expect(d.setHref).toHaveBeenCalledWith("open", DEEP);
    expect(d.reveal).toHaveBeenCalledWith("ready");
    expect(d.reveal).not.toHaveBeenCalledWith("missing");
    expect(d.onLoad).toHaveBeenCalledTimes(1);
    expect(d.later).not.toHaveBeenCalled();

    vi.mocked(d.onLoad).mock.calls[0]?.[0]();
    expect(d.later).toHaveBeenCalledWith(expect.any(Function), 300);

    vi.mocked(d.later).mock.calls[0]?.[0]();
    expect(d.navigate).toHaveBeenCalledWith(DEEP);
  });

  it("shows only the missing message when the code is malformed, but still clears the fragment", () => {
    const d = fakeDeps({ hash: "#c=short" });
    expect(startApp(d)).toBeNull();
    expect(d.replaceUrl).toHaveBeenCalledWith("/app?x=1");
    expect(d.reveal).toHaveBeenCalledWith("missing");
    expect(d.reveal).not.toHaveBeenCalledWith("ready");
    expect(d.setHref).not.toHaveBeenCalled();
    expect(d.onLoad).not.toHaveBeenCalled();
  });

  it("leaves the address bar alone when there is no fragment", () => {
    const d = fakeDeps({ hash: "" });
    expect(startApp(d)).toBeNull();
    expect(d.replaceUrl).not.toHaveBeenCalled();
    expect(d.reveal).toHaveBeenCalledWith("missing");
  });
});
