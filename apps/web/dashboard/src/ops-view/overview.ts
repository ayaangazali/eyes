// The Overview tab: health in one line, the task funnel, money in/out/kept, and readable trend charts.
// server.ts inlines this file (types stripped) into ops.html.
import { LIVE, sum, usd } from "./format.ts";

type Kid = Node | string | null | undefined;
export type Health = {
  uptime_s: number;
  providers: Record<string, string>;
  db: string;
  db_error?: string | null;
  classifier: string;
  commit?: string | null;
  node: string;
};

const SVG = "http://www.w3.org/2000/svg";

function node<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string | null,
  ...kids: Kid[]
) {
  const el = doc.createElement(tag);
  if (cls) el.className = cls;
  for (const kid of kids) if (kid != null) el.append(kid);
  return el;
}

/** An outline icon from the inlined sprite; with a label it is announced (and shown as a tooltip). */
export function icon(doc: Document, id: string, label?: string) {
  const svg = doc.createElementNS(SVG, "svg");
  svg.setAttribute("class", "ui-icon");
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
    const title = doc.createElementNS(SVG, "title");
    title.textContent = label;
    svg.append(title);
  } else svg.setAttribute("aria-hidden", "true");
  const use = doc.createElementNS(SVG, "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

/** Plain names for the providers the server reports, as on /status. */
export const SERVICES: Record<string, [string, string]> = {
  messaging: ["Texting", "i-message"],
  email: ["Email", "i-mail"],
  payments: ["Payments", "i-cash"],
  storage: ["Photos", "i-camera"],
  vision: ["Photo moderation", "i-shield"],
  geo: ["Place lookup", "i-pin"],
};
const service = (name: string) => SERVICES[name] ?? [name, "i-info"];

export function renderHealth(doc: Document, root: HTMLElement, hl: Health) {
  const all = Object.entries(hl.providers);
  const off = all.filter(([, mode]) => mode !== "live");
  const icons = all.map(([name, mode]) => {
    const [label, id] = service(name);
    const svg = icon(doc, id, `${label}: ${mode === "live" ? "live" : "simulated"}`);
    svg.classList.add(mode === "live" ? "is-live" : "is-off");
    return svg;
  });
  const summary = node(
    doc,
    "p",
    `svc${off.length ? " svc--off" : ""}`,
    node(doc, "span", "svc__icons", ...icons),
    !all.length
      ? "No services reported"
      : off.length
        ? `${all.length - off.length} of ${all.length} services live`
        : `All ${all.length} services live`,
  );
  // Only what is not live gets a line of its own.
  const problems = off.length
    ? node(
        doc,
        "ul",
        "svc-off",
        ...off.map(([name]) => {
          const [label, id] = service(name);
          return node(
            doc,
            "li",
            null,
            icon(doc, id),
            `${label} is simulated: nothing real is sent or charged.`,
          );
        }),
      )
    : null;
  const meta: [string, Kid][] = [
    [
      "Database",
      hl.db_error
        ? node(doc, "span", "ui-badge ui-badge--danger", "failing")
        : hl.db === "insforge"
          ? "Hosted Postgres"
          : "Local Postgres",
    ],
    ["Safety check", hl.classifier],
    ["Node", hl.node],
  ];
  if (hl.commit) meta.push(["Commit", node(doc, "code", null, hl.commit.slice(0, 10))]);
  const dl = node(
    doc,
    "dl",
    "meta",
    ...meta.flatMap(([k, v]) => [node(doc, "dt", null, k), node(doc, "dd", null, v)]),
  );
  root.replaceChildren(...[summary, problems, dl].filter((x) => x != null));
}

/** "needs_review" → "Needs review". */
export const statusLabel = (status: string) => {
  const words = status.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};
export const FUNNEL = ["dispatched", "claimed", "submitted", "verified", "paid"];
const ATTENTION = ["needs_review", "disputed"];

/** The task funnel, the attention states as links into Review, and how the rest ended. */
export function renderFunnel(doc: Document, root: HTMLElement, statuses: Record<string, number>) {
  // Bars scaled to the busiest step: where tasks are piling up shows at a glance.
  const top = Math.max(1, ...FUNNEL.map((s) => statuses[s] ?? 0));
  const steps = node(
    doc,
    "ol",
    "funnel",
    ...FUNNEL.map((s) => {
      const n = statuses[s] ?? 0;
      const bar = node(doc, "span", "funnel__bar");
      bar.style.height = `${(n / top) * 100}%`;
      return node(
        doc,
        "li",
        `funnel__step${n ? "" : " is-zero"}${LIVE.includes(s) && n ? " is-live" : ""}`,
        node(doc, "span", "funnel__track", bar),
        node(doc, "b", null, String(n)),
        node(doc, "span", "funnel__label", statusLabel(s)),
      );
    }),
  );
  const hot = ATTENTION.filter((s) => (statuses[s] ?? 0) > 0);
  const attention = hot.length
    ? node(
        doc,
        "p",
        "attention",
        ...hot.map((s) => {
          const n = statuses[s] as number;
          const a = node(
            doc,
            "a",
            "attention__link",
            icon(doc, "i-alert"),
            s === "disputed" ? `${n} disputed` : `${n} ${n === 1 ? "needs" : "need"} review`,
          );
          a.href = `#review?status=${s}`;
          return a;
        }),
      )
    : node(doc, "p", "attention is-clear", icon(doc, "i-check"), "Nothing needs a decision");
  const ended = Object.entries(statuses)
    .filter(([s, n]) => n > 0 && !FUNNEL.includes(s) && !ATTENTION.includes(s))
    .map(([s, n]) => `${n} ${statusLabel(s).toLowerCase()}`);
  root.replaceChildren(
    ...[steps, attention, ended.length ? node(doc, "p", "ended", `Ended: ${ended.join(", ")}`) : null].filter(
      (x) => x != null,
    ),
  );
}

export const MONEY: [string, [string, string][]][] = [
  [
    "In",
    [
      ["topup", "Top-ups"],
      ["escrow", "Escrowed"],
    ],
  ],
  [
    "Out",
    [
      ["release", "Released to workers"],
      ["refund", "Refunded to agents"],
      ["payout", "Paid out (Stripe)"],
    ],
  ],
  ["Kept", [["fee", "Fees"]]],
];

/** Money in, out and kept over 24 h, one row group each, amounts aligned. */
export function renderMoney(doc: Document, root: HTMLElement, m: Record<string, number>) {
  root.replaceChildren(
    ...MONEY.map(([group, rows]) => {
      const body = node(doc, "tbody");
      rows.forEach(([key, label], i) => {
        const tr = node(doc, "tr");
        if (i === 0) {
          const th = node(doc, "th", null, group);
          th.scope = "rowgroup";
          th.rowSpan = rows.length;
          tr.append(th);
        }
        tr.append(node(doc, "td", null, label), node(doc, "td", "num", usd(m[key])));
        body.append(tr);
      });
      return body;
    }),
  );
}

export type ChartSpec = {
  label: string;
  values: number[];
  /** Bucket keys from the server, "YYYY-MM-DD HH:MM:SS" in UTC, one per value. */
  times: string[];
  note: string;
  format?: (v: number) => string;
  bad?: boolean;
};
export const bucketTime = (key: string) => Date.parse(`${key.replace(" ", "T")}Z`);

/**
 * One trend card: the latest value large, the line scaled from 0 to its max (both labelled), a dot on the
 * latest point, and a tooltip with the bucket time and value under the pointer or the arrow keys.
 */
export function chartCard(doc: Document, spec: ChartSpec, clock: (ms: number) => string) {
  const fmt = spec.format ?? String;
  const { values } = spec;
  const max = Math.max(0, ...values);
  const scale = max || 1;
  const n = Math.max(1, values.length - 1);
  const x = (i: number) => (i / n) * 100;
  const y = (v: number) => 40 - (v / scale) * 38;
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const svg = doc.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 100 40");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const shape = (tag: string, cls: string, points: string) => {
    const el = doc.createElementNS(SVG, tag);
    el.setAttribute("class", cls);
    el.setAttribute("points", points);
    return el;
  };
  svg.append(shape("polygon", "area", `0,40 ${pts} 100,40`), shape("polyline", "line", pts));

  const last = values.length - 1;
  const dot = node(doc, "span", "chart__dot");
  const cursor = node(doc, "span", "chart__cursor");
  const tip = node(doc, "span", "chart__tip");
  tip.setAttribute("role", "status");
  cursor.hidden = true;
  tip.hidden = true;
  const place = (el: HTMLElement, i: number) => {
    el.style.left = `${x(i)}%`;
    el.style.top = `${(y(values[i] as number) / 40) * 100}%`;
  };
  if (last >= 0) place(dot, last);
  else dot.hidden = true;
  let at = last;
  const show = (i: number) => {
    at = Math.min(last, Math.max(0, i));
    const time = spec.times[at];
    tip.textContent = `${time ? clock(bucketTime(time)) : ""} ${fmt(values[at] as number)}`.trim();
    place(tip, at);
    place(cursor, at);
    tip.hidden = false;
    cursor.hidden = false;
  };
  const hide = () => {
    tip.hidden = true;
    cursor.hidden = true;
  };

  const plot = node(
    doc,
    "div",
    "chart__plot",
    svg,
    node(doc, "span", "chart__axis chart__axis--max", fmt(max)),
    node(doc, "span", "chart__axis chart__axis--min", fmt(0)),
    cursor,
    dot,
    tip,
  );
  plot.tabIndex = last >= 0 ? 0 : -1;
  plot.setAttribute(
    "aria-label",
    `${spec.label}: now ${fmt(values[last] ?? 0)}, max ${fmt(max)}. Arrow keys read each point.`,
  );
  plot.addEventListener("pointermove", (e) => {
    const box = plot.getBoundingClientRect();
    show(Math.round(((e.clientX - box.left) / (box.width || 1)) * n));
  });
  plot.addEventListener("pointerleave", hide);
  plot.addEventListener("blur", hide);
  plot.addEventListener("focus", () => show(at));
  plot.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -last, End: last }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    show(at + step);
  });

  return node(
    doc,
    "div",
    `chart${spec.bad ? " bad" : ""}`,
    node(doc, "h3", null, spec.label),
    node(doc, "p", "chart__now", fmt(values[last] ?? 0)),
    node(doc, "p", "chart__note", spec.note),
    plot,
  );
}

export type SeriesData = {
  minutes?: string[];
  requests: number[];
  errors: number[];
  p95_ms: number[];
  hours: string[];
  tasks: Record<string, number[]>;
  payouts: { ok: number[]; failed: number[] };
};

/** The chart specs for a series payload, in reading order. */
export function seriesCharts(s: SeriesData): ChartSpec[] {
  const minutes = s.minutes ?? [];
  const reqs = sum(s.requests);
  const errs = sum(s.errors);
  const rate = s.requests.map((r, i) => (r ? ((s.errors[i] as number) / r) * 100 : 0));
  const statuses = Object.keys(s.tasks);
  const tasks: ChartSpec[] = statuses.length
    ? statuses.map((st) => {
        const counts = s.tasks[st] as number[];
        return {
          label: `${statusLabel(st)} per hour`,
          values: counts,
          times: s.hours,
          note: `${sum(counts)} in 24 h`,
          bad: ATTENTION.includes(st) && sum(counts) > 0,
        };
      })
    : [{ label: "Tasks per hour", values: s.hours.map(() => 0), times: s.hours, note: "None in 24 h" }];
  return [
    { label: "Requests per minute", values: s.requests, times: minutes, note: `${reqs} in 2 h` },
    {
      label: "Server errors",
      values: rate,
      times: minutes,
      note: `${errs} of ${reqs} requests failed in 2 h`,
      format: (v) => `${v.toFixed(1)}%`,
      bad: errs > 0,
    },
    {
      label: "Response time, slowest 5%",
      values: s.p95_ms,
      times: minutes,
      note: "p95 per minute over 2 h",
      format: (v) => `${Math.round(v)} ms`,
    },
    ...tasks,
    {
      label: "Payouts per hour",
      values: s.payouts.ok,
      times: s.hours,
      note: `${sum(s.payouts.ok)} paid, ${sum(s.payouts.failed)} failed in 24 h`,
      bad: sum(s.payouts.failed) > 0,
    },
  ];
}
