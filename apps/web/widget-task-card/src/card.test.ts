import { Answer, AskEyesInput, GetTaskOutput, QuoteTaskOutput, TOOLS, type ToolName } from "@eyes/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../fixtures/index.ts";
import { MockBridge } from "./bridge.ts";
import { cardView, TaskCard } from "./card.ts";
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

const ASK = FIXTURES.quote.kind === "quote" ? FIXTURES.quote.ask : null;
const TASK_A = "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b";
const TASK_B = "8b1d2c3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
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

  it("shows an allowlisted InsForge photo", () => {
    const url = "https://7t6779x4.us-east.insforge.app/api/storage/buckets/photos/objects/tasks/a.jpg";
    expect(render(withAnswer({ photo_url: url }))).toContain(`<img src="${url}"`);
  });

  it.each([
    "https://evil.example/api/storage/buckets/photos/objects/a.jpg",
    "http://7t6779x4.us-east.insforge.app/api/storage/buckets/photos/objects/a.jpg",
    "javascript:alert(1)",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "//7t6779x4.us-east.insforge.app/api/storage/buckets/photos/objects/a.jpg",
    "/api/storage/buckets/photos/objects/a.jpg",
    "https://user:pw@7t6779x4.us-east.insforge.app/api/storage/buckets/photos/objects/a.jpg",
    "https://7t6779x4.us-east.insforge.app.evil.example/api/storage/buckets/photos/objects/a.jpg",
    "https://7t6779x4.us-east.insforgе.app/api/storage/buckets/photos/objects/a.jpg",
    "https://7t6779x4-us-east.insforge.app/api/storage/buckets/photos/objects/a.jpg",
    "https://7t6779x4.us-east.insforge.app:8443/api/storage/buckets/photos/objects/a.jpg",
    "https:\\\\evil.example\\api\\storage\\buckets\\photos\\objects\\a.jpg",
    "https://7t6779x4.us-east.insforge.app/api/storage/buckets/avatars/objects/a.jpg",
    "https://7t6779x4.us-east.insforge.app/api/storage/buckets/photos/objects/../../avatars/objects/a.jpg",
    "https://7t6779x4.us-east.insforge.app/api/storage/buckets/photos/objects/",
    "https://evil.example/?u=https://7t6779x4.us-east.insforge.app/api/storage/buckets/photos/objects/a.jpg",
    "fixture:other",
    "",
  ])("falls back to the placeholder for %s", (url) => {
    const html = render(withAnswer({ photo_url: url }));
    expect(shown(html).media).toBe("map");
    expect(html).not.toContain("<img");
  });

  it("sends each button's tool call through the bridge", async () => {
    const key = "key-1";
    const sent: Record<string, unknown> = {};
    for (const [state, data] of Object.entries(FIXTURES)) {
      const bridge = new MockBridge(data);
      for (const b of cardView(data, key).buttons) {
        expect(await bridge.callTool(b.call.name, b.call.args)).toBe(`Mock call: ${b.call.name}`);
        if (b.call.name in TOOLS) TOOLS[b.call.name as ToolName].input.parse(b.call.args);
      }
      sent[state] = bridge.calls;
    }
    const reason = "Disputed from the Eyes task card";
    expect(sent).toEqual({
      quote: [{ name: "ask_eyes", args: { ...ASK, idempotency_key: key } }],
      cached: [{ name: "ask_eyes", args: { ...ASK, idempotency_key: key } }],
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
});
