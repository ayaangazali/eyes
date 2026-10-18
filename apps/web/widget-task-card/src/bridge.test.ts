import { describe, expect, it, vi } from "vitest";
import { FIXTURES } from "../fixtures/index.ts";
import { HostBridge, MockBridge } from "./bridge.ts";

describe("MockBridge", () => {
  it("notifies subscribers on update until they unsubscribe", () => {
    const bridge = new MockBridge(FIXTURES.quote);
    const cb = vi.fn();
    const off = bridge.onUpdate(cb);
    bridge.update(FIXTURES.answered);
    expect(bridge.getToolOutput()).toBe(FIXTURES.answered);
    expect(bridge.getTheme()).toBe("light");
    bridge.update(FIXTURES.error, "dark");
    expect(bridge.getTheme()).toBe("dark");
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    bridge.update(FIXTURES.quote);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(bridge.getTheme()).toBe("dark");
  });

  it("plays steps on an interval and stops at the end or when cancelled", () => {
    vi.useFakeTimers();
    const bridge = new MockBridge(FIXTURES.quote);
    bridge.play([FIXTURES.dispatched, FIXTURES.claimed, FIXTURES.answered], 100);
    expect(bridge.getToolOutput()).toBe(FIXTURES.dispatched);
    vi.advanceTimersByTime(100);
    expect(bridge.getToolOutput()).toBe(FIXTURES.claimed);
    vi.advanceTimersByTime(100);
    expect(bridge.getToolOutput()).toBe(FIXTURES.answered);
    expect(vi.getTimerCount()).toBe(0);

    const stop = bridge.play([FIXTURES.quote, FIXTURES.error], 100);
    stop();
    vi.advanceTimersByTime(500);
    expect(bridge.getToolOutput()).toBe(FIXTURES.quote);

    bridge.play([], 100);
    expect(bridge.getToolOutput()).toBe(FIXTURES.quote);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe("HostBridge", () => {
  it("throws until wired to the host", () => {
    expect(() => HostBridge.getTheme()).toThrow("W2: HostBridge is not wired");
  });
});
