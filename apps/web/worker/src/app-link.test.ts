import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppPageDeps, connectDeepLink, openApp, startApp } from "./app-link.ts";

const CODE = "a".repeat(20);
const DEEP = `eyes://connect#c=${CODE}`;
const TESTFLIGHT = "https://testflight.apple.com/join/bqnkz1NT";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function fakeDeps(over: Partial<AppPageDeps> = {}): AppPageDeps {
  return {
    hash: `#c=${CODE}`,
    pathname: "/app",
    search: "?x=1",
    replaceUrl: vi.fn(),
    reveal: vi.fn(),
    setHref: vi.fn(),
    onLoad: vi.fn(),
    onTap: vi.fn(),
    later: vi.fn(),
    navigate: vi.fn(),
    doc: Object.assign(new EventTarget(), { hidden: false }),
    win: new EventTarget(),
    testflightUrl: undefined,
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
    expect(d.onTap).toHaveBeenCalledTimes(1);
    expect(d.later).not.toHaveBeenCalled();

    vi.mocked(d.onLoad).mock.calls[0]?.[0]();
    expect(d.later).toHaveBeenCalledWith(expect.any(Function), 300);

    vi.mocked(d.later).mock.calls[0]?.[0]();
    expect(d.navigate).toHaveBeenCalledWith(DEEP);
  });

  it("opens the app, with the install fallback, when the app link is tapped", () => {
    const d = fakeDeps();
    startApp(d);
    vi.mocked(d.onTap).mock.calls[0]?.[0]();
    expect(d.navigate).toHaveBeenCalledWith(DEEP);
    vi.advanceTimersByTime(2500);
    expect(d.reveal).toHaveBeenLastCalledWith("review");
  });

  it("shows only the missing message when the code is malformed, but still clears the fragment", () => {
    const d = fakeDeps({ hash: "#c=short" });
    expect(startApp(d)).toBeNull();
    expect(d.replaceUrl).toHaveBeenCalledWith("/app?x=1");
    expect(d.reveal).toHaveBeenCalledWith("missing");
    expect(d.reveal).not.toHaveBeenCalledWith("ready");
    expect(d.setHref).not.toHaveBeenCalled();
    expect(d.onLoad).not.toHaveBeenCalled();
    expect(d.onTap).not.toHaveBeenCalled();
  });

  it("leaves the address bar alone when there is no fragment", () => {
    const d = fakeDeps({ hash: "" });
    expect(startApp(d)).toBeNull();
    expect(d.replaceUrl).not.toHaveBeenCalled();
    expect(d.reveal).toHaveBeenCalledWith("missing");
  });
});

describe("openApp", () => {
  it("opens the app and falls back to nothing when the page hides before 2.5 s", () => {
    const d = fakeDeps({ testflightUrl: TESTFLIGHT });
    openApp(DEEP, d);
    expect(d.navigate).toHaveBeenCalledWith(DEEP);
    vi.advanceTimersByTime(1000);
    d.doc.hidden = true;
    d.doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(5000);
    expect(d.navigate).toHaveBeenCalledTimes(1);
    expect(d.reveal).not.toHaveBeenCalled();
  });

  it("falls back to nothing when the page is left", () => {
    const d = fakeDeps({ testflightUrl: TESTFLIGHT });
    openApp(DEEP, d);
    d.win.dispatchEvent(new Event("pagehide"));
    vi.advanceTimersByTime(5000);
    expect(d.navigate).toHaveBeenCalledTimes(1);
    expect(d.reveal).not.toHaveBeenCalled();
  });

  it("falls back to nothing when the page loses focus (iOS 'Open in Eyes?' prompt)", () => {
    const d = fakeDeps({ testflightUrl: TESTFLIGHT });
    openApp(DEEP, d);
    d.win.dispatchEvent(new Event("blur"));
    vi.advanceTimersByTime(5000);
    expect(d.navigate).toHaveBeenCalledTimes(1);
    expect(d.reveal).not.toHaveBeenCalled();
  });

  it("goes to TestFlight when the page still shows after 2.5 s", () => {
    const d = fakeDeps({ testflightUrl: TESTFLIGHT });
    openApp(DEEP, d);
    vi.advanceTimersByTime(2499);
    expect(d.navigate).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(d.navigate).toHaveBeenLastCalledWith(TESTFLIGHT);
    expect(d.reveal).not.toHaveBeenCalled();
  });

  it("stays and shows the in-review notice when there is no TestFlight link", () => {
    const d = fakeDeps();
    openApp(DEEP, d);
    // Turning visible is not leaving, so the fallback still runs.
    d.doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(2500);
    expect(d.reveal).toHaveBeenCalledWith("review");
    expect(d.navigate).toHaveBeenCalledTimes(1);
  });
});
