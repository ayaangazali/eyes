import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  bucketTime,
  chartCard,
  FUNNEL,
  icon,
  renderFunnel,
  renderHealth,
  renderMoney,
  seriesCharts,
  statusLabel,
} from "./overview.ts";

const windows: Window[] = [];
afterEach(async () => {
  for (const w of windows.splice(0)) await w.happyDOM.close();
});
function dom() {
  const happy = new Window();
  windows.push(happy);
  const doc = happy.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.append(root);
  return { happy, doc, root };
}
const HEALTH = {
  uptime_s: 60,
  providers: { messaging: "live", email: "live", payments: "fake", carrier: "live" },
  db: "local",
  classifier: "rules only",
  node: "v26",
};

describe("overview health", () => {
  it("shows each service as icon and name with a provider tooltip, and gives only the simulated ones a line", () => {
    const { doc, root } = dom();
    renderHealth(doc, root, HEALTH);
    expect(root.querySelector(".svc")?.textContent).toBe("3 of 4 services live");
    expect(root.querySelector(".svc")?.classList.contains("svc--off")).toBe(true);
    const items = [...root.querySelectorAll(".svc__grid li")] as HTMLElement[];
    expect(items.map((li) => li.textContent)).toEqual(["Texting", "Email", "Payments · off", "carrier"]);
    expect(items.map((li) => li.getAttribute("aria-label"))).toEqual([
      "Texting: Inkbox, live",
      "Email: Primitive, live",
      "Payments: simulated",
      "carrier: carrier, live",
    ]);
    expect(
      items.map((li) => [li.className, li.tabIndex, li.dataset.tip === li.getAttribute("aria-label")]),
    ).toEqual([
      ["svc__item is-live", 0, true],
      ["svc__item is-live", 0, true],
      ["svc__item is-off", 0, true],
      ["svc__item is-live", 0, true],
    ]);
    expect(items[0]?.querySelector("use")?.getAttribute("href")).toBe("#i-message");
    expect([...root.querySelectorAll(".svc-off li")].map((li) => li.textContent)).toEqual([
      "Payments is simulated: nothing real is sent or charged.",
    ]);
    expect(root.querySelector(".meta")?.textContent).toBe(
      "DatabaseLocal PostgresSafety checkrules onlyNodev26",
    );
  });

  it("names every provider, the photo check by its classifier", () => {
    const { doc, root } = dom();
    const providers = {
      messaging: "live",
      email: "live",
      payments: "live",
      storage: "live",
      vision: "live",
      geo: "live",
    };
    renderHealth(doc, root, { ...HEALTH, providers, classifier: "clef, Claude when unsure" });
    const tips = () => [...root.querySelectorAll(".svc__grid li")].map((li) => li.getAttribute("aria-label"));
    expect(tips()).toEqual([
      "Texting: Inkbox, live",
      "Email: Primitive, live",
      "Payments: Stripe, live",
      "Photos: InsForge, live",
      "Safety check: clef, live",
      "Place lookup: Nominatim, live",
    ]);
    renderHealth(doc, root, { ...HEALTH, providers: { vision: "live" }, classifier: "Claude" });
    expect(tips()).toEqual(["Safety check: Claude, live"]);
    renderHealth(doc, root, { ...HEALTH, providers: {} });
    expect([root.querySelector(".svc")?.textContent, root.querySelector(".svc__grid")]).toEqual([
      "No services reported",
      null,
    ]);
  });

  it("says all live, shows a failing database and the commit when known", () => {
    const { doc, root } = dom();
    renderHealth(doc, root, {
      ...HEALTH,
      providers: { geo: "live" },
      db: "insforge",
      db_error: "down",
      commit: "0123456789abcdef",
    });
    expect(root.querySelector(".svc")?.textContent).toBe("All 1 services live");
    expect(root.querySelector(".svc-off")).toBeNull();
    expect(root.querySelector(".meta .ui-badge--danger")?.textContent).toBe("failing");
    expect(root.querySelector(".meta code")?.textContent).toBe("0123456789");
  });

  it("hides decorative icons from assistive tech", () => {
    const { doc } = dom();
    expect(icon(doc, "i-check").getAttribute("aria-hidden")).toBe("true");
  });
});

describe("overview funnel", () => {
  it("draws one column per state, scaled to the busiest, each linking to Tasks filtered to it", () => {
    const { doc, root } = dom();
    renderFunnel(doc, root, {
      dispatched: 2,
      paid: 4,
      needs_review: 3,
      disputed: 1,
      expired: 1,
      refunded: 0,
    });
    const steps = [...root.querySelectorAll(".funnel__step")] as HTMLAnchorElement[];
    expect(steps.map((s) => s.className)).toEqual([
      "funnel__step is-live",
      "funnel__step is-zero",
      "funnel__step is-zero",
      "funnel__step is-zero",
      "funnel__step",
      "funnel__step is-danger is-first-after",
      "funnel__step is-warn",
      "funnel__step",
      "funnel__step is-zero",
    ]);
    expect(steps.map((s) => (s.querySelector(".funnel__bar") as HTMLElement).style.height)).toEqual([
      "50%",
      "0%",
      "0%",
      "0%",
      "100%",
      "75%",
      "25%",
      "25%",
      "0%",
    ]);
    const states = [...FUNNEL, "needs_review", "disputed", "expired", "refunded"];
    expect(steps.map((s) => s.querySelector(".funnel__label")?.textContent)).toEqual(states.map(statusLabel));
    expect(steps.map((s) => s.getAttribute("href"))).toEqual(states.map((s) => `#tasks?status=${s}`));
    expect(steps[5]?.getAttribute("aria-label")).toBe("Needs review: 3. Show in Tasks");
    expect(root.querySelector(".attention, .ended")).toBeNull();
  });

  it("tints nothing when nothing needs a decision", () => {
    const { doc, root } = dom();
    renderFunnel(doc, root, {});
    expect(root.querySelectorAll(".funnel__step")).toHaveLength(9);
    expect(root.querySelector(".is-danger, .is-warn")).toBeNull();
    expect((root.querySelector(".funnel__bar") as HTMLElement).style.height).toBe("0%");
  });
});

describe("overview money", () => {
  it("groups money into in, out and kept, with each group label once", () => {
    const { doc } = dom();
    const table = doc.createElement("table");
    renderMoney(doc, table, { topup: 2000, escrow: 450, release: 300, fee: 50 });
    const groups = [...table.querySelectorAll("tbody")];
    expect(groups.map((g) => g.querySelector("th")?.textContent)).toEqual(["In", "Out", "Kept"]);
    expect(groups.map((g) => g.querySelectorAll("th").length)).toEqual([1, 1, 1]);
    expect(groups[1]?.querySelector("th")?.getAttribute("rowspan")).toBe("3");
    expect([...table.querySelectorAll("tr")].map((tr) => tr.textContent)).toEqual([
      "InTop-ups$20.00",
      "Escrowed$4.50",
      "OutReleased to workers$3.00",
      "Refunded to agents$0.00",
      "Paid out (Stripe)$0.00",
      "KeptFees$0.50",
    ]);
  });
});

describe("overview charts", () => {
  const HOURS = ["2026-10-17 10:00:00", "2026-10-17 11:00:00", "2026-10-17 12:00:00"];
  it("names statuses plainly and reads bucket keys as UTC", () => {
    expect(statusLabel("needs_review")).toBe("Needs review");
    expect(bucketTime("2026-10-17 10:00:00")).toBe(Date.parse("2026-10-17T10:00:00Z"));
  });

  it("builds one spec per series, plain labels, bad when errors or attention states happen", () => {
    const specs = seriesCharts({
      minutes: ["a", "b"],
      requests: [4, 0],
      errors: [1, 0],
      p95_ms: [120.4, 80],
      hours: HOURS,
      tasks: { disputed: [0, 1, 0], paid: [1, 1, 1], needs_review: [0, 0, 0] },
      payouts: { ok: [1, 0, 1], failed: [0, 0, 0] },
    });
    expect(specs.map((s) => [s.label, s.note, Boolean(s.bad)])).toEqual([
      ["Requests per minute", "4 in 2 h", false],
      ["Server errors", "1 of 4 requests failed in 2 h", true],
      ["Response time, slowest 5%", "p95 per minute over 2 h", false],
      ["Disputed per hour", "1 in 24 h", true],
      ["Paid per hour", "3 in 24 h", false],
      ["Needs review per hour", "0 in 24 h", false],
      ["Payouts per hour", "2 paid, 0 failed in 24 h", false],
    ]);
    expect(specs[1]?.values).toEqual([25, 0]);
    expect(specs[1]?.format?.(25)).toBe("25.0%");
    expect(specs[2]?.format?.(120.4)).toBe("120 ms");
    const none = seriesCharts({
      requests: [],
      errors: [],
      p95_ms: [],
      hours: HOURS,
      tasks: {},
      payouts: { ok: [], failed: [1] },
    });
    expect(none.map((s) => s.label)).toContain("Tasks per hour");
    expect(none[0]?.times).toEqual([]);
    expect(none.at(-1)?.bad).toBe(true);
  });

  it("draws the line from 0 to its max with labels, marks the latest point, and shows a tooltip under the pointer or keys", () => {
    const { doc, happy } = dom();
    const card = chartCard(
      doc,
      { label: "Paid per hour", values: [0, 2, 4], times: HOURS, note: "6 in 24 h", bad: true },
      (ms) => new Date(ms).toISOString().slice(11, 16),
    );
    doc.body.append(card);
    expect(card.className).toBe("chart bad");
    expect(card.querySelector(".chart__now")?.textContent).toBe("4");
    expect([...card.querySelectorAll(".chart__axis")].map((a) => a.textContent)).toEqual(["4", "0"]);
    expect(card.querySelector("polyline")?.getAttribute("points")).toBe("0,40 50,21 100,2");
    const dot = card.querySelector(".chart__dot") as HTMLElement;
    expect([dot.style.left, dot.style.top]).toEqual(["100%", "5%"]);
    const plot = card.querySelector(".chart__plot") as HTMLElement;
    expect(plot.getAttribute("aria-label")).toBe("Paid per hour: now 4, max 4. Arrow keys read each point.");
    const tip = card.querySelector(".chart__tip") as HTMLElement;
    expect(tip.hidden).toBe(true);

    plot.getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;
    plot.dispatchEvent(new happy.PointerEvent("pointermove", { clientX: 100 }) as unknown as Event);
    expect([tip.hidden, tip.textContent, tip.style.left]).toEqual([false, "11:00 2", "50%"]);
    plot.dispatchEvent(new happy.PointerEvent("pointerleave") as unknown as Event);
    expect(tip.hidden).toBe(true);

    const key = (k: string) =>
      plot.dispatchEvent(
        new happy.KeyboardEvent("keydown", { key: k, cancelable: true }) as unknown as Event,
      );
    plot.dispatchEvent(new happy.FocusEvent("focus") as unknown as Event);
    expect(tip.textContent).toBe("11:00 2");
    expect(key("ArrowRight")).toBe(false);
    expect(tip.textContent).toBe("12:00 4");
    key("ArrowRight");
    expect(tip.textContent).toBe("12:00 4");
    key("Home");
    expect(tip.textContent).toBe("10:00 0");
    key("End");
    expect(tip.textContent).toBe("12:00 4");
    expect(key("Tab")).toBe(true);
    plot.dispatchEvent(new happy.FocusEvent("blur") as unknown as Event);
    expect(tip.hidden).toBe(true);
  });

  it("handles an empty series and a missing bucket time", () => {
    const { doc, happy } = dom();
    const empty = chartCard(doc, { label: "Empty", values: [], times: [], note: "" }, String);
    expect((empty.querySelector(".chart__dot") as HTMLElement).hidden).toBe(true);
    expect((empty.querySelector(".chart__plot") as HTMLElement).tabIndex).toBe(-1);
    expect(empty.querySelector(".chart__now")?.textContent).toBe("0");
    const flat = chartCard(doc, { label: "Flat", values: [0, 0], times: [], note: "" }, String);
    const plot = flat.querySelector(".chart__plot") as HTMLElement;
    plot.getBoundingClientRect = () => ({ left: 0, width: 0 }) as DOMRect;
    plot.dispatchEvent(new happy.PointerEvent("pointermove", { clientX: 0 }) as unknown as Event);
    expect(flat.querySelector(".chart__tip")?.textContent).toBe("0");
    expect(flat.querySelector("polyline")?.getAttribute("points")).toBe("0,40 100,40");
  });
});
