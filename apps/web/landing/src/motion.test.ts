import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COPIED_HINT, createFlight, SWAP_MS, wireCopy } from "./motion.ts";

function fakeClassList(initial: string[] = []) {
  const names = new Set(initial);
  return {
    names,
    add: (name: string) => {
      names.add(name);
    },
    remove: (name: string) => {
      names.delete(name);
    },
    toggle: (name: string, force: boolean) => {
      if (force) names.add(name);
      else names.delete(name);
      return force;
    },
  };
}

function fakeButton() {
  let handler: (() => Promise<void>) | undefined;
  return {
    addEventListener: vi.fn((_type: "click", h: () => Promise<void>) => {
      handler = h;
    }),
    click: async () => {
      await handler?.();
    },
  };
}

describe("wireCopy", () => {
  it("writes the connect command and then shows the hint", async () => {
    const button = fakeButton();
    const hint = { textContent: "" };
    const write = vi.fn(async (_text: string) => {});
    wireCopy(button, { textContent: "eyes connect --key k" }, hint, write);
    expect(button.addEventListener).toHaveBeenCalledWith("click", expect.any(Function));
    await button.click();
    expect(write).toHaveBeenCalledWith("eyes connect --key k");
    expect(hint.textContent).toBe(COPIED_HINT);
  });

  it("does nothing when the copy button is missing", () => {
    const hint = { textContent: "" };
    const write = vi.fn(async (_text: string) => {});
    expect(() => wireCopy(null, { textContent: "x" }, hint, write)).not.toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(hint.textContent).toBe("");
  });

  it("copies an empty string when the connect element is missing", async () => {
    const button = fakeButton();
    const hint = { textContent: "" };
    const write = vi.fn(async (_text: string) => {});
    wireCopy(button, null, hint, write);
    await button.click();
    expect(write).toHaveBeenCalledWith("");
    expect(hint.textContent).toBe(COPIED_HINT);
  });

  it("copies an empty string when the connect element has no text", async () => {
    const button = fakeButton();
    const write = vi.fn(async (_text: string) => {});
    wireCopy(button, { textContent: null }, { textContent: "" }, write);
    await button.click();
    expect(write).toHaveBeenCalledWith("");
  });

  it("leaves the hint unchanged and rejects when the clipboard write fails", async () => {
    const button = fakeButton();
    const hint = { textContent: "before" };
    const write = vi.fn(async (_text: string) => {
      throw new Error("clipboard denied");
    });
    wireCopy(button, { textContent: "cmd" }, hint, write);
    await expect(button.click()).rejects.toThrow("clipboard denied");
    expect(hint.textContent).toBe("before");
  });
});

const ROW_STATES = [
  { hl: "a", state: "Locked" },
  { hl: "b", state: "Sent" },
  { hl: "c", state: "Waiting" },
];

function setup(rowData = ROW_STATES) {
  const panel = { dataset: {} as Record<string, string | undefined> };
  const status = {
    textContent: "Initial" as string | null,
    classList: fakeClassList(),
    getBoundingClientRect: vi.fn(),
  };
  const steps = ["a", "b", "c"].map((step) => ({ dataset: { step }, classList: fakeClassList() }));
  const rows = rowData.map((r) => ({ dataset: { hl: r.hl, state: r.state } }));
  const flight = createFlight({ panel, status, steps, rows });
  return { panel, status, steps, rows, flight };
}

describe("createFlight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts on the last row, so showing it again does nothing", () => {
    const { panel, status, flight } = setup();
    flight.show(2);
    expect(panel.dataset.step).toBeUndefined();
    expect(status.classList.names.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("moves the panel, lights only the highlighted step, and starts the exit at once", () => {
    const { panel, status, steps, flight } = setup();
    flight.show(0);
    expect(panel.dataset.step).toBe("0");
    expect(steps.map((s) => s.classList.names.has("is-now"))).toEqual([true, false, false]);
    expect(status.classList.names.has("is-exit")).toBe(true);
    expect(status.textContent).toBe("Initial");
  });

  it("swaps the label and replays the enter state after SWAP_MS", () => {
    const { status, flight } = setup();
    flight.show(1);
    vi.advanceTimersByTime(SWAP_MS - 1);
    expect(status.textContent).toBe("Initial");
    vi.advanceTimersByTime(1);
    expect(status.textContent).toBe("Sent");
    expect(status.classList.names.has("is-exit")).toBe(false);
    expect(status.classList.names.has("is-enter-start")).toBe(false);
    expect(status.getBoundingClientRect).toHaveBeenCalledTimes(1);
  });

  it("uses an empty label when the row has no state", () => {
    const { status, flight } = setup([
      { hl: "a", state: undefined as unknown as string },
      { hl: "b", state: "Sent" },
    ]);
    flight.show(0);
    vi.advanceTimersByTime(SWAP_MS);
    expect(status.textContent).toBe("");
  });

  it("shows the latest row when two changes land before the timer fires", () => {
    const { status, flight } = setup();
    flight.show(0);
    flight.show(1);
    vi.advanceTimersByTime(SWAP_MS);
    expect(status.textContent).toBe("Sent");
  });

  it("lights no step when the row highlights none", () => {
    const { steps, flight } = setup([
      { hl: undefined as unknown as string, state: "Locked" },
      { hl: "b", state: "Sent" },
    ]);
    flight.show(0);
    expect(steps.some((s) => s.classList.names.has("is-now"))).toBe(false);
  });

  it("can move back to an earlier row", () => {
    const { panel, steps, flight } = setup();
    flight.show(0);
    flight.show(2);
    expect(panel.dataset.step).toBe("2");
    expect(steps.map((s) => s.classList.names.has("is-now"))).toEqual([false, false, true]);
  });
});
