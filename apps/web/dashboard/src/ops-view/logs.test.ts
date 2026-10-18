import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import { badgeIcon, eventDetail, eventKey, levelOf, mergeEvents, sourceOf } from "./logs.ts";

const windows: Window[] = [];
afterEach(async () => {
  for (const w of windows.splice(0)) await w.happyDOM.close();
});
const doc = () => {
  const happy = new Window();
  windows.push(happy);
  return happy.document as unknown as Document;
};
const ev = (id: number | undefined, summary = `e${id}`) => ({
  id,
  at: "2026-10-17T12:00:00Z",
  kind: "http",
  level: "info",
  summary,
});

describe("logs", () => {
  it("names levels and sources plainly, unknown ones as they are", () => {
    expect(levelOf("warn")).toEqual(["Warning", "i-alert"]);
    expect(levelOf("trace")).toEqual(["trace", "i-info"]);
    expect(sourceOf("text")).toEqual(["Texting", "i-message"]);
    expect(sourceOf("carrier")).toEqual(["carrier", "i-info"]);
    const span = badgeIcon(doc(), sourceOf("email"), "ev-source");
    expect([span.className, span.querySelector("svg")?.getAttribute("aria-label")]).toEqual([
      "ev-source",
      "Email",
    ]);
  });

  it("merges pages and live events newest first, each once, keyed by id or by content without one", () => {
    expect(eventKey(ev(4))).toBe("4");
    expect(eventKey(ev(undefined, "x"))).toBe("2026-10-17T12:00:00Z http x");
    const merged = mergeEvents([ev(5), ev(4)], [ev(4), ev(3), ev(undefined, "x"), ev(undefined, "x")]);
    expect(merged.map((e) => e.summary)).toEqual(["e5", "e4", "e3", "x"]);
  });

  it("shows the full summary, a task filter and the data in an event's details", () => {
    const d = doc();
    const picked: string[] = [];
    const box = eventDetail(
      d,
      { ...ev(1, "long summary"), task_id: "11111111-2222", data: { status: 500 } },
      (id) => picked.push(id),
    );
    expect(box.querySelector(".ev-detail__summary")?.textContent).toBe("long summary");
    const button = box.querySelector("button") as HTMLButtonElement;
    expect(button.textContent).toBe("Only task 11111111");
    let bubbled = false;
    d.body.append(box);
    d.body.addEventListener("click", () => {
      bubbled = true;
    });
    button.click();
    expect([picked, bubbled]).toEqual([["11111111-2222"], false]);
    expect(box.querySelector("pre")?.textContent).toBe('{\n  "status": 500\n}');
    const bare = eventDetail(d, { ...ev(2), data: {} }, () => {});
    expect([bare.querySelector("button"), bare.querySelector("pre")]).toEqual([null, null]);
  });
});
