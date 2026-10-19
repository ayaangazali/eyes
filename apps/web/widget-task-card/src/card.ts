import type { Answer, TaskStatus } from "@eyes/core";
import { createElement as h, type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import type { WidgetBridge } from "./bridge.ts";
import { FIXTURE_PHOTO, safePhotoUrl } from "./photo.ts";
import type { AskArgs, CardData, CardState, Check, Theme, ToolCall } from "./types.ts";

type Tone = "neutral" | "info" | "good" | "warn" | "bad";
type Media = { kind: "map" } | { kind: "photo"; src: string } | null;
type Button = { label: string; call: ToolCall; primary?: boolean };

export type CardView = {
  state: CardState;
  pill: [label: string, tone: Tone];
  media: Media;
  line: string;
  note: string | null;
  pulse: boolean;
  badges: { label: string; check: Check }[];
  footer: string;
  buttons: Button[];
};

const STAGE = {
  dispatched: "dispatched",
  claimed: "claimed",
  submitted: "verifying",
  verified: "answered",
  paid: "answered",
  needs_review: "needs_review",
  disputed: "needs_review",
  expired: "expired_refunded",
  refunded: "expired_refunded",
} as const satisfies Record<TaskStatus, CardState>;

const usd = (amount: number) => `$${amount.toFixed(2)}`;
const minutes = (from: string, to: string) =>
  Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
const ago = (from: string, to: string) => {
  const m = minutes(from, to);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const answerLine = (a: Answer) =>
  `${a.answer_bool === null ? "" : a.answer_bool ? "Yes. " : "No. "}${a.answer_text}`;
const photo = (a: Answer | null): Media => {
  const src = safePhotoUrl(a?.photo_url ?? null);
  return src ? { kind: "photo", src } : { kind: "map" };
};
const ask = (args: AskArgs, key: string): ToolCall => ({
  name: "ask_eyes",
  args: { ...args, idempotency_key: key },
});

function badges(a: Answer, asOf: string, pending: boolean): CardView["badges"] {
  const v = a.verification;
  const check = (ok: boolean): Check => (pending ? "pending" : ok ? "passed" : "failed");
  return [
    { label: `GPS ${Math.round(a.worker_distance_m)} m`, check: check(v.gps_ok) },
    {
      label: `${pending || v.fresh_ok ? "Live" : "Stale"}, ${ago(a.captured_at, asOf)}`,
      check: check(v.fresh_ok),
    },
    {
      label: pending ? "Vision pending" : v.vision_ok ? "Vision match" : "Vision mismatch",
      check: check(v.vision_ok),
    },
  ];
}

export function cardView(data: CardData, key: string): CardView {
  const base = { note: null, pulse: false, badges: [], footer: "", buttons: [] };
  if (data.kind === "quote") {
    const total = usd(data.ask.bounty_usd + data.fee_usd);
    const { workers_nearby, est_minutes_to_answer: eta } = data.quote;
    const parts = [
      `${count(workers_nearby, "worker")} nearby`,
      eta === null ? "" : `~${Math.round(eta)} min`,
      total,
    ];
    return {
      ...base,
      state: "quote",
      pill: ["Quote", "neutral"],
      media: { kind: "map" },
      line: parts.filter(Boolean).join(", "),
      footer: `${usd(data.ask.bounty_usd)} to the worker, ${usd(data.fee_usd)} fee`,
      buttons: [{ label: `Confirm ${total}`, call: ask(data.ask, key), primary: true }],
    };
  }
  if (data.kind === "cached") {
    return {
      ...base,
      state: "cached",
      pill: ["Cached", "info"],
      media: photo(data.answer),
      line: answerLine(data.answer),
      badges: badges(data.answer, data.as_of, false),
      footer: `Checked ${ago(data.checked_at, data.as_of)}, free`,
      buttons: [
        {
          label: `Request fresh check (${usd(data.ask.bounty_usd + data.fee_usd)})`,
          call: ask(data.ask, key),
        },
      ],
    };
  }
  if (data.kind === "rejected") {
    return {
      ...base,
      state: "rejected_safety",
      pill: ["Can't check", "neutral"],
      media: null,
      line: "Eyes only checks public places. Try a store, venue, or line.",
      note: data.reason,
    };
  }
  if (data.kind === "error") {
    return {
      ...base,
      state: "error",
      pill: ["Error", "bad"],
      media: null,
      line: "Eyes hit a snag. Try again in a moment.",
      note: data.message,
      buttons: [{ label: "Retry", call: data.retry, primary: true }],
    };
  }

  const { task } = data;
  const total = usd(task.bounty_usd + task.fee_usd);
  const state = STAGE[task.status];
  const a = task.answer;
  const dispute: Button = {
    label: "Dispute",
    call: {
      name: "dispute_answer",
      args: { task_id: task.task_id, reason: "Disputed from the Eyes task card" },
    },
  };
  const answered = {
    ...base,
    state,
    media: photo(a),
    line: a ? answerLine(a) : "Answer in, checking it",
    badges: a ? badges(a, data.as_of, state === "verifying") : [],
  };
  switch (state) {
    case "dispatched":
      return {
        ...base,
        state,
        pill: ["Dispatched", "info"],
        media: { kind: "map" },
        line:
          data.workers_notified === undefined
            ? "Workers notified"
            : `${count(data.workers_notified, "worker")} notified`,
        pulse: true,
        footer: `${total} held, refunded if no one answers`,
      };
    case "claimed":
      return {
        ...base,
        state,
        pill: ["On the way", "info"],
        media: { kind: "map" },
        line: data.worker
          ? `Worker ${Math.round(data.worker.distance_m)} m away, walking over`
          : "A worker is on the way",
        footer: data.worker
          ? `${total} held, ETA ${Math.round(data.worker.eta_minutes)} min`
          : `${total} held`,
      };
    case "verifying":
      return { ...answered, pill: ["Verifying", "warn"], footer: `${total} held, checking the answer` };
    case "answered":
      return {
        ...answered,
        pill: ["Verified", "good"],
        footer: a
          ? `${total} total, answered in ${minutes(task.created_at, a.captured_at)} min`
          : `${total} total`,
        buttons: [
          { label: "Tip", call: { name: "tip_worker", args: { task_id: task.task_id } }, primary: true },
          dispute,
        ],
      };
    case "needs_review":
      return task.status === "disputed"
        ? {
            ...answered,
            pill: ["Disputed", "warn"],
            note: a?.verification.vision_reason ?? null,
            footer: "Disputed, under review",
          }
        : {
            ...answered,
            pill: ["Needs review", "warn"],
            note: a?.verification.vision_reason ?? null,
            footer: "Payout held, under review",
            buttons: [dispute],
          };
    case "expired_refunded":
      return {
        ...base,
        state,
        pill: ["Refunded", "neutral"],
        media: { kind: "map" },
        line: `${task.status === "refunded" ? "Cancelled" : "No one available"}. ${total} refunded.`,
      };
  }
}

const GLYPH: Record<Check, string> = { passed: "✓", pending: "…", failed: "✕" };

const eye = () =>
  h(
    "svg",
    { viewBox: "0 0 24 24", width: 18, height: 18, "aria-hidden": true },
    h("path", {
      d: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
    }),
    h("circle", { cx: 12, cy: 12, r: 3.2, fill: "currentColor" }),
  );

const map = () =>
  h(
    "svg",
    {
      viewBox: "0 0 400 90",
      preserveAspectRatio: "xMidYMid slice",
      role: "img",
      "aria-label": "Map placeholder",
      className: "eyes-map",
    },
    Array.from({ length: 21 }, (_, i) => h("line", { key: `v${i}`, x1: i * 20, y1: 0, x2: i * 20, y2: 90 })),
    Array.from({ length: 7 }, (_, i) => h("line", { key: `h${i}`, x1: 0, y1: i * 15, x2: 400, y2: i * 15 })),
    h("path", { className: "eyes-street", d: "M0 62 L400 48 M128 0 L150 90 M290 0 L262 90" }),
    h("path", {
      className: "eyes-pin",
      d: "M200 14c-9 0-16 7-16 16 0 12 16 30 16 30s16-18 16-30c0-9-7-16-16-16z",
    }),
    h("circle", { className: "eyes-pin-dot", cx: 200, cy: 30, r: 6 }),
  );

const samplePhoto = () =>
  h(
    "svg",
    {
      viewBox: "0 0 400 90",
      preserveAspectRatio: "xMidYMid slice",
      role: "img",
      "aria-label": "Sample photo",
    },
    h("rect", { width: 400, height: 90, fill: "#c8b9a2" }),
    h("rect", { x: 0, y: 70, width: 400, height: 20, fill: "#8d8578" }),
    h("rect", { x: 250, y: 10, width: 120, height: 60, fill: "#3f4a55" }),
    h("rect", { x: 262, y: 20, width: 40, height: 50, fill: "#e8d9a8" }),
    [70, 118, 166, 214].map((x) =>
      h(
        "g",
        { key: x, fill: "#2f3540" },
        h("circle", { cx: x, cy: 34, r: 8 }),
        h("rect", { x: x - 10, y: 44, width: 20, height: 30, rx: 6 }),
      ),
    ),
  );

function Photo({ src }: { src: string }): ReactNode {
  const [broken, setBroken] = useState(false);
  if (broken) return map();
  return h("img", {
    src,
    alt: "Photo taken on site by the worker",
    referrerPolicy: "no-referrer",
    onError: () => setBroken(true),
  });
}

const media = (m: NonNullable<Media>) =>
  m.kind === "map" ? map() : m.src === FIXTURE_PHOTO ? samplePhoto() : h(Photo, { src: m.src });

type CardProps = {
  view: CardView;
  theme: Theme;
  sandbox: boolean;
  toast: string | null;
  bridge: WidgetBridge;
  onToast: (text: string) => void;
};

export function TaskCard({ bridge }: { bridge: WidgetBridge }): ReactNode {
  const data = useSyncExternalStore(bridge.onUpdate, bridge.getToolOutput, bridge.getToolOutput);
  const theme = useSyncExternalStore(bridge.onUpdate, bridge.getTheme, bridge.getTheme);
  const [key] = useState(() => crypto.randomUUID());
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  return cardTree({
    view: cardView(data, key),
    theme,
    sandbox: data.sandbox,
    toast,
    bridge,
    onToast: setToast,
  });
}

export function cardTree({ view, theme, sandbox, toast, bridge, onToast }: CardProps): ReactNode {
  const run = (call: ToolCall) =>
    bridge
      .callTool(call.name, call.args)
      .then(onToast, (err: unknown) => onToast(err instanceof Error ? err.message : "Something went wrong"));

  return h(
    "article",
    { className: "eyes-card", "data-theme": theme, "data-state": view.state },
    h(
      "header",
      { className: "eyes-head" },
      h("span", { className: "eyes-brand" }, eye(), "Eyes task"),
      h(
        "span",
        { className: "eyes-pills" },
        sandbox && h("span", { className: "eyes-pill", "data-tone": "neutral" }, "Sandbox"),
        h("span", { className: "eyes-pill", "data-tone": view.pill[1] }, view.pill[0]),
      ),
    ),
    view.media && h("div", { className: "eyes-media" }, media(view.media)),
    h(
      "p",
      { className: "eyes-line" },
      view.pulse && h("span", { className: "eyes-pulse", "aria-hidden": true }),
      view.line,
    ),
    view.note && h("p", { className: "eyes-note" }, view.note),
    view.badges.length > 0 &&
      h(
        "ul",
        { className: "eyes-badges" },
        view.badges.map((b) =>
          h(
            "li",
            { key: b.label, className: "eyes-badge", "data-check": b.check },
            h("span", { "aria-hidden": true }, GLYPH[b.check]),
            b.label,
            h("span", { className: "eyes-sr" }, `, ${b.check}`),
          ),
        ),
      ),
    (view.footer || view.buttons.length > 0) &&
      h(
        "footer",
        { className: "eyes-foot" },
        h("span", null, view.footer),
        view.buttons.length > 0 &&
          h(
            "span",
            { className: "eyes-actions" },
            view.buttons.map((b) =>
              h(
                "button",
                {
                  key: b.label,
                  type: "button",
                  className: b.primary ? "eyes-btn eyes-primary" : "eyes-btn",
                  onClick: () => run(b.call),
                },
                b.label,
              ),
            ),
          ),
      ),
    toast && h("p", { className: "eyes-toast", role: "status" }, toast),
  );
}
