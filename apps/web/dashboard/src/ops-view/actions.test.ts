import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import { type Action, actionArea, createToaster, type Outcome } from "./actions.ts";

const windows: Window[] = [];
afterEach(async () => {
  for (const w of windows.splice(0)) await w.happyDOM.close();
});
const tick = () => new Promise<void>((r) => queueMicrotask(r));

function mount(over: { required?: boolean; more?: Action[]; run?: (note: string) => Promise<Outcome> } = {}) {
  const happy = new Window();
  windows.push(happy);
  const doc = happy.document as unknown as Document;
  const toasts: string[] = [];
  const notes: string[] = [];
  const run =
    over.run ??
    (async (note: string) => {
      notes.push(note);
      return { ok: true, message: "Done." };
    });
  const area = actionArea(doc, {
    id: "t1",
    primary: { label: "Release", confirm: "Pay $5?", verb: "Release $5", tone: "primary", run },
    more: over.more ?? [
      { label: "Refund", confirm: "Refund $6?", verb: "Refund $6", tone: "danger", run },
      { label: "Close", confirm: "Close it?", verb: "Close", tone: "ghost", run },
    ],
    note: { label: "Note", hint: "Texted to the worker.", required: over.required ?? false },
    toast: (m) => toasts.push(m),
  });
  doc.body.append(area);
  const button = (text: string) =>
    [...area.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;
  const key = (el: Element, k: string) =>
    el.dispatchEvent(
      new happy.KeyboardEvent("keydown", { key: k, cancelable: true, bubbles: true }) as unknown as Event,
    );
  return { happy, doc, area, button, key, toasts, notes };
}

describe("actionArea", () => {
  it("labels the note, ties the hint to it, and grows it as you type", () => {
    const { area, happy } = mount();
    const note = area.querySelector("textarea") as HTMLTextAreaElement;
    expect([area.querySelector("label")?.htmlFor, note.id]).toEqual(["t1-note", "t1-note"]);
    expect(note.getAttribute("aria-describedby")).toBe("t1-note-hint");
    Object.defineProperty(note, "scrollHeight", { value: 88 });
    note.dispatchEvent(new happy.Event("input") as unknown as Event);
    expect(note.style.height).toBe("88px");
  });

  it("confirms inline, runs with the trimmed note, then locks with the result and a toast", async () => {
    const { area, button, toasts, notes, doc } = mount();
    (area.querySelector("textarea") as HTMLTextAreaElement).value = "  ok  ";
    button("Release").click();
    expect(area.querySelector(".decide__question")?.textContent).toBe("Pay $5?");
    expect(doc.activeElement).toBe(button("Release $5"));
    button("Release $5").click();
    expect(button("Release $5…").disabled).toBe(true);
    await tick();
    await tick();
    expect(notes).toEqual(["ok"]);
    expect(area.querySelector(".decide__status")?.className).toBe("decide__status is-ok");
    expect(area.querySelector(".decide__status")?.textContent).toBe("Done.");
    expect(area.querySelectorAll(".decide__row button")).toHaveLength(0);
    expect((area.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
    expect(toasts).toEqual(["Done."]);
  });

  it("needs a note when required, and cancels by button or Escape", () => {
    const { area, button, key, doc } = mount({ required: true });
    button("Release").click();
    const note = area.querySelector("textarea") as HTMLTextAreaElement;
    expect(area.querySelector(".decide__status")?.className).toBe("decide__status is-error");
    expect(area.querySelector(".decide__status")?.textContent).toBe(
      "Write a note first. Texted to the worker.",
    );
    expect(doc.activeElement).toBe(note);
    note.value = "x";
    button("Release").click();
    expect(area.querySelector(".decide__status")?.textContent).toBe("");
    button("Cancel").click();
    expect(area.querySelector(".decide__question")).toBeNull();
    button("Release").click();
    key(button("Release $5"), "a");
    expect(area.querySelector(".decide__question")).toBeTruthy();
    key(button("Release $5"), "Escape");
    expect(area.querySelector(".decide__question")).toBeNull();
    expect(area.querySelector(".decide__row.is-confirming")).toBeNull();
  });

  it("shows a failure, or a thrown error, and keeps the actions", async () => {
    let outcome: () => Promise<Outcome> = async () => ({ ok: false, message: "Failed: 502" });
    const { area, button } = mount({ run: () => outcome() });
    const status = () => area.querySelector(".decide__status")?.textContent;
    button("Release").click();
    button("Release $5").click();
    await tick();
    await tick();
    expect(status()).toBe("Failed: 502");
    expect(button("Release")).toBeTruthy();
    outcome = () => Promise.reject(new Error("offline"));
    button("Release").click();
    button("Release $5").click();
    await tick();
    await tick();
    expect(status()).toBe("Failed: offline");
    outcome = () => Promise.reject("raw");
    button("Release").click();
    button("Release $5").click();
    await tick();
    await tick();
    expect(status()).toBe("Failed: raw");
  });

  it("keeps secondary actions in a keyboard menu", () => {
    const { area, button, key, doc } = mount();
    const toggle = button("More actions");
    const menu = area.querySelector("[role=menu]") as HTMLElement;
    expect([toggle.getAttribute("aria-haspopup"), toggle.getAttribute("aria-expanded"), menu.hidden]).toEqual(
      ["menu", "false", true],
    );
    toggle.click();
    const items = [...menu.querySelectorAll("[role=menuitem]")] as HTMLButtonElement[];
    expect([toggle.getAttribute("aria-expanded"), menu.hidden, doc.activeElement]).toEqual([
      "true",
      false,
      items[0],
    ]);
    expect(items.map((i) => i.className)).toEqual(["decide__item is-danger", "decide__item is-ghost"]);
    key(menu, "ArrowDown");
    expect(doc.activeElement).toBe(items[1]);
    key(menu, "ArrowDown");
    expect(doc.activeElement).toBe(items[0]);
    key(menu, "ArrowUp");
    expect(doc.activeElement).toBe(items[1]);
    key(menu, "Home");
    expect(doc.activeElement).toBe(items[0]);
    key(menu, "End");
    expect(doc.activeElement).toBe(items[1]);
    key(menu, "x");
    key(menu, "Escape");
    expect([menu.hidden, doc.activeElement]).toEqual([true, toggle]);
    toggle.click();
    toggle.click();
    expect(menu.hidden).toBe(true);
    toggle.click();
    items[0]?.click();
    expect(area.querySelector(".decide__question")?.textContent).toBe("Refund $6?");
    // A danger action confirms with a danger button; a quiet one with the primary button.
    expect(button("Refund $6").className).toBe("ui-button ui-button--sm ui-button--danger");
    button("Cancel").click();
    button("More actions").click();
    (area.querySelectorAll("[role=menuitem]")[1] as HTMLElement).click();
    expect(button("Close").className).toBe("ui-button ui-button--sm ui-button--primary");
  });

  it("has no menu when there is only one action", () => {
    const { area } = mount({ more: [] });
    expect(area.querySelector("[role=menu]")).toBeNull();
  });
});

describe("createToaster", () => {
  it("shows one toast at a time, closes it after 4 s, and pauses while the tab is hidden", () => {
    const happy = new Window();
    windows.push(happy);
    const doc = happy.document as unknown as Document;
    const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
    const later = (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    };
    const show = createToaster(doc, later);
    const region = doc.querySelector(".toasts") as HTMLElement;
    expect([region.getAttribute("role"), region.getAttribute("aria-live")]).toEqual(["status", "polite"]);
    const hidden = (value: boolean) => {
      Object.defineProperty(doc, "visibilityState", {
        value: value ? "hidden" : "visible",
        configurable: true,
      });
      doc.dispatchEvent(new happy.Event("visibilitychange") as unknown as Event);
    };
    hidden(true);
    expect(timers).toHaveLength(0);
    show("First");
    show("Second");
    expect(region.textContent).toBe("Second");
    expect(timers.map((t) => [t.ms, t.cancelled])).toEqual([
      [4000, true],
      [4000, false],
    ]);
    hidden(true);
    expect(timers[1]?.cancelled).toBe(true);
    hidden(false);
    expect(timers[2]?.ms).toBeLessThanOrEqual(4000);
    timers[2]?.fn();
    expect(region.firstElementChild?.classList.contains("is-leaving")).toBe(true);
    hidden(true);
    expect(timers).toHaveLength(4);
    timers[3]?.fn();
    expect(region.textContent).toBe("");
  });
});
