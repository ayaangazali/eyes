import { describe, expect, it, vi } from "vitest";
import { type CopyStatus, wireCopy } from "./automation.ts";

function fakeButton(copy?: string) {
  const handlers: Array<() => Promise<void>> = [];
  return {
    dataset: copy === undefined ? {} : { copy },
    addEventListener: vi.fn((_type: "click", handler: () => Promise<void>) => {
      handlers.push(handler);
    }),
    click: () => Promise.all(handlers.map((h) => h())),
  };
}

function freshStatus(): CopyStatus {
  return { textContent: "", hidden: true };
}

describe("wireCopy", () => {
  it("writes the button's text to the clipboard and shows it trimmed", async () => {
    const button = fakeButton("  shortcut steps  ");
    const status = freshStatus();
    const write = vi.fn(async (_text: string) => {});
    wireCopy([button], status, write);
    await button.click();
    expect(write).toHaveBeenCalledWith("  shortcut steps  ");
    expect(status).toEqual({ textContent: "Copied: shortcut steps", hidden: false });
  });

  it("wires every button and keeps each button's own text", async () => {
    const first = fakeButton("first");
    const second = fakeButton("second");
    const status = freshStatus();
    const write = vi.fn(async (_text: string) => {});
    wireCopy([first, second], status, write);
    expect(first.addEventListener).toHaveBeenCalledTimes(1);
    expect(second.addEventListener).toHaveBeenCalledTimes(1);
    await second.click();
    expect(write).toHaveBeenCalledWith("second");
    expect(status.textContent).toBe("Copied: second");
  });

  it("wires nothing and writes nothing when the page has no copy buttons", () => {
    const status = freshStatus();
    const write = vi.fn(async (_text: string) => {});
    wireCopy([], status, write);
    expect(write).not.toHaveBeenCalled();
    expect(status).toEqual({ textContent: "", hidden: true });
  });

  it("copies an empty string and says so when a button has no data-copy", async () => {
    const button = fakeButton();
    const status = freshStatus();
    const write = vi.fn(async (_text: string) => {});
    wireCopy([button], status, write);
    await button.click();
    expect(write).toHaveBeenCalledWith("");
    expect(status).toEqual({ textContent: "Copied: ", hidden: false });
  });

  it("leaves the status hidden and rejects when the clipboard write fails", async () => {
    const button = fakeButton("code");
    const status = freshStatus();
    const write = vi.fn(async (_text: string) => {
      throw new Error("clipboard denied");
    });
    wireCopy([button], status, write);
    await expect(button.click()).rejects.toThrow("clipboard denied");
    expect(status).toEqual({ textContent: "", hidden: true });
  });
});
