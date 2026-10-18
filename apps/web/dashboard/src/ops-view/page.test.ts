import { readFileSync } from "node:fs";
import { setImmediate as tick } from "node:timers/promises";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boot, type Leaflet, type OpsFeed, type OpsWindow, type Task, type Ticket } from "./page.ts";

const BODY = /<body[^>]*>([\s\S]*)<\/body>/
  .exec(readFileSync(new URL("../ops.html", import.meta.url), "utf8"))?.[1]
  ?.replace(/<script[\s\S]*?<\/script>/g, "") as string;

const TASK_ID = "11111111-2222-4333-8444-555555555555";
const HELD = "22222222-2222-4333-8444-555555555555";

function feed(over: Partial<OpsFeed["ops"]> = {}, rest: Partial<OpsFeed> = {}): OpsFeed {
  const held = {
    id: HELD,
    status: "needs_review",
    question: "Is the line at Blue Bottle longer than 5 people?",
    place_label: "37.76123456, -122.38598765",
    bounty_cents: 500,
    workers_notified: 3,
    gps_ok: true,
    fresh_ok: false,
    vision_ok: true,
    confidence: 0.82,
    created_at: "2026-10-17T12:00:00Z",
    claimed_at: "2026-10-17T12:00:30Z",
    submitted_at: "2026-10-17T12:04:00Z",
    money_at: {
      escrow: "2026-10-17T12:00:00Z",
      release: "2026-10-17T12:05:00Z",
      payout: "2026-10-17T12:06:00Z",
      refund: "2026-10-17T12:07:00Z",
      fee: "2026-10-17T12:08:00Z",
    },
  };
  const paid = {
    id: TASK_ID,
    status: "paid",
    question: "Is the gate open?",
    place_label: "Mint Plaza",
    bounty_cents: 300,
    created_at: "2026-10-17T11:00:00Z",
  };
  return {
    tasks: [held, paid],
    ledger: [
      { type: "escrow", created_at: "2026-10-17T12:00:00Z", task_id: HELD, amount_cents: 600 },
      { type: "release", created_at: "2026-10-17T12:05:00Z", task_id: "99999999-0000", amount_cents: 500 },
      { type: "bonus", created_at: "2026-10-17T12:06:00Z", task_id: null, amount_cents: 100 },
    ],
    workers: [
      { id: "w-out-0000-1", lat: 37.78, lng: -122.41, available: false, opted_in: false },
      { id: "w-avail-000-2", lat: 37.77, lng: -122.42, available: true, opted_in: true },
      { id: "w-in-00000-3", lat: null, lng: null, available: false, opted_in: true },
    ],
    totals: { escrowed_cents: 1234 },
    ops: {
      operator: "break-glass",
      since: "2026-10-16T12:00:00Z",
      health: {
        uptime_s: 7200,
        providers: { sms: "live", payments: "fake" },
        db: "insforge",
        db_error: null,
        classifier: "rules only",
        commit: "abcdef0123456789",
        node: "v26.7.0",
      },
      statuses: { dispatched: 2, needs_review: 1, paid: 4, expired: 0 },
      partial: { tasks: true, workers: true },
      money_24h: { escrow: 600, release: 500, refund: 0, fee: 100, payout: 500, topup: 10000 },
      queue: [held],
      workers: { opted_in: 2, online: 1, total: 3 },
      errors: [
        { level: "error", at: "2026-10-17T12:00:00Z", summary: "boom" },
        { level: "warn", at: "2026-10-17T12:01:00Z", summary: "slow" },
      ],
      ...over,
    },
    ...rest,
  };
}

const helpTicket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 7,
  kind: "help",
  status: "open",
  question: "Is the cafe open?",
  message: "I was at the door",
  task_id: HELD,
  task_status: "needs_review",
  place_label: "Mint Plaza",
  bounty_cents: 500,
  distance_m: 12,
  radius_m: 50,
  created_at: "2026-10-17T12:00:00Z",
  ...over,
});

const SERIES = {
  source: "clickhouse",
  dropped: 3,
  minutes: ["2026-10-17 11:58:00", "2026-10-17 11:59:00", "2026-10-17 12:00:00"],
  requests: [10, 0, 20],
  errors: [1, 0, 0],
  p95_ms: [120, 80, 300],
  hours: [0, 1],
  tasks: { needs_review: [1, 0], paid: [2, 3] },
  payouts: { ok: [1, 2], failed: [0, 1] },
};

type Route = (init: RequestInit | undefined, url: URL) => Response | Promise<Response>;
const ok = (body: unknown, status = 200) => Response.json(body, { status });

function leaflet() {
  const calls: string[] = [];
  const layer = {
    addTo: () => layer,
    clearLayers: () => calls.push("clear"),
  };
  const map = {
    setView: () => map,
    fitBounds: (_b: unknown, o: object) => calls.push(`fit ${JSON.stringify(o)}`),
    invalidateSize: () => calls.push("invalidate"),
  };
  const L: Leaflet = {
    map: (id) => {
      calls.push(`map ${id}`);
      return map;
    },
    tileLayer: () => layer,
    layerGroup: () => layer,
    circleMarker: (at, o) => {
      calls.push(`marker ${at.join(",")} ${"fillColor" in o ? o.fillColor : ""}`);
      return layer;
    },
    latLngBounds: (points) => ({ pad: (r) => ({ points, r }) }),
  };
  return { L, calls };
}

const windows: Window[] = [];
afterEach(async () => {
  for (const w of windows.splice(0)) await w.happyDOM.close();
});

async function setup(
  routes: Record<string, Route> = {},
  opts: { hash?: string; L?: Leaflet; root?: boolean } = {},
) {
  // root: served at the root of the ops host (internal.eyes.pictures); else under /ops on loopback.
  const happy = new Window({
    url: opts.root
      ? `https://internal.eyes.test/${opts.hash ?? ""}`
      : `https://api.eyes.test/ops${opts.hash ?? ""}`,
  });
  windows.push(happy);
  const win = happy as unknown as OpsWindow;
  win.document.body.innerHTML = BODY;
  const requests: { method: string; path: string; body?: unknown }[] = [];
  const raw: string[] = [];
  const all: Record<string, Route> = {
    "GET /ops/feed": () => ok(feed()),
    "GET /ops/tickets": () => ok({ tickets: [] }),
    "GET /ops/events": () => ok({ source: "db", events: [] }),
    "GET /ops/series": () => ok(SERIES),
    ...routes,
  };
  win.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://api.eyes.test");
    raw.push(url.pathname);
    if (opts.root) url.pathname = `/ops${url.pathname}`;
    const method = init?.method ?? "GET";
    requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const route = all[`${method} ${url.pathname}`];
    if (!route) throw new Error(`no route ${method} ${url.pathname}`);
    return route(init, url);
  }) as typeof fetch;
  const timers: { fn: () => void; ms: number }[] = [];
  win.setTimeout = ((fn: () => void, ms: number) => timers.push({ fn, ms })) as typeof setTimeout;
  const cleared: unknown[] = [];
  win.clearTimeout = ((id: unknown) => cleared.push(id)) as typeof clearTimeout;
  const assign = vi.spyOn(win.location, "assign").mockImplementation(() => {});
  if (opts.L) win.L = opts.L;
  await boot(win);
  const doc = win.document;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;
  const text = (id: string) => $(id).textContent;
  // Yield to queued fetch and DOM callbacks; page timers are recorded above, never real.
  const settle = () => tick();
  const click = async (el: Element) => {
    (el as HTMLElement).click();
    await settle();
    await settle();
  };
  const button = (root: Element, label: string) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
  const change = async (id: string, value: string, type = "change") => {
    $<HTMLInputElement>(id).value = value;
    $(id).dispatchEvent(new happy.Event(type) as unknown as Event);
    await settle();
    await settle();
  };
  return { win, happy, doc, $, text, requests, raw, timers, cleared, assign, click, button, change, settle };
}

describe("ops page boot", () => {
  it("renders health, tasks, money, workers, logs, events and charts from one poll", async () => {
    const { L, calls } = leaflet();
    const page = await setup(
      {
        "GET /ops/events": () =>
          ok({
            source: "db",
            events: [
              {
                id: 5,
                at: "2026-10-17T12:00:00Z",
                kind: "sms",
                level: "info",
                summary: "sent",
                task_id: HELD,
              },
              { id: 4, at: "2026-10-17T11:00:00Z", kind: "http", level: "error", summary: "500" },
              { id: 3, at: "2026-10-17T10:00:00Z", kind: "http", level: "warn", summary: "slow" },
            ],
          }),
      },
      { L },
    );
    const { $, text, requests, timers } = page;
    expect(requests.map((r) => r.path)).toEqual([
      "/ops/feed",
      "/ops/tickets",
      "/ops/events?limit=100",
      "/ops/series",
    ]);
    expect(text("state")).toBe("Live");
    expect($("state").className).toBe("ui-badge ui-badge--success");
    expect(text("updated")).toMatch(/^updated .+, every 10 s$/);
    expect(timers.at(-1)?.ms).toBe(10000);

    expect(text("uptime")).toBe("2h 0m");
    expect($("health").querySelector(".svc")?.textContent).toContain("1 of 2 services live");
    expect($("health").querySelector(".meta")?.textContent).toBe(
      "DatabaseHosted PostgresSafety checkrules onlyNodev26.7.0Commitabcdef0123",
    );
    expect($("banner").hidden).toBe(true);
    expect(text("operator")).toBe("signed in: break-glass");
    expect(text("tasks-total")).toMatch(/^7\+ created since .+ yesterday$/);
    expect([...$("statuses").querySelectorAll(".funnel b")].map((b) => b.textContent)).toEqual([
      "2",
      "0",
      "0",
      "0",
      "4",
    ]);
    expect($("statuses").querySelector(".attention")?.textContent).toBe("1 needs review");

    expect(text("escrowed")).toBe("$12.34");
    expect(text("money-kv")).toContain("InTop-ups$100.00");
    expect(text("queue-count")).toBe("1");
    expect($("queue-count").className).toBe("ui-badge ui-badge--danger");
    expect(text("n-review")).toBe("1");
    expect($("n-review").classList.contains("hot")).toBe(true);
    const decision = $("queue").querySelector("tbody tr") as HTMLElement;
    expect(decision.getAttribute("aria-label")).toBe(
      "Review: Is the line at Blue Bottle longer than 5 people?",
    );
    expect([...decision.querySelectorAll("td")].map((td) => td.textContent).slice(0, 3)).toEqual([
      "Is the line at Blue Bottle longer than 5 people?",
      "Near 37.761, -122.386",
      "$5.00",
    ]);
    const row = $("task-list").querySelector("li") as HTMLElement;
    expect(row.className).toBe("open");
    expect(row.getAttribute("aria-label")).toBe("Review: Is the line at Blue Bottle longer than 5 people?");
    expect(row.textContent).toContain("Near 37.761, -122.386");
    expect(row.textContent).toContain("bounty $5.00");
    expect(row.textContent).toContain("notified 3");
    expect(row.querySelector(".flow-checks")?.textContent).toBe("✓ GPS ✗ fresh ✓ safe photo 82% sure");
    const flow = [...(row.querySelector(".flow")?.children ?? [])].map((s) => s.textContent);
    expect(flow.slice(1)).toEqual([
      "claimed +30s",
      "answered +4m",
      "released +5m",
      "paid out +6m",
      "refunded +7m",
      "fee +8m",
    ]);
    expect(flow[0]).toMatch(/^asked Oct 17/);

    expect(text("tasks-shown")).toBe("2 of 2, newest first");
    const paidRow = $("task-list").querySelectorAll("li")[1] as HTMLElement;
    expect(paidRow.className).toBe("");
    expect(paidRow.textContent).toContain("Mint Plaza");
    expect(paidRow.textContent).toContain("notified 0");
    expect(paidRow.querySelector(".flow-checks")).toBeNull();

    expect(text("worker-stats")).toBe("2+opted in1available now3signed up");
    expect([...$("workers-list").children].map((li) => li.textContent)).toEqual([
      "availableworker w-avail-",
      "opted inworker w-in-000no location",
      "opted outworker w-out-00",
    ]);
    expect(calls).toEqual([
      "map map",
      "clear",
      "marker 37.78,-122.41 #8f8f8f",
      "marker 37.77,-122.42 #ffd60a",
      'fit {"maxZoom":14}',
    ]);

    const ledger = [...$("ledger").children].map((s) => s.textContent);
    expect(ledger.slice(1, 3)).toEqual(["Escrow Near 37.761, -122.386", "$6.00"]);
    expect(ledger.slice(4, 6)).toEqual(["Release 99999999", "$5.00"]);
    expect(ledger.slice(7, 9)).toEqual(["bonus", "$1.00"]);

    expect(
      [...$("errors").children].map((li) => li.textContent?.replace(/Oct.*?(AM|PM)?(?=boom|slow)/, "")),
    ).toEqual(["Errorboom", "Warningslow"]);
    expect(text("n-logs")).toBe("2");
    expect($("n-logs").classList.contains("hot")).toBe(true);

    expect(text("events-source")).toBe("Newest first");
    const rows = [...$("events").querySelectorAll("tbody tr")];
    expect(rows.map((tr) => tr.querySelector(".ev-level")?.className)).toEqual([
      "ev-level ev-level--info",
      "ev-level ev-level--error",
      "ev-level ev-level--warn",
    ]);
    expect(rows.map((tr) => tr.querySelector(".ev-source svg")?.getAttribute("aria-label"))).toEqual([
      "sms",
      "Web request",
      "Web request",
    ]);
    expect(rows[1]?.getAttribute("aria-label")).toBe("Error, Web request: 500");
    expect($("events").querySelector(".tbl-count")?.textContent).toBe("3 events loaded");
    expect($("events").querySelector(".tbl-end")?.textContent).toBe("End of events");

    expect(text("series-source")).toBe("ClickHouse, 3 events dropped while it was down");
    const charts = [...$("charts").children];
    expect(charts.map((c) => c.querySelector("h3")?.textContent)).toEqual([
      "Requests per minute",
      "Server errors",
      "Response time, slowest 5%",
      "Needs review per hour",
      "Paid per hour",
      "Payouts per hour",
    ]);
    expect(charts.map((c) => c.querySelector(".chart__now")?.textContent)).toEqual([
      "20",
      "0.0%",
      "300 ms",
      "0",
      "3",
      "2",
    ]);
    expect(charts.map((c) => c.className)).toEqual([
      "chart",
      "chart bad",
      "chart",
      "chart bad",
      "chart",
      "chart bad",
    ]);
    // The tooltip names the bucket's local time.
    const plot = charts[0]?.querySelector(".chart__plot") as HTMLElement;
    plot.dispatchEvent(new page.happy.FocusEvent("focus") as unknown as Event);
    expect(plot.querySelector(".chart__tip")?.textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it("renders the empty and degraded states", async () => {
    const page = await setup({
      "GET /ops/feed": () =>
        ok(
          feed(
            {
              operator: undefined,
              health: {
                uptime_s: 90000,
                providers: {},
                db: "local",
                db_error: "connect ECONNREFUSED",
                classifier: "clef",
                commit: null,
                node: "v26",
              },
              statuses: {},
              partial: {},
              money_24h: {},
              queue: [],
              workers: { opted_in: 0, online: 0, total: 0 },
              errors: [{ level: "warn", at: "2026-10-17T12:00:00Z", summary: "slow" }],
            },
            { tasks: [], ledger: [], workers: [], totals: {} },
          ),
        ),
      "GET /ops/series": () =>
        ok({
          ...SERIES,
          source: "postgres",
          requests: [],
          errors: [],
          p95_ms: [],
          tasks: {},
          payouts: { ok: [], failed: [] },
        }),
      "GET /ops/events": () => ok({ source: "memory", events: [] }),
    });
    const { $, text } = page;
    expect(text("uptime")).toBe("1d 1h");
    expect(text("health")).toBe("No services reportedDatabasefailingSafety checkclefNodev26");
    expect($("banner").hidden).toBe(false);
    expect(text("banner")).toBe(
      "Database read failed: connect ECONNREFUSED. Health and errors below are still live.",
    );
    expect(text("operator")).toBe("");
    expect(text("tasks-total")).toMatch(/^0 created since/);
    expect(text("escrowed")).toBe("$0.00");
    expect(text("queue-count")).toBe("0");
    expect($("queue-count").className).toBe("ui-badge ui-badge--success");
    expect($("queue").querySelector(".tbl-empty")?.textContent).toMatch(/^Nothing needs a decision/);
    expect(text("n-review")).toBe("");
    expect(text("task-list")).toBe("No tasks yet.");
    expect(text("worker-stats")).toBe("0opted in0available now0signed up");
    expect(text("workers-list")).toBe("No workers yet.");
    expect($("map").classList.contains("nomap")).toBe(true);
    expect(text("map")).toBe("Map needs Leaflet from unpkg.com.");
    expect(text("ledger")).toBe("No ledger rows yet.");
    expect(text("n-logs")).toBe("1");
    expect($("n-logs").classList.contains("hot")).toBe(false);
    expect(text("events-source")).toBe("Database unreachable: this process's memory only");
    expect($("events").querySelector(".tbl-empty")?.textContent).toBe("No events match.");
    expect($("events").querySelector(".tbl-end")?.textContent).toBe("");
    expect(text("series-source")).toBe("Postgres and this process's last 500 events (ClickHouse off)");
    expect([...$("charts").children].map((c) => c.querySelector("h3")?.textContent)).toEqual([
      "Requests per minute",
      "Server errors",
      "Response time, slowest 5%",
      "Tasks per hour",
      "Payouts per hour",
    ]);
    expect(text("tickets-list")).toBe(
      "No tickets. A worker opens one by texting HELP after an answer is held for review.",
    );
    expect(text("tickets-count")).toBe("0 open");
    expect($("tickets-count").className).toBe("ui-badge ui-badge--success");

    page.$<HTMLSelectElement>("ledger-type").value = "fee";
    await page.change("ledger-type", "fee");
    expect(text("ledger")).toBe("No rows of this type.");
  });

  it("filters tasks and ledger rows by their selects", async () => {
    const { change, text, $ } = await setup();
    await change("task-status", "paid");
    expect(text("tasks-shown")).toBe("1 of 2, newest first");
    await change("task-status", "expired");
    expect(text("task-list")).toBe("No tasks with this status.");
    await change("ledger-type", "release");
    expect($("ledger").children).toHaveLength(3);
  });

  it("re-polls, skips unchanged tickets and series, and asks only for newer events", async () => {
    const page = await setup({
      "GET /ops/events": () => ok({ source: "database", events: [], newest_cursor: null, next_cursor: null }),
    });
    const { requests, timers } = page;
    requests.length = 0;
    timers.at(-1)?.fn();
    await page.settle();
    await page.settle();
    expect(requests.map((r) => r.path)).toEqual([
      "/ops/feed",
      "/ops/tickets",
      "/ops/events?limit=100",
      "/ops/series",
    ]);
  });

  it("shows feed failures and sends a 401 to the login page", async () => {
    let status = 500;
    const page = await setup({ "GET /ops/feed": () => new Response("", { status }) });
    expect(page.text("state")).toBe("Feed failed: HTTP 500");
    expect(page.$("state").className).toBe("ui-badge ui-badge--danger");
    status = 401;
    page.timers.at(-1)?.fn();
    await page.settle();
    expect(page.assign).toHaveBeenCalledWith("/ops/login");
  });

  it("ignores failed ticket, event and series reads", async () => {
    const fail = () => new Response("", { status: 503 });
    const page = await setup({ "GET /ops/tickets": fail, "GET /ops/events": fail, "GET /ops/series": fail });
    expect(page.text("state")).toBe("Live");
    expect(page.text("tickets-count")).toBe("");
    expect(page.text("charts")).toBe("");
  });

  it("logs out, even when the logout request fails", async () => {
    let fail = false;
    const page = await setup({
      "POST /ops/logout": () => {
        if (fail) throw new Error("offline");
        return new Response(null, { status: 204 });
      },
    });
    await page.click(page.$("logout"));
    fail = true;
    await page.click(page.$("logout"));
    expect(page.requests.filter((r) => r.path === "/ops/logout")).toHaveLength(2);
    expect(page.assign).toHaveBeenCalledTimes(2);
  });
});

describe("ops review panel", () => {
  const detail = {
    ...feed().tasks[0],
    fee_cents: 100,
    photo_url: "https://cdn.eyes.test/p.jpg",
    answer_text: "Yes, about 8 people",
    distance_m: 14,
    radius_m: 50,
    vision_reason: "Photo answers the question",
    dispute_reason: "Wrong cafe",
  };

  it("opens from the queue and releases after a confirming second click", async () => {
    const page = await setup({
      [`GET /ops/tasks/${HELD}`]: () => ok(detail),
      [`POST /ops/tasks/${HELD}/resolve`]: () => ok({ status: "verified" }),
    });
    const { $, click, button, requests, timers } = page;
    await click($("queue").querySelector("tbody tr") as HTMLElement);
    const review = $<HTMLDialogElement>("review-panel");
    expect(review.open).toBe(true);
    expect(review.querySelector("h2")?.textContent).toBe(detail.question);
    const img = review.querySelector("img") as HTMLImageElement;
    expect(img.src).toBe("https://cdn.eyes.test/p.jpg");
    expect(img.referrerPolicy).toBe("no-referrer");
    expect(review.textContent).toContain("Answer: Yes, about 8 people");
    expect(review.textContent).toContain("worker 14 m away (radius 50 m)");
    expect(review.textContent).toContain("bounty $5.00 + fee $1.00 in escrow");
    expect([...review.querySelectorAll(".checklist li")].map((li) => li.textContent)).toEqual([
      "✓ At the place (GPS)",
      "✗ Taken just now",
      "✓ Photo is safe to share",
    ]);
    expect(review.textContent).toContain("Moderation: Old check: Photo answers the question");
    expect(review.textContent).toContain("Agent's dispute: Wrong cafe");
    expect(review.textContent).not.toContain("null");

    const release = button(review, "Release (pay the worker)");
    expect(release.className).toBe("ui-button ui-button--sm ui-button--primary");
    await click(release);
    expect(release.textContent).toBe("Confirm: pay the worker $5.00");
    expect(timers.at(-1)?.ms).toBe(5000);
    timers.at(-1)?.fn();
    expect(release.textContent).toBe("Release (pay the worker)");
    expect(button(review, "Refund (return to the agent)")).toBeTruthy();
    await click(release);
    await click(release);
    expect(requests.at(-1)).toEqual({
      method: "POST",
      path: `/ops/tasks/${HELD}/resolve`,
      body: { outcome: "release" },
    });
    expect(review.querySelector("[role=status]")?.textContent).toBe(
      "Done: verified. It leaves the queue on the next refresh.",
    );
    expect(release.textContent).toBe("Release (pay the worker)");
    // Decided: every action stays disabled, the clicked one included.
    expect([...review.querySelectorAll<HTMLButtonElement>(".actions button")].every((b) => b.disabled)).toBe(
      true,
    );
  });

  it("disables the actions after a refund with a note, and reports already-resolved and failures", async () => {
    let reply: () => Response = () => ok({ status: "refunded" });
    const page = await setup({
      [`GET /ops/tasks/${HELD}`]: () => ok(detail),
      [`POST /ops/tasks/${HELD}/resolve`]: () => reply(),
    });
    const { $, click, button, requests } = page;
    const row = $("queue").querySelector("tbody tr") as HTMLElement;
    row.dispatchEvent(new page.happy.KeyboardEvent("keydown", { key: "Enter" }) as unknown as Event);
    await page.settle();
    await page.settle();
    const review = $<HTMLDialogElement>("review-panel");
    const status = () => review.querySelector("[role=status]")?.textContent;
    const refund = () => button(review, "Refund (return to the agent)");
    (review.querySelector("textarea") as HTMLTextAreaElement).value = "  worker was at the wrong cafe ";
    await click(refund());
    expect(refund()).toBeUndefined();
    const armed = button(review, "Confirm: refund $6.00");
    reply = () => new Response("not json", { status: 502 });
    await click(armed);
    expect(status()).toBe("Failed: 502");
    expect(requests.at(-1)?.body).toEqual({ outcome: "refund", note: "worker was at the wrong cafe" });
    reply = () => ok({ error: "conflict" }, 409);
    await click(refund());
    await click(button(review, "Confirm: refund $6.00"));
    expect(status()).toBe("Failed: conflict");
    reply = () => ok({ already_resolved: true, status: "paid" });
    await click(refund());
    await click(button(review, "Confirm: refund $6.00"));
    expect(status()).toBe("Already paid; no money moved.");
    // Every action is disabled, then the clicked button's own `finally` enables it again (kept as before).
    const disabled = [...review.querySelectorAll<HTMLButtonElement>(".actions button")].map(
      (b) => b.disabled,
    );
    expect(disabled).toEqual([true, true]);
    await click(button(review, "Close"));
    expect(review.open).toBe(false);
  });

  it("opens with Space, shows a settled task, and shows load errors", async () => {
    let task: () => Response = () =>
      ok({
        ...detail,
        status: "paid",
        photo_url: null,
        answer_text: null,
        answer_bool: false,
        distance_m: null,
        gps_ok: null,
        vision_reason: null,
        dispute_reason: null,
      });
    const page = await setup({ [`GET /ops/tasks/${HELD}`]: () => task() });
    const { $ } = page;
    const row = $("queue").querySelector("tbody tr") as HTMLElement;
    const key = async (k: string) => {
      row.dispatchEvent(new page.happy.KeyboardEvent("keydown", { key: k }) as unknown as Event);
      await page.settle();
      await page.settle();
    };
    await key("Tab");
    expect(page.requests.some((r) => r.path.startsWith("/ops/tasks/"))).toBe(false);
    await key(" ");
    const review = $<HTMLDialogElement>("review-panel");
    expect(review.querySelector(".nophoto")?.textContent).toBe("No photo");
    expect(review.textContent).toContain("Answer: No");
    expect(review.textContent).toContain("worker ? away");
    expect(review.querySelector(".checklist")).toBeNull();
    expect(review.textContent).toContain("Settled: paid.");
    expect(review.querySelector(".actions")).toBeNull();

    task = () => ok({ ...detail, status: "paid", answer_text: null, answer_bool: null, photo_url: null });
    await key("Enter");
    expect(review.textContent).toContain("No answer submitted.");
    task = () => ok({ ...detail, answer_text: null, answer_bool: true });
    await key("Enter");
    expect(review.textContent).toContain("Answer: Yes");

    task = () => ok({ message: "task not found" }, 404);
    await key("Enter");
    expect(review.textContent).toBe("Could not load the task: task not foundClose");
    task = () => ok({ error: "bad_id" }, 400);
    await key("Enter");
    expect(review.textContent).toContain("Could not load the task: bad_id");
    review.close();
    task = () => new Response("oops", { status: 500 });
    await key("Enter");
    expect(review.open).toBe(true);
    expect(review.textContent).toContain("Could not load the task: 500");
  });
});

describe("ops support tickets", () => {
  const dispute = (over: Partial<Ticket> = {}) =>
    helpTicket({
      id: 9,
      kind: "dispute",
      status: "resolved",
      dispute_status: "open",
      message: null,
      photo_url: "https://cdn.eyes.test/d.jpg",
      gps_ok: true,
      fresh_ok: true,
      vision_ok: true,
      vision_reason: "nudity",
      answer_text: "yes",
      reversal_owed_cents: 250,
      worker_banned: true,
      ...over,
    });

  async function withTickets(tickets: Ticket[], post: Route = () => ok({})) {
    let list = tickets;
    const page = await setup({
      "GET /ops/tickets": () => ok({ tickets: list }),
      "POST /ops/tickets/7/release": post,
      "POST /ops/tickets/7/refund": post,
      "POST /ops/tickets/7/close": post,
      "POST /ops/tickets/9/confirm_fraud": post,
      "POST /ops/tickets/9/reject_dispute": post,
    });
    const setList = (next: Ticket[]) => {
      list = next;
    };
    const li = (id: number) =>
      [...page.$("tickets-list").children].find((el) => el.textContent?.includes(`#${id} `)) as HTMLElement;
    return { ...page, setList, li };
  }

  it("renders open, held, dispute and resolved tickets", async () => {
    const page = await withTickets([
      helpTicket(),
      helpTicket({ id: 8, task_status: "verified", message: null, distance_m: null }),
      dispute(),
      helpTicket({ id: 10, status: "resolved", resolved_at: "2026-10-17T13:00:00Z", note: "sorted" }),
      helpTicket({ id: 11, status: "resolved", resolved_at: null, note: null }),
      dispute({ id: 12, dispute_status: "upheld", message: "fake photo", reversal_owed_cents: 0 }),
      dispute({ id: 13, dispute_status: "rejected", worker_banned: false }),
      dispute({ id: 14, dispute_status: null, message: null }),
    ]);
    const { text, $, li } = page;
    // A dispute with no dispute_status yet counts as open, with its buttons, as its badge says.
    expect(text("tickets-count")).toBe("4 open");
    expect($("tickets-count").className).toBe("ui-badge ui-badge--danger");
    expect(text("n-support")).toBe("4");
    expect($("tickets-list").children).toHaveLength(4);
    await page.change("t-status", "");
    const labels = (id: number) => [...li(id).querySelectorAll("button")].map((b) => b.textContent);
    expect(labels(7)).toEqual(["Release", "Refund", "Resolve with note"]);
    expect(li(7).textContent).toContain("I was at the door");
    expect(li(7).querySelector("textarea")?.placeholder).toBe("Note, texted to the worker");
    expect(li(7).querySelector(".ui-badge")?.textContent).toBe("open");
    expect(labels(8)).toEqual(["Resolve with note"]);
    expect(li(8).textContent).toContain("(no message)");
    expect(li(8).textContent).toContain("worker ? from the place (radius 50 m)");
    expect(labels(9)).toEqual(["Confirm fraud: ban + refund", "Reject"]);
    expect(li(9).querySelector("textarea")?.placeholder).toBe("Note, kept with the decision");
    expect((li(9).querySelector("img") as HTMLImageElement).src).toBe("https://cdn.eyes.test/d.jpg");
    expect(li(9).textContent).toContain("Agent says: (no reason)");
    expect(li(9).textContent).toContain("Photo safety: nudity");
    expect(li(9).textContent).toContain("Answer: yes");
    expect(li(9).textContent).toContain(
      "reversal owed $2.50 the worker already moved the money; collect it by hand.",
    );
    expect(li(9).textContent).toContain("Worker banned.");
    expect([...li(9).querySelectorAll(".ui-badge")].map((b) => b.className)).toContain(
      "ui-badge ui-badge--warning",
    );
    expect(li(10).textContent).toMatch(/Resolved Oct 17.*: sorted/);
    expect(li(10).querySelector(".nophoto")).toBeTruthy();
    expect(li(11).textContent).toContain("Resolved : ");
    const badges = (id: number) =>
      [...li(id).querySelectorAll(".task-head .ui-badge")].map((b) => b.textContent);
    expect(badges(12)).toEqual(["dispute", "upheld"]);
    expect(li(12).querySelector(".ui-badge--warning:not(:first-child)")?.textContent).toBe("upheld");
    expect(li(12).textContent).toContain("Agent says: fake photo");
    expect(badges(13)).toEqual(["dispute", "rejected"]);
    expect(li(13).textContent).not.toContain("Worker banned.");
    expect(badges(14)).toEqual(["dispute", "open"]);
    expect(labels(14)).toEqual(["Confirm fraud: ban + refund", "Reject"]);
  });

  it("needs a note, then sends the action and reloads the tickets", async () => {
    const page = await withTickets([helpTicket(), dispute()], () => ok({}));
    const { li, click, button, requests } = page;
    const status = (id: number) => li(id).querySelector("[role=status]")?.textContent;
    await click(button(li(7), "Release"));
    await click(button(li(7), "Confirm: pay worker $5.00"));
    expect(status(7)).toBe("Write a note first; it is texted to the worker.");
    await click(button(li(9), "Reject"));
    await click(button(li(9), "Confirm: reject, the worker keeps the pay"));
    expect(status(9)).toBe("Write a note first; it is kept with the decision.");

    (li(7).querySelector("textarea") as HTMLTextAreaElement).value = "paid, thanks";
    page.setList([helpTicket({ status: "resolved", note: "paid, thanks" }), dispute()]);
    await click(button(li(7), "Refund"));
    const row = li(7);
    await click(button(row, "Confirm: refund the agent"));
    expect(requests.find((r) => r.path === "/ops/tickets/7/refund")?.body).toEqual({
      task_id: HELD,
      note: "paid, thanks",
    });
    expect(row.querySelector("[role=status]")?.textContent).toBe("Done: ticket #7 refund.");
    expect(page.text("tickets-count")).toBe("1 open");
    expect(li(7)).toBeUndefined();
    await page.change("t-status", "resolved");
    expect(li(7).textContent).toContain("paid, thanks");
  });

  it("reports dispute outcomes and failures", async () => {
    let reply: () => Response = () =>
      ok({ agent_refund_cents: 600, reversal: "owed", reversal_owed_cents: 450 });
    const page = await withTickets([dispute(), helpTicket()], () => reply());
    const { li, click, button, requests } = page;
    let round = 0;
    const run = async (id: number, label: string, armed: string) => {
      // A decided button stays disabled, so each round reloads a changed list and gets a fresh row.
      round++;
      page.setList([dispute({ note: `round ${round}` }), helpTicket({ note: `round ${round}` })]);
      const row = li(id);
      (row.querySelector("textarea") as HTMLTextAreaElement).value = "checked the photo";
      await click(button(row, label));
      await click(button(row, armed));
      return row.querySelector("[role=status]")?.textContent;
    };
    const fraud = [
      "Confirm fraud: ban + refund",
      "Confirm: refund the agent, reverse the payout, ban the worker",
    ] as const;
    expect(await run(9, ...fraud)).toBe(
      "Done: agent refunded $6.00, transfer reversal owed $4.50, worker banned.",
    );
    expect(requests.find((r) => r.path === "/ops/tickets/9/confirm_fraud")?.body).toEqual({
      note: "checked the photo",
    });
    reply = () => ok({ agent_refund_cents: 600, reversal: "reversed" });
    expect(await run(9, ...fraud)).toBe("Done: agent refunded $6.00, transfer reversed, worker banned.");
    reply = () => ok({});
    expect(await run(9, "Reject", "Confirm: reject, the worker keeps the pay")).toBe(
      "Done: ticket #9 reject dispute.",
    );
    reply = () => ok({ already_resolved: true, dispute_status: "upheld" });
    expect(await run(9, ...fraud)).toBe("Already upheld; no money moved.");
    reply = () => ok({ already_resolved: true });
    expect(await run(7, "Resolve with note", "Confirm: close, no money moves")).toBe(
      "Already resolved; no money moved.",
    );
    reply = () => ok({ message: "stripe down" }, 502);
    expect(await run(7, "Resolve with note", "Confirm: close, no money moves")).toBe("Failed: stripe down");
    reply = () => ok({ error: "gone" }, 410);
    expect(await run(7, "Release", "Confirm: pay worker $5.00")).toBe("Failed: gone");
    reply = () => new Response("", { status: 500 });
    expect(await run(7, "Release", "Confirm: pay worker $5.00")).toBe("Failed: 500");
  });

  it("filters, searches and pages the ticket list", async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      helpTicket({ id: 100 + i, question: i === 59 ? "Where is the Ferry Building?" : `Q${i}` }),
    );
    const page = await withTickets([...many, helpTicket({ id: 7, status: "resolved" })]);
    const { $, change, click } = page;
    expect($("tickets-list").children).toHaveLength(50);
    expect($("t-more").hidden).toBe(false);
    await click($("t-more"));
    expect($("tickets-list").children).toHaveLength(60);
    expect($("t-more").hidden).toBe(true);
    await change("t-status", "resolved");
    expect($("tickets-list").children).toHaveLength(1);
    await change("t-status", "");
    expect($("tickets-list").children).toHaveLength(50);
    await click($("t-more"));
    expect($("tickets-list").children).toHaveLength(61);
    await change("t-q", "ferry", "input");
    expect($("tickets-list").children).toHaveLength(1);
    await change("t-q", "nothing like this", "input");
    expect(page.text("tickets-list")).toBe("No tickets match.");
  });
});

describe("ops event log and tabs", () => {
  const ev = (id: number, extra: object = {}) => ({
    id,
    at: `2026-10-17T12:00:${String(id % 60).padStart(2, "0")}Z`,
    kind: "http",
    level: "info",
    summary: `e${id}`,
    ...extra,
  });

  it("sends filters to the server, debounces search, and filters by a task from an event's details", async () => {
    const page = await setup(
      {
        "GET /ops/events": () =>
          ok({
            source: "database",
            events: [ev(5, { task_id: HELD, data: { ms: 40 } })],
            next_cursor: null,
            newest_cursor: "n5",
          }),
      },
      { hash: "#logs" },
    );
    const { requests, timers, $, win } = page;
    const bar = $("events").querySelector(".tbl-bar") as HTMLElement;
    const [kind, level] = [...bar.querySelectorAll("select")];
    const set = async (el: Element | null | undefined, value: string, type = "change") => {
      (el as HTMLInputElement).value = value;
      el?.dispatchEvent(new page.happy.Event(type) as unknown as Event);
      await page.settle();
      await page.settle();
    };
    await set(kind, "payout");
    expect(requests.at(-1)?.path).toBe("/ops/events?kind=payout&limit=100");
    expect(win.location.hash).toBe("#logs?kind=payout");
    await set(level, "error");
    expect(requests.at(-1)?.path).toBe("/ops/events?kind=payout&level=error&limit=100");
    await set(bar.querySelector("input[type=search]"), " boom", "input");
    expect(timers.at(-1)?.ms).toBe(200);
    timers.at(-1)?.fn();
    await page.settle();
    await page.settle();
    expect(requests.at(-1)?.path).toBe("/ops/events?q=boom&kind=payout&level=error&limit=100");

    const row = $("events").querySelector("tbody tr") as HTMLElement;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    row.click();
    const detail = $("events").querySelector(".tbl-detail") as HTMLElement;
    expect(detail.querySelector(".ev-detail__data")?.textContent).toBe('{\n  "ms": 40\n}');
    await page.click(detail.querySelector("button") as HTMLElement);
    expect(requests.at(-1)?.path).toBe(
      `/ops/events?q=boom&kind=payout&level=error&task_id=${HELD}&limit=100`,
    );
    expect(win.location.hash).toBe(`#logs?q=boom&kind=payout&level=error&task=${HELD}`);
    ($("events").querySelector("tbody tr") as HTMLElement).click();
    expect($("events").querySelector(".tbl-detail")).toBeNull();
  });

  it("sorts the loaded events by any column without asking the server again", async () => {
    const page = await setup(
      {
        "GET /ops/events": () =>
          ok({
            source: "database",
            events: [ev(3, { level: "warn", kind: "text" }), ev(1, { level: "error" }), ev(2)],
            next_cursor: null,
            newest_cursor: "n",
          }),
      },
      { hash: "#logs" },
    );
    const { $, requests } = page;
    const before = requests.length;
    const sortBy = (label: string) =>
      (
        [...$("events").querySelectorAll("th button")].find((b) => b.textContent === label) as HTMLElement
      ).click();
    const ids = () => [...$("events").querySelectorAll(".ev-sum")].map((s) => s.textContent);
    sortBy("Time");
    expect(ids()).toEqual(["e3", "e2", "e1"]);
    sortBy("Level");
    expect(ids()).toEqual(["e1", "e2", "e3"]);
    sortBy("Source");
    expect(ids()[0]).toBe("e3");
    sortBy("Event");
    expect(ids()).toEqual(["e1", "e2", "e3"]);
    expect(requests.length).toBe(before);
  });

  it("loads older pages by cursor, without duplicates, and shows the end of the log", async () => {
    const pages: Record<string, unknown> = {
      first: { source: "database", events: [ev(9), ev(8)], next_cursor: "c8", newest_cursor: "n9" },
      c8: { source: "database", events: [ev(8), ev(7)], next_cursor: null, newest_cursor: "n8" },
    };
    let fail = false;
    const page = await setup({
      "GET /ops/events": (_init, url) =>
        fail ? new Response("", { status: 500 }) : ok(pages[url.searchParams.get("cursor") ?? "first"]),
    });
    const { $, requests } = page;
    const ids = () => [...$("events").querySelectorAll("tbody tr .ev-sum")].map((s) => s.textContent);
    const more = $("events").querySelector(".tbl-foot button") as HTMLButtonElement;
    expect(ids()).toEqual(["e9", "e8"]);
    expect(more.hidden).toBe(false);
    fail = true;
    await page.click(more);
    expect(more.hidden).toBe(false);
    fail = false;
    await page.click(more);
    expect(requests.at(-1)?.path).toBe("/ops/events?limit=100&cursor=c8");
    expect(ids()).toEqual(["e9", "e8", "e7"]);
    expect(more.hidden).toBe(true);
    expect($("events").querySelector(".tbl-end")?.textContent).toBe("End of events");
    const before = requests.length;
    await page.click(more);
    expect(requests.length).toBe(before);
  });

  it("holds new live events behind a pill until clicked, then puts them on top", async () => {
    let reply: unknown = { source: "database", events: [ev(5)], next_cursor: null, newest_cursor: "n5" };
    const page = await setup({ "GET /ops/events": () => ok(reply) });
    const { $, timers, requests } = page;
    const ids = () => [...$("events").querySelectorAll("tbody tr .ev-sum")].map((s) => s.textContent);
    const pill = $<HTMLButtonElement>("new-events");
    expect(pill.hidden).toBe(true);
    const tick = async () => {
      timers.at(-1)?.fn();
      await page.settle();
      await page.settle();
    };
    reply = { source: "database", events: [ev(7), ev(6)], next_cursor: null, newest_cursor: "n7" };
    await tick();
    expect(requests.at(-2)?.path).toBe("/ops/events?since=n5");
    expect([pill.hidden, pill.textContent]).toEqual([false, "2 new events"]);
    expect(ids()).toEqual(["e5"]);
    reply = { source: "database", events: [ev(7), ev(5)], next_cursor: null, newest_cursor: null };
    await tick();
    expect(requests.at(-2)?.path).toBe("/ops/events?since=n7");
    expect(pill.textContent).toBe("2 new events");
    reply = { source: "database", events: [ev(8)], next_cursor: null, newest_cursor: "n8" };
    await tick();
    expect(pill.textContent).toBe("3 new events");
    pill.click();
    expect(ids()).toEqual(["e8", "e7", "e6", "e5"]);
    expect(pill.hidden).toBe(true);
    reply = { source: "database", events: [ev(9)], next_cursor: null, newest_cursor: "n9" };
    await tick();
    expect(pill.textContent).toBe("1 new event");
  });

  it("drops a stale response when the filters change while it loads, and ignores failed polls", async () => {
    let first = true;
    // Promise.withResolvers is not in this repo's es2023 lib.
    let release: (res: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const page = await setup({
      "GET /ops/events": (_init, url) => {
        if (url.searchParams.get("since")) return new Response("", { status: 500 });
        if (url.searchParams.get("level") === "warn" && first) {
          first = false;
          return held;
        }
        return ok({
          source: "database",
          events: [ev(url.searchParams.get("level") ? 2 : 1)],
          next_cursor: null,
          newest_cursor: "n",
        });
      },
    });
    const { $, timers } = page;
    const level = $("events").querySelector(".tbl-bar select:nth-of-type(2)") as HTMLSelectElement;
    level.value = "warn";
    level.dispatchEvent(new page.happy.Event("change") as unknown as Event);
    level.value = "error";
    level.dispatchEvent(new page.happy.Event("change") as unknown as Event);
    await page.settle();
    await page.settle();
    release(ok({ source: "database", events: [ev(3)], next_cursor: null, newest_cursor: "n" }));
    await page.settle();
    await page.settle();
    expect([...$("events").querySelectorAll(".ev-sum")].map((s) => s.textContent)).toEqual(["e2"]);
    timers.at(-1)?.fn();
    await page.settle();
    await page.settle();
    expect([...$("events").querySelectorAll(".ev-sum")].map((s) => s.textContent)).toEqual(["e2"]);
    expect($<HTMLButtonElement>("new-events").hidden).toBe(true);
  });

  it("shows the tab from the hash and moves with the keyboard", async () => {
    const { L, calls } = leaflet();
    const page = await setup({}, { hash: "#support", L });
    const { $, win, happy } = page;
    const selected = () => [...$("tabs").querySelectorAll("[aria-selected=true]")].map((a) => a.id);
    expect(selected()).toEqual(["tab-support"]);
    expect($("p-support").hidden).toBe(false);
    expect($("p-overview").hidden).toBe(true);
    expect($("tab-support").tabIndex).toBe(0);
    expect($("tab-overview").tabIndex).toBe(-1);

    const key = (k: string) =>
      $("tabs").dispatchEvent(
        new happy.KeyboardEvent("keydown", { key: k, cancelable: true }) as unknown as Event,
      );
    $("tab-support").focus();
    expect(key("ArrowRight")).toBe(false);
    expect(win.location.hash).toBe("#tasks");
    expect(selected()).toEqual(["tab-tasks"]);
    expect(win.document.activeElement?.id).toBe("tab-tasks");
    key("End");
    expect(selected()).toEqual(["tab-logs"]);
    key("ArrowRight");
    expect(selected()).toEqual(["tab-overview"]);
    expect(key("Enter")).toBe(true);
    $("logout").focus();
    expect(key("ArrowRight")).toBe(true);
    expect(selected()).toEqual(["tab-overview"]);

    calls.length = 0;
    win.location.hash = "#workers";
    win.dispatchEvent(new happy.HashChangeEvent("hashchange") as unknown as Event);
    expect(selected()).toEqual(["tab-workers"]);
    expect(calls).toContain("invalidate");
    expect(calls).toContain('fit {"maxZoom":14}');
    win.location.hash = "#nope";
    win.dispatchEvent(new happy.HashChangeEvent("hashchange") as unknown as Event);
    expect(selected()).toEqual(["tab-overview"]);
  });

  it("opens the workers tab without a map when Leaflet is missing", async () => {
    const page = await setup({}, { hash: "#workers" });
    expect(page.$("p-workers").hidden).toBe(false);
    expect(page.$("map").classList.contains("nomap")).toBe(true);
  });

  it("sets the sticky offsets from the bar and tab heights on load and resize", async () => {
    const page = await setup();
    const style = page.doc.documentElement.style;
    expect(style.getPropertyValue("--bar-h")).toBe("0px");
    expect(style.getPropertyValue("--chrome")).toBe("0px");
    page.doc.querySelector(".bar")?.remove();
    page.win.dispatchEvent(new page.happy.Event("resize") as unknown as Event);
    expect(style.getPropertyValue("--bar-h")).toBe("0px");
  });
});

describe("ops page on its own host", () => {
  it("fetches, links and signs out without the /ops prefix", async () => {
    const page = await setup(
      { "POST /ops/logout": () => new Response(null, { status: 204 }) },
      { root: true },
    );
    expect(page.raw.slice(0, 4)).toEqual(["/feed", "/tickets", "/events", "/series"]);
    expect(page.doc.querySelector('a[href="/live"]')?.textContent).toBe("Live map");
    expect(page.doc.querySelector('a[href="/allowlist"]')).toBeTruthy();
    await page.click(page.$("logout"));
    expect(page.assign).toHaveBeenCalledWith("/login");
  });

  it("keeps the /ops prefix on loopback", async () => {
    const page = await setup();
    expect(page.doc.querySelector('a[href="/ops/live"]')).toBeTruthy();
  });
});

describe("ops review table", () => {
  const two = () => {
    const base = feed();
    const [held] = base.ops.queue as [Task];
    const disputed = {
      ...held,
      id: TASK_ID,
      status: "disputed",
      question: "Is the gate open?",
      bounty_cents: 900,
      created_at: "2026-10-17T13:00:00Z",
    };
    return feed({ queue: [held, disputed] });
  };

  it("restores search, sort and filters from the hash and writes changes back", async () => {
    const page = await setup(
      { "GET /ops/feed": () => ok(two()) },
      { hash: "#review?sort=-bounty&status=disputed" },
    );
    const { $, win, timers } = page;
    const rows = () =>
      [...$("queue").querySelectorAll("tbody tr")].map((tr) => tr.querySelector("td")?.textContent);
    expect(rows()).toEqual(["Is the gate open?"]);
    expect($("queue").querySelector("th[aria-sort=descending]")?.textContent).toBe("Bounty");
    const select = $("queue").querySelector("select") as HTMLSelectElement;
    select.value = "";
    select.dispatchEvent(new page.happy.Event("change") as unknown as Event);
    expect(rows()).toEqual(["Is the gate open?", "Is the line at Blue Bottle longer than 5 people?"]);
    expect(win.location.hash).toBe("#review?sort=-bounty");
    const search = $("queue").querySelector("input[type=search]") as HTMLInputElement;
    search.value = "blue bottle";
    search.dispatchEvent(new page.happy.Event("input") as unknown as Event);
    timers.at(-1)?.fn();
    expect(win.location.hash).toBe("#review?q=blue+bottle&sort=-bounty");
    expect(rows()).toEqual(["Is the line at Blue Bottle longer than 5 people?"]);
    const age = $("queue").querySelectorAll("tbody td")[5]?.textContent;
    expect(age).toMatch(/^(now|\d+[mhd])$/);
  });

  it("filters by created day and bounty, sorts by age, and opens rows from the recent tasks list too", async () => {
    const page = await setup({
      "GET /ops/feed": () => ok(two()),
      [`GET /ops/tasks/${HELD}`]: () => ok({ ...feed().tasks[0], fee_cents: 100 }),
    });
    const { $, timers, cleared } = page;
    const rows = () =>
      [...$("queue").querySelectorAll("tbody tr")].map((tr) => tr.querySelector("td")?.textContent);
    const set = (input: Element | undefined, value: string) => {
      (input as HTMLInputElement).value = value;
      input?.dispatchEvent(new page.happy.Event("change") as unknown as Event);
    };
    const [from, to, min, max] = [...$("queue").querySelectorAll(".tbl-range input")];
    set(from, "2026-10-17");
    set(to, "2026-10-17");
    expect(rows()).toHaveLength(2);
    set(min, "6");
    expect(rows()).toEqual(["Is the gate open?"]);
    set(max, "8");
    expect(rows()).toEqual([]);
    set(min, "");
    set(max, "");
    set(from, "");
    set(to, "");
    const age = [...$("queue").querySelectorAll("th button")].find(
      (b) => b.textContent === "Age",
    ) as HTMLElement;
    age.click();
    expect(rows()).toEqual(["Is the line at Blue Bottle longer than 5 people?", "Is the gate open?"]);
    const search = $("queue").querySelector("input[type=search]") as HTMLInputElement;
    search.dispatchEvent(new page.happy.Event("input") as unknown as Event);
    search.dispatchEvent(new page.happy.Event("input") as unknown as Event);
    expect(cleared).toContain(timers.length - 1);

    const item = $("task-list").querySelector("li.open") as HTMLElement;
    item.dispatchEvent(new page.happy.KeyboardEvent("keydown", { key: "x" }) as unknown as Event);
    expect(page.requests.some((r) => r.path.startsWith("/ops/tasks/"))).toBe(false);
    item.dispatchEvent(
      new page.happy.KeyboardEvent("keydown", { key: " ", cancelable: true }) as unknown as Event,
    );
    await page.settle();
    await page.settle();
    expect($<HTMLDialogElement>("review-panel").open).toBe(true);
    $<HTMLDialogElement>("review-panel").close();
    await page.click(item);
    expect($<HTMLDialogElement>("review-panel").open).toBe(true);
  });

  it("remembers a tab's table state when you leave and come back", async () => {
    const page = await setup({ "GET /ops/feed": () => ok(two()) }, { hash: "#review?q=gate" });
    const { win, happy, $ } = page;
    const key = (k: string) =>
      $("tabs").dispatchEvent(
        new happy.KeyboardEvent("keydown", { key: k, cancelable: true }) as unknown as Event,
      );
    $("tab-review").focus();
    key("ArrowRight");
    expect(win.location.hash).toBe("#support");
    key("ArrowLeft");
    expect(win.location.hash).toBe("#review?q=gate");
    win.location.hash = "#overview";
    win.dispatchEvent(new happy.HashChangeEvent("hashchange") as unknown as Event);
    win.location.hash = "#review";
    win.dispatchEvent(new happy.HashChangeEvent("hashchange") as unknown as Event);
    expect(win.location.hash).toBe("#review?q=gate");
    expect($("queue").querySelectorAll("tbody tr")).toHaveLength(1);
  });
});
