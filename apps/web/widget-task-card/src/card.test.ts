import { Answer, AskEyesInput, GetTaskOutput, QuoteTaskOutput, TOOLS, type ToolName } from "@eyes/core";
import { Window } from "happy-dom";
import { act, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FIXTURES } from "../fixtures/index.ts";
import { MockBridge } from "./bridge.ts";
import { type CardView, cardTree, cardView, TaskCard } from "./card.ts";
import type { CardData, CardState } from "./types.ts";

const render = (data: CardData) =>
  renderToStaticMarkup(createElement(TaskCard, { bridge: new MockBridge(data) }));

const decode = (s: string) =>
  s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");

function shown(html: string) {
  const all = (re: RegExp) => [...html.matchAll(re)].map((m) => m.slice(1).map(decode).join(":"));
  const one = (re: RegExp) => decode(html.match(re)?.[1] ?? "");
  return {
    pills: all(/class="eyes-pill" data-tone="\w+">([^<]*)</g),
    tones: all(/class="eyes-pill" data-tone="(\w+)"/g),
    media: html.includes('aria-label="Map placeholder"')
      ? "map"
      : html.includes('aria-label="Sample photo"')
        ? "photo"
        : html.includes("<img")
          ? "img"
          : "none",
    line: one(/class="eyes-line">(?:<span class="eyes-pulse" aria-hidden="true"><\/span>)?([^<]*)</),
    pulse: html.includes("eyes-pulse"),
    note: one(/class="eyes-note">([^<]*)</),
    badges: all(/<li class="eyes-badge" data-check="\w+"><span aria-hidden="true">[^<]*<\/span>([^<]*)</g),
    checks: all(/<li class="eyes-badge" data-check="(\w+)"/g),
    footer: one(/<footer class="eyes-foot"><span>([^<]*)</),
    buttons: all(/<button [^>]*>([^<]*)<\/button>/g),
  };
}

type Props = { children?: ReactNode; onClick?: () => unknown };
const buttons = (node: ReactNode): { label: string; click: () => unknown }[] => {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<Props>(node)) return [];
  if (node.type !== "button") return buttons(node.props.children);
  return [{ label: String(node.props.children), click: node.props.onClick ?? (() => undefined) }];
};

const ASK = FIXTURES.quote.kind === "quote" ? FIXTURES.quote.ask : null;
const TASK_A = "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b";
const TASK_B = "8b1d2c3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const PHOTOS = "https://7t6779x4.us-east.insforge.app/api/storage/buckets/photos/objects/";
const KEY = "9b2f4c1e-6d3a-4f8b-a1c2-7e5d9f0b3a4c.jpg";
const OBJ = `${TASK_A}/${KEY}`;
const LIVE = ["passed", "passed", "passed"];
const PENDING = ["pending", "pending", "pending"];

const EXPECTED: Record<CardState, ReturnType<typeof shown>> = {
  quote: {
    pills: ["Quote"],
    tones: ["neutral"],
    media: "map",
    line: "3 workers nearby, ~5 min, $3.50",
    pulse: false,
    note: "",
    badges: [],
    checks: [],
    footer: "$3.00 to the worker, $0.50 fee",
    buttons: ["Confirm $3.50"],
  },
  cached: {
    pills: ["Sandbox", "Cached"],
    tones: ["neutral", "info"],
    media: "photo",
    line: "Short line, about 4 people",
    pulse: false,
    note: "",
    badges: ["GPS 38 m", "Live, 5 min ago", "Vision match"],
    checks: LIVE,
    footer: "Checked 4 min ago, free",
    buttons: ["Request fresh check ($3.50)"],
  },
  dispatched: {
    pills: ["Dispatched"],
    tones: ["info"],
    media: "map",
    line: "3 workers notified",
    pulse: true,
    note: "",
    badges: [],
    checks: [],
    footer: "$3.50 held, refunded if no one answers",
    buttons: [],
  },
  claimed: {
    pills: ["On the way"],
    tones: ["info"],
    media: "map",
    line: "Worker 120 m away, walking over",
    pulse: false,
    note: "",
    badges: [],
    checks: [],
    footer: "$3.50 held, ETA 2 min",
    buttons: [],
  },
  verifying: {
    pills: ["Verifying"],
    tones: ["warn"],
    media: "photo",
    line: "Short line, about 4 people",
    pulse: false,
    note: "",
    badges: ["GPS 38 m", "Live, 2 min ago", "Vision pending"],
    checks: PENDING,
    footer: "$3.50 held, checking the answer",
    buttons: [],
  },
  answered: {
    pills: ["Verified"],
    tones: ["good"],
    media: "photo",
    line: "Short line, about 4 people",
    pulse: false,
    note: "",
    badges: ["GPS 38 m", "Live, 2 min ago", "Vision match"],
    checks: LIVE,
    footer: "$3.50 total, answered in 4 min",
    buttons: ["Tip", "Dispute"],
  },
  needs_review: {
    pills: ["Sandbox", "Needs review"],
    tones: ["neutral", "warn"],
    media: "photo",
    line: "Line is out the door",
    pulse: false,
    note: "The photo shows the counter, not the line.",
    badges: ["GPS 52 m", "Live, 2 min ago", "Vision mismatch"],
    checks: ["passed", "passed", "failed"],
    footer: "Payout held, under review",
    buttons: ["Dispute"],
  },
  expired_refunded: {
    pills: ["Refunded"],
    tones: ["neutral"],
    media: "map",
    line: "No one available. $3.50 refunded.",
    pulse: false,
    note: "",
    badges: [],
    checks: [],
    footer: "",
    buttons: [],
  },
  rejected_safety: {
    pills: ["Can't check"],
    tones: ["neutral"],
    media: "none",
    line: "Eyes only checks public places. Try a store, venue, or line.",
    pulse: false,
    note: "That address looks like a private home, and Eyes never checks homes or people.",
    badges: [],
    checks: [],
    footer: "",
    buttons: [],
  },
  error: {
    pills: ["Error"],
    tones: ["bad"],
    media: "none",
    line: "Eyes hit a snag. Try again in a moment.",
    pulse: false,
    note: "The Eyes server did not answer in time.",
    badges: [],
    checks: [],
    footer: "",
    buttons: ["Retry"],
  },
};

const withAnswer = (patch: Partial<Answer>): CardData => {
  const data = structuredClone(FIXTURES.answered);
  if (data.kind === "task" && data.task.answer) Object.assign(data.task.answer, patch);
  return data;
};

const variant = (state: CardState, patch: object, taskPatch: object = {}): CardData => {
  const data = structuredClone(FIXTURES[state]);
  Object.assign(data, patch);
  if (data.kind === "task") Object.assign(data.task, taskPatch);
  return data;
};

describe("task card", () => {
  it.each(Object.keys(EXPECTED) as CardState[])("renders the %s fixture", (state) => {
    const html = render(FIXTURES[state]);
    expect(html).toContain(`data-state="${state}"`);
    expect(shown(html)).toEqual(EXPECTED[state]);
  });

  it("fixtures carry the real core tool shapes", () => {
    for (const data of Object.values(FIXTURES)) {
      if (data.kind === "quote") QuoteTaskOutput.parse(data.quote);
      if (data.kind === "quote" || data.kind === "cached")
        AskEyesInput.parse({ ...data.ask, idempotency_key: "k" });
      if (data.kind === "cached") Answer.parse(data.answer);
      if (data.kind === "task") GetTaskOutput.parse(data.task);
      if (data.kind === "error") TOOLS[data.retry.name as ToolName].input.parse(data.retry.args);
    }
  });

  it("renders untrusted strings as text, never as markup", () => {
    const evil = `<script>alert(1)</script><img src=x onerror="alert(2)">`;
    const reason = { ...FIXTURES.rejected_safety, reason: evil } as CardData;
    for (const html of [render(withAnswer({ answer_text: evil })), render(reason)]) {
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<img src=x");
      expect(html).toContain(
        "&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=&quot;alert(2)&quot;&gt;",
      );
      expect(`${shown(html).line}${shown(html).note}`).toContain(evil);
    }
  });

  it.each([`${PHOTOS}${TASK_A}%2F${KEY}`, `${PHOTOS}${TASK_A}/${KEY}`])(
    "shows the InsForge photo %s",
    (url) => {
      expect(render(withAnswer({ photo_url: url }))).toContain(`<img src="${url}"`);
    },
  );

  it.each([
    `https://evil.example/api/storage/buckets/photos/objects/${OBJ}`,
    `http://7t6779x4.us-east.insforge.app/api/storage/buckets/photos/objects/${OBJ}`,
    "javascript:alert(1)",
    "data:image/svg+xml,<svg onload=alert(1)>",
    `//7t6779x4.us-east.insforge.app/api/storage/buckets/photos/objects/${OBJ}`,
    `/api/storage/buckets/photos/objects/${OBJ}`,
    `https://user:pw@7t6779x4.us-east.insforge.app/api/storage/buckets/photos/objects/${OBJ}`,
    `https://user@7t6779x4.us-east.insforge.app/api/storage/buckets/photos/objects/${OBJ}`,
    `https://:pw@7t6779x4.us-east.insforge.app/api/storage/buckets/photos/objects/${OBJ}`,
    `https://7t6779x4.us-east.insforge.app.evil.example/api/storage/buckets/photos/objects/${OBJ}`,
    `https://7t6779x4.us-east.insforgе.app/api/storage/buckets/photos/objects/${OBJ}`,
    `https://7t6779x4-us-east.insforge.app/api/storage/buckets/photos/objects/${OBJ}`,
    `https://7t6779x4.us-east.insforge.app:8443/api/storage/buckets/photos/objects/${OBJ}`,
    `https:\\\\evil.example\\api\\storage\\buckets\\photos\\objects\\${TASK_A}\\${KEY}`,
    `https://evil.example/?u=${PHOTOS}${OBJ}`,
    `https://7t6779x4.us-east.insforge.app/api/storage/buckets/avatar/objects/${OBJ}`,
    `${PHOTOS}../../avatars/objects/${OBJ}`,
    `${PHOTOS}`,
    `${PHOTOS}..%2f..%2favatars%2fobjects%2f${TASK_A}%2f${KEY}`,
    `${PHOTOS}%252e%252e/%252e%252e/avatars/objects/a.jpg`,
    `${PHOTOS}${TASK_A}%5c${KEY}`,
    `${PHOTOS}${OBJ}%2f..%2f..%2favatars%2fa.jpg`,
    `${PHOTOS}${OBJ}.png`,
    `${PHOTOS}${TASK_A}/${KEY.replace(".jpg", ".svg")}`,
    `${PHOTOS}${KEY}`,
    `${PHOTOS}a.jpg`,
    "fixture:other",
    "",
  ])("falls back to the placeholder for %s", (url) => {
    const html = render(withAnswer({ photo_url: url }));
    expect(shown(html).media).toBe("map");
    expect(html).not.toContain("<img");
  });

  it("each rendered button sends its call through the bridge and toasts it", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sent: Record<string, unknown> = {};
    for (const [state, data] of Object.entries(FIXTURES)) {
      const bridge = new MockBridge(data);
      const toasts: string[] = [];
      const view = cardView(data, "key-1");
      const tree = cardTree({
        view,
        theme: "light",
        sandbox: false,
        toast: null,
        bridge,
        onToast: (t) => toasts.push(t),
      });
      const shownButtons = buttons(tree);
      expect(shownButtons.map((b) => b.label)).toEqual(EXPECTED[state as CardState].buttons);
      for (const b of shownButtons) await b.click();
      const lines = bridge.calls.map((c) => `Mock call: ${c.name} ${JSON.stringify(c.args)}`);
      expect(toasts).toEqual(lines);
      for (const line of lines) expect(info).toHaveBeenCalledWith(line);
      for (const c of bridge.calls) if (c.name in TOOLS) TOOLS[c.name as ToolName].input.parse(c.args);
      sent[state] = bridge.calls;
    }
    info.mockRestore();
    const reason = "Disputed from the Eyes task card";
    expect(sent).toEqual({
      quote: [{ name: "ask_eyes", args: { ...ASK, idempotency_key: "key-1" } }],
      cached: [{ name: "ask_eyes", args: { ...ASK, idempotency_key: "key-1" } }],
      dispatched: [],
      claimed: [],
      verifying: [],
      answered: [
        { name: "tip_worker", args: { task_id: TASK_A } },
        { name: "dispute_answer", args: { task_id: TASK_A, reason } },
      ],
      needs_review: [{ name: "dispute_answer", args: { task_id: TASK_B, reason } }],
      expired_refunded: [],
      rejected_safety: [],
      error: [FIXTURES.error.kind === "error" && FIXTURES.error.retry],
    });
  });

  it("passes the theme and the toast through to the card", () => {
    const view = cardView(FIXTURES.answered, "key-1");
    const bridge = new MockBridge(FIXTURES.answered);
    for (const theme of ["light", "dark"] as const) {
      const props = { view, theme, sandbox: false, toast: "Sent", bridge, onToast: () => undefined };
      const html = renderToStaticMarkup(cardTree(props));
      expect(html).toContain(`<article class="eyes-card" data-theme="${theme}"`);
      expect(html).toContain('<p class="eyes-toast" role="status">Sent</p>');
      const mounted = renderToStaticMarkup(
        createElement(TaskCard, { bridge: new MockBridge(FIXTURES.answered, theme) }),
      );
      expect(mounted).toContain(`<article class="eyes-card" data-theme="${theme}"`);
    }
  });

  it("toasts the error when a bridge call fails", async () => {
    const bridge = {
      ...new MockBridge(FIXTURES.error),
      callTool: () => Promise.reject(new Error("offline")),
    };
    const toasts: string[] = [];
    const view = cardView(FIXTURES.error, "key-1");
    const tree = cardTree({
      view,
      theme: "dark",
      sandbox: false,
      toast: null,
      bridge,
      onToast: (t) => toasts.push(t),
    });
    for (const b of buttons(tree)) await b.click();
    expect(toasts).toEqual(["offline"]);
  });

  it("toasts a generic message when a bridge call fails without an Error", async () => {
    const bridge = { ...new MockBridge(FIXTURES.error), callTool: () => Promise.reject("nope") };
    const toasts: string[] = [];
    const view = cardView(FIXTURES.error, "key-1");
    const props = { view, theme: "dark" as const, sandbox: false, toast: null, bridge };
    for (const b of buttons(cardTree({ ...props, onToast: (t) => toasts.push(t) }))) await b.click();
    expect(toasts).toEqual(["Something went wrong"]);
  });

  it.each<[string, CardData, Partial<CardView>]>([
    [
      "a check done just now",
      variant("cached", { as_of: "2026-10-17T18:02:00Z" }),
      { footer: "Checked just now, free" },
    ],
    [
      "a check hours ago",
      variant("cached", { as_of: "2026-10-17T21:02:00Z" }),
      { footer: "Checked 3 h ago, free" },
    ],
    [
      "no notified count",
      variant("dispatched", { workers_notified: undefined }),
      { line: "Workers notified" },
    ],
    [
      "no worker yet",
      variant("claimed", { worker: undefined }),
      { line: "A worker is on the way", footer: "$3.50 held" },
    ],
    [
      "a paid task without an answer",
      variant("answered", {}, { answer: null }),
      { line: "Answer in, checking it", footer: "$3.50 total", badges: [] },
    ],
    ["a yes answer", withAnswer({ answer_bool: true }), { line: "Yes. Short line, about 4 people" }],
    ["a no answer", withAnswer({ answer_bool: false }), { line: "No. Short line, about 4 people" }],
    [
      "a disputed task",
      variant("needs_review", {}, { status: "disputed" }),
      { pill: ["Disputed", "warn"], note: "The photo shows the counter, not the line.", buttons: [] },
    ],
    [
      "a disputed task without an answer",
      variant("needs_review", {}, { status: "disputed", answer: null }),
      { note: null },
    ],
    [
      "a review without an answer",
      variant("needs_review", {}, { answer: null }),
      { pill: ["Needs review", "warn"], note: null },
    ],
    [
      "a cancelled task",
      variant("expired_refunded", {}, { status: "refunded" }),
      { line: "Cancelled. $3.50 refunded." },
    ],
  ])("shows %s", (_, data, expected) => {
    expect(cardView(data, "key-1")).toMatchObject(expected);
  });

  it("counts a single nearby worker and drops a missing ETA", () => {
    const data = structuredClone(FIXTURES.quote);
    if (data.kind === "quote") Object.assign(data.quote, { workers_nearby: 1, est_minutes_to_answer: null });
    expect(cardView(data, "key-1").line).toMatch(/^1 worker nearby, \$\d+\.\d\d$/);
  });

  it("labels a stale capture", () => {
    const data = withAnswer({});
    if (data.kind === "task" && data.task.answer) data.task.answer.verification.fresh_ok = false;
    expect(cardView(data, "key-1").badges[1]).toEqual({ label: "Stale, 2 min ago", check: "failed" });
  });

  it("clears the toast after 4s and swaps a broken photo for the map", async () => {
    const win = new Window();
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", win.document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { createRoot } = await import("react-dom/client");
    const el = win.document.createElement("div");
    win.document.body.appendChild(el);
    const root = createRoot(el as unknown as Element);
    const url = `${PHOTOS}${OBJ}`;
    try {
      await act(async () =>
        root.render(createElement(TaskCard, { bridge: new MockBridge(withAnswer({ photo_url: url })) })),
      );
      await act(async () => el.querySelector("button")?.click());
      expect(el.querySelector(".eyes-toast")?.textContent).toMatch(/^Mock call: tip_worker/);
      await act(async () => vi.advanceTimersByTime(4000));
      expect(el.querySelector(".eyes-toast")).toBeNull();

      const img = el.querySelector("img");
      expect(img?.getAttribute("src")).toBe(url);
      await act(async () => img?.dispatchEvent(new win.Event("error")));
      expect(el.querySelector("img")).toBeNull();
      expect(el.querySelector('[aria-label="Map placeholder"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      info.mockRestore();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      await win.happyDOM.close();
    }
  });
});
