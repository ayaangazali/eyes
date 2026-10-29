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
      { id: "l1", type: "escrow", created_at: "2026-10-17T12:00:00Z", task_id: HELD, amount_cents: 600 },
      {
        id: "l2",
        type: "release",
        created_at: "2026-10-17T12:05:00Z",
        task_id: "99999999-0000",
        amount_cents: 500,
      },
      { id: "l3", type: "bonus", created_at: "2026-10-17T12:06:00Z", task_id: null, amount_cents: 100 },
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
    "GET /ops/tickets": () => ok({ tickets: [], total: 0, next_cursor: null }),
    "GET /ops/tasks": () => ok({ tasks: [], total: 0, next_cursor: null }),
    "GET /ops/ledger": () => ok({ ledger: [], total: 0, total_cents: 0, next_cursor: null }),
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
      "/ops/tickets?state=open&limit=50",
      "/ops/tickets?state=open&limit=1",
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
    const row = () => decision;
    expect([...decision.querySelectorAll("td")].map((td) => td.textContent).slice(0, 3)).toEqual([
      "Is the line at Blue Bottle longer than 5 people?",
      "Near 37.761, -122.386",
      "$5.00",
    ]);
    expect(row().getAttribute("aria-label")).toBe("Review: Is the line at Blue Bottle longer than 5 people?");

    expect(text("worker-stats")).toBe("2+opted in1available now3signed up");
    expect([...$("workers").querySelectorAll("tbody tr")].map((tr) => tr.textContent)).toEqual([
      "worker w-avail-availableon the map",
      "worker w-in-000opted inno location",
      "worker w-out-00opted outon the map",
    ]);
    expect(calls).toEqual([
      "map map",
      "clear",
      "marker 37.77,-122.42 #ffd60a",
      "marker 37.78,-122.41 #8f8f8f",
      'fit {"maxZoom":14}',
    ]);

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
    expect(text("worker-stats")).toBe("0opted in0available now0signed up");
    expect($("workers").querySelector(".tbl-empty")?.textContent).toBe("No workers yet.");
    expect($("map").classList.contains("nomap")).toBe(true);
    expect(text("map")).toBe("Map needs Leaflet from unpkg.com.");
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
    expect($("tickets").querySelector(".tbl-empty")?.textContent).toBe(
      "No tickets. A worker opens one by texting HELP after an answer is held for review.",
    );
    expect(text("tickets-count")).toBe("0 open");
    expect($("tickets-count").className).toBe("ui-badge ui-badge--success");
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
      "/ops/tickets?state=open&limit=50",
      "/ops/tickets?state=open&limit=1",
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

    const release = button(review, "Release to the worker");
    expect(release.className).toBe("ui-button ui-button--sm ui-button--primary");
    expect(review.querySelector("label")?.textContent).toBe("Note (optional)");
    await click(release);
    expect(review.querySelector(".decide__question")?.textContent).toBe(
      "Pay the worker $5.00? The task is marked verified.",
    );
    await click(button(review, "Cancel"));
    expect(review.querySelector(".decide__question")).toBeNull();
    expect(requests.some((r) => r.method === "POST")).toBe(false);
    await click(button(review, "Release to the worker"));
    await click(button(review, "Release $5.00"));
    expect(requests.at(-1)).toEqual({
      method: "POST",
      path: `/ops/tasks/${HELD}/resolve`,
      body: { outcome: "release" },
    });
    expect(review.querySelector(".decide__status")?.textContent).toBe(
      "Done: verified. It leaves the queue on the next refresh.",
    );
    // Decided: no buttons left to press, and a toast says what happened.
    expect(review.querySelectorAll(".decide__row button")).toHaveLength(0);
    expect(page.doc.querySelector(".toast")?.textContent).toBe(
      "Done: verified. It leaves the queue on the next refresh.",
    );
    expect(timers.at(-1)?.ms).toBe(4000);
  });

  it("refunds from the menu with a note, and reports failures and an already-resolved task", async () => {
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
    const status = () => review.querySelector(".decide__status")?.textContent;
    const refund = async () => {
      await click(button(review, "More actions"));
      await click(button(review, "Refund the agent"));
      await click(button(review, "Refund $6.00"));
    };
    (review.querySelector("textarea") as HTMLTextAreaElement).value = "  worker was at the wrong cafe ";
    reply = () => new Response("not json", { status: 502 });
    await refund();
    expect(status()).toBe("Failed: 502");
    expect(requests.at(-1)?.body).toEqual({ outcome: "refund", note: "worker was at the wrong cafe" });
    reply = () => ok({ error: "conflict" }, 409);
    await refund();
    expect(status()).toBe("Failed: conflict");
    reply = () => ok({ already_resolved: true, status: "paid" });
    await refund();
    expect(status()).toBe("Already paid; no money moved.");
    expect(review.querySelectorAll(".decide__row button")).toHaveLength(0);
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

  async function withTickets(first: Ticket[], post: Route = () => ok({}), opts: { open?: number } = {}) {
    let list = first;
    let pages: Record<string, { tickets: Ticket[]; next_cursor: string | null }> = {};
    const page = await setup(
      {
        "GET /ops/tickets": (_init, url) => {
          if (url.searchParams.get("limit") === "1") return ok({ tickets: [], total: opts.open ?? 2 });
          const cursor = url.searchParams.get("cursor");
          if (cursor) return ok({ ...pages[cursor], total: 99 });
          return ok({ tickets: list, total: list.length, next_cursor: pages.c1 ? "c1" : null });
        },
        "POST /ops/tickets/7/release": post,
        "POST /ops/tickets/7/refund": post,
        "POST /ops/tickets/7/close": post,
        "POST /ops/tickets/9/confirm_fraud": post,
        "POST /ops/tickets/9/reject_dispute": post,
      },
      { hash: "#support" },
    );
    const rows = () => [...page.$("tickets").querySelectorAll("tbody tr")] as HTMLElement[];
    const open = async (id: number) => {
      await page.click(rows().find((tr) => tr.textContent?.includes(`#${id} `)) as HTMLElement);
      return page.$<HTMLDialogElement>("review-panel");
    };
    return {
      ...page,
      rows,
      open,
      setList: (next: Ticket[]) => {
        list = next;
      },
      setPages: (next: typeof pages) => {
        pages = next;
      },
    };
  }

  it("lists open tickets by default with kind, state, place, bounty, distance and age", async () => {
    const page = await withTickets([helpTicket(), dispute(), helpTicket({ id: 8, distance_m: null })]);
    const { rows, text, $, requests } = page;
    expect(requests.find((r) => r.path.startsWith("/ops/tickets"))?.path).toBe(
      "/ops/tickets?state=open&limit=50",
    );
    expect(text("tickets-count")).toBe("2 open");
    expect($("tickets-count").className).toBe("ui-badge ui-badge--danger");
    expect(text("n-support")).toBe("2");
    expect([...(rows()[1]?.querySelectorAll("td") ?? [])].map((td) => td.textContent)).toEqual([
      "#9 Is the cafe open?",
      "Dispute",
      "open",
      "Mint Plaza",
      "$5.00",
      "12 m",
      expect.stringMatching(/^(now|\d+[mhd])$/),
    ]);
    expect(rows()[2]?.querySelectorAll("td")[5]?.textContent).toBe("?");
    expect($("tickets").querySelector(".tbl-select, select")?.getAttribute("aria-label")).toBe("States");
  });

  it("needs a note, then releases a held ticket, says so, and reloads the list", async () => {
    const page = await withTickets([helpTicket()], () => ok({}));
    const { open, click, button, requests } = page;
    const panel = await open(7);
    expect(panel.querySelector("h2")?.textContent).toBe("Ticket #7");
    expect(panel.querySelector("label")?.textContent).toBe("Note to the worker");
    await click(button(panel, "Release to the worker"));
    const note = panel.querySelector("textarea") as HTMLTextAreaElement;
    expect(panel.querySelector(".decide__status")?.textContent).toBe(
      "Write a note first. Texted to the worker.",
    );
    expect(note.getAttribute("aria-invalid")).toBe("true");
    expect(page.doc.activeElement).toBe(note);
    note.value = "paid, thanks";
    note.dispatchEvent(new page.happy.Event("input") as unknown as Event);
    expect(note.hasAttribute("aria-invalid")).toBe(false);
    await click(button(panel, "Release to the worker"));
    expect(panel.querySelector(".decide__question")?.textContent).toBe(
      "Pay the worker $5.00? They get your note by text.",
    );
    const before = requests.length;
    await click(button(panel, "Release $5.00"));
    expect(requests.slice(before).map((r) => r.path)).toEqual([
      "/ops/tickets/7/release",
      "/ops/tickets?state=open&limit=50",
      "/ops/tickets?state=open&limit=1",
    ]);
    expect(requests[before]?.body).toEqual({ task_id: HELD, note: "paid, thanks" });
    expect(panel.querySelector(".decide__status")?.textContent).toBe("Done: ticket #7 release.");
    expect(page.doc.querySelector(".toast")?.textContent).toBe("Done: ticket #7 release.");
  });

  it("offers refund and resolve in the menu of a held ticket, and only resolve when nothing is held", async () => {
    const page = await withTickets([
      helpTicket(),
      helpTicket({ id: 8, task_status: "verified", message: null }),
    ]);
    const { open, click, button } = page;
    let panel = await open(7);
    await click(button(panel, "More actions"));
    expect([...panel.querySelectorAll("[role=menuitem]")].map((b) => b.textContent)).toEqual([
      "Refund the agent",
      "Resolve with note",
    ]);
    panel = await open(8);
    expect([...panel.querySelectorAll(".decide__row button")].map((b) => b.textContent)).toEqual([
      "Resolve with note",
    ]);
    expect(panel.textContent).toContain("(no message)");
    expect(panel.textContent).toContain("answer taken 12 m from the place (radius 50 m)");
  });

  it("rejects or confirms a dispute and reports each outcome", async () => {
    let reply: () => Response = () =>
      ok({ agent_refund_cents: 600, reversal: "owed", reversal_owed_cents: 450 });
    const page = await withTickets([dispute()], () => reply());
    const { open, click, button, requests } = page;
    const run = async (menu: boolean, label: string, verb: string) => {
      const panel = await open(9);
      (panel.querySelector("textarea") as HTMLTextAreaElement).value = "checked the photo";
      if (menu) await click(button(panel, "More actions"));
      await click(button(panel, label));
      await click(button(panel, verb));
      return panel.querySelector(".decide__status")?.textContent;
    };
    const panel = await open(9);
    expect(panel.querySelector("label")?.textContent).toBe("Note");
    expect(panel.textContent).toContain("Agent says: (no reason)");
    expect(panel.textContent).toContain("Photo safety: nudity");
    expect(panel.textContent).toContain(
      "reversal owed $2.50 the worker already moved the money; collect it by hand.",
    );
    expect(panel.textContent).toContain("Worker banned.");
    expect(await run(true, "Confirm fraud", "Confirm fraud")).toBe(
      "Done: agent refunded $6.00, transfer reversal owed $4.50, worker banned.",
    );
    expect(requests.find((r) => r.path === "/ops/tickets/9/confirm_fraud")?.body).toEqual({
      note: "checked the photo",
    });
    reply = () => ok({ agent_refund_cents: 600, reversal: "reversed" });
    expect(await run(true, "Confirm fraud", "Confirm fraud")).toBe(
      "Done: agent refunded $6.00, transfer reversed, worker banned.",
    );
    reply = () => ok({});
    expect(await run(false, "Reject the dispute", "Reject dispute")).toBe("Done: ticket #9 reject dispute.");
    reply = () => ok({ already_resolved: true, dispute_status: "upheld" });
    expect(await run(false, "Reject the dispute", "Reject dispute")).toBe("Already upheld; no money moved.");
    reply = () => ok({ already_resolved: true });
    expect(await run(false, "Reject the dispute", "Reject dispute")).toBe(
      "Already resolved; no money moved.",
    );
    reply = () => ok({ message: "stripe down" }, 502);
    expect(await run(false, "Reject the dispute", "Reject dispute")).toBe("Failed: stripe down");
    reply = () => ok({ error: "gone" }, 410);
    expect(await run(false, "Reject the dispute", "Reject dispute")).toBe("Failed: gone");
    reply = () => new Response("", { status: 500 });
    expect(await run(false, "Reject the dispute", "Reject dispute")).toBe("Failed: 500");
  });

  it("shows a resolved ticket's outcome and a decided dispute's state, with no actions", async () => {
    const page = await withTickets([
      helpTicket({ id: 10, status: "resolved", resolved_at: "2026-10-17T13:00:00Z", note: "sorted" }),
      helpTicket({ id: 11, status: "resolved", resolved_at: null, note: null }),
      dispute({
        id: 12,
        dispute_status: "upheld",
        message: "fake photo",
        reversal_owed_cents: 0,
        worker_banned: false,
      }),
      dispute({ id: 13, dispute_status: "rejected" }),
    ]);
    const { open, rows } = page;
    expect(rows().map((tr) => tr.querySelector(".ui-badge")?.className)).toEqual([
      "ui-badge ui-badge--success",
      "ui-badge ui-badge--success",
      "ui-badge ui-badge--warning",
      "ui-badge ui-badge--success",
    ]);
    let panel = await open(10);
    expect(panel.textContent).toMatch(/Resolved Oct 17.*: sorted/);
    expect(panel.querySelector(".decide")).toBeNull();
    panel = await open(11);
    expect(panel.textContent).toContain("Resolved ");
    expect(panel.textContent).not.toContain("Resolved :");
    panel = await open(12);
    expect(panel.textContent).toContain("Agent says: fake photo");
    expect(panel.textContent).not.toContain("Worker banned.");
    expect(panel.querySelector(".decide")).toBeNull();
  });

  it("sorts loaded tickets by every column, closes the panel, and survives a failed or stale load", async () => {
    const page = await withTickets([
      helpTicket({
        id: 3,
        bounty_cents: undefined,
        distance_m: null,
        created_at: undefined,
        place_label: "B",
      }),
      helpTicket({
        id: 5,
        kind: "dispute",
        dispute_status: "open",
        bounty_cents: 900,
        distance_m: 40,
        place_label: "A",
      }),
    ]);
    const { $, rows, click, button } = page;
    const ids = () => rows().map((tr) => tr.querySelector("td")?.textContent?.slice(0, 2));
    const sortBy = (label: string) =>
      (
        [...$("tickets").querySelectorAll("th button")].find((b) => b.textContent === label) as HTMLElement
      ).click();
    for (const [label, first] of [
      ["Ticket", "#3"],
      ["Kind", "#5"],
      ["State", "#3"],
      ["Place", "#5"],
      ["Bounty", "#5"],
      ["Answer distance", "#3"],
      ["Opened", "#3"],
    ] as const) {
      sortBy(label);
      expect(ids()[0], label).toBe(first);
    }
    const panel = await page.open(3);
    await click(button(panel, "Close"));
    expect(panel.open).toBe(false);
  });

  it("ignores a second load-more while one is running, and keeps the pager after a failed page", async () => {
    let fail = false;
    let hold: ((r: Response) => void) | null = null;
    const page = await setup(
      {
        "GET /ops/tickets": (_init, url) => {
          if (url.searchParams.get("limit") === "1") return ok({ tickets: [], total: 0 });
          if (fail) return new Response("", { status: 500 });
          if (url.searchParams.get("cursor"))
            return new Promise<Response>((resolve) => {
              hold = resolve;
            });
          return ok({ tickets: [helpTicket()], total: 2, next_cursor: "c1" });
        },
      },
      { hash: "#support" },
    );
    const { $, requests } = page;
    const more = $("tickets").querySelector(".tbl-foot button") as HTMLButtonElement;
    more.click();
    await page.settle();
    expect($("tickets").querySelector(".tbl-end")?.textContent).toBe("Loading…");
    const before = requests.length;
    // The pager is hidden while loading; a stray call (an observer firing twice) is ignored too.
    more.hidden = false;
    more.click();
    expect(requests.length).toBe(before);
    (hold as unknown as (r: Response) => void)(ok({ tickets: [], total: 2, next_cursor: null }));
    await page.settle();
    await page.settle();
    fail = true;
    page.timers.find((t) => t.ms === 10000)?.fn();
    await page.settle();
    await page.settle();
    expect($("tickets").querySelector(".tbl-end")?.textContent).toBe("End of tickets");
  });

  it("drops a ticket page that arrives after the filters changed", async () => {
    let release: (r: Response) => void = () => {};
    let first = true;
    const page = await setup(
      {
        "GET /ops/tickets": (_init, url) => {
          if (url.searchParams.get("limit") === "1") return ok({ tickets: [], total: 0 });
          if (url.searchParams.get("kind") === "dispute" && first) {
            first = false;
            return new Promise<Response>((resolve) => {
              release = resolve;
            });
          }
          return ok({
            tickets: [helpTicket({ id: url.searchParams.get("kind") ? 8 : 7 })],
            total: 1,
            next_cursor: null,
          });
        },
      },
      { hash: "#support" },
    );
    const kind = page.$("tickets").querySelectorAll(".tbl-bar select")[1] as HTMLSelectElement;
    for (const v of ["dispute", "manual_review"]) {
      kind.value = v;
      kind.dispatchEvent(new page.happy.Event("change") as unknown as Event);
    }
    await page.settle();
    await page.settle();
    release(ok({ tickets: [helpTicket({ id: 9 })], total: 1, next_cursor: null }));
    await page.settle();
    await page.settle();
    expect(page.$("tickets").querySelector("tbody td")?.textContent?.slice(0, 2)).toBe("#8");
  });

  it("sends filters and search to the server, pages with the cursor, and keeps older pages across polls", async () => {
    const page = await withTickets([helpTicket()]);
    const { $, requests, rows, timers, setPages, setList } = page;
    const bar = $("tickets").querySelector(".tbl-bar") as HTMLElement;
    const [state, kind] = [...bar.querySelectorAll("select")] as HTMLSelectElement[];
    const set = async (el: HTMLElement | null | undefined, value: string, type = "change") => {
      (el as HTMLInputElement).value = value;
      el?.dispatchEvent(new page.happy.Event(type) as unknown as Event);
      await page.settle();
      await page.settle();
    };
    await set(state, "");
    expect(requests.at(-1)?.path).toBe("/ops/tickets?limit=50");
    await set(kind, "dispute");
    expect(requests.at(-1)?.path).toBe("/ops/tickets?kind=dispute&limit=50");
    await set(bar.querySelector("input[type=search]") as HTMLElement, "gate", "input");
    timers.at(-1)?.fn();
    await page.settle();
    await page.settle();
    expect(requests.at(-1)?.path).toBe("/ops/tickets?q=gate&kind=dispute&limit=50");
    expect(page.win.location.hash).toBe("#support?q=gate&kind=dispute");

    setPages({
      c1: { tickets: [helpTicket({ id: 6, created_at: "2026-10-17T11:00:00Z" })], next_cursor: null },
    });
    await set(kind, "");
    expect(rows()).toHaveLength(1);
    await page.click($("tickets").querySelector(".tbl-foot button") as HTMLElement);
    expect(requests.at(-1)?.path).toBe("/ops/tickets?q=gate&limit=50&cursor=c1");
    expect(rows().map((tr) => tr.querySelector("td")?.textContent?.slice(0, 2))).toEqual(["#7", "#6"]);
    expect($("tickets").querySelector(".tbl-count")?.textContent).toBe("2 of 99 tickets loaded");
    // A poll refreshes the first page and keeps the older one.
    setList([helpTicket({ message: "updated" })]);
    timers.find((t) => t.ms === 10000)?.fn();
    await page.settle();
    await page.settle();
    expect(rows().map((tr) => tr.querySelector("td")?.textContent?.slice(0, 2))).toEqual(["#7", "#6"]);
  });
});

describe("ops tasks, money and workers tabs", () => {
  const task = (over: Partial<Task> = {}): Task => ({
    ...(feed().tasks[0] as Task),
    agent: "trip-planner",
    distance_m: 14,
    ...over,
  });

  it("pages tasks from the server with status and search, shows agent and distance, and opens a task with its timeline", async () => {
    const page = await setup(
      {
        "GET /ops/tasks": (_init, url) =>
          ok({
            tasks: url.searchParams.get("cursor")
              ? [task({ id: TASK_ID, question: "Older", created_at: "2026-10-16T12:00:00Z" })]
              : [
                  task(),
                  task({
                    id: "33333333-2222-4333-8444-555555555555",
                    status: "paid",
                    agent: null,
                    distance_m: null,
                    money_at: null,
                    claimed_at: null,
                    bounty_cents: undefined,
                  }),
                ],
            total: 3,
            next_cursor: url.searchParams.get("cursor") ? null : "c1",
          }),
        [`GET /ops/tasks/${HELD}`]: () => ok({ ...feed().tasks[0], fee_cents: 100 }),
        "GET /ops/tasks/33333333-2222-4333-8444-555555555555": () =>
          ok({
            ...feed().tasks[0],
            id: "33333333-2222-4333-8444-555555555555",
            status: "paid",
            fee_cents: 100,
          }),
      },
      { hash: "#tasks" },
    );
    const { $, requests, click } = page;
    expect(requests.find((r) => r.path.startsWith("/ops/tasks"))?.path).toBe("/ops/tasks?limit=50");
    const rows = () => [...$("tasks").querySelectorAll("tbody tr")] as HTMLElement[];
    expect([...(rows()[0]?.querySelectorAll("td") ?? [])].map((td) => td.textContent)).toEqual([
      "Is the line at Blue Bottle longer than 5 people?",
      "Near 37.761, -122.386",
      "$5.00",
      "14 m",
      "needs review",
      expect.stringMatching(/^(now|\d+[mhd])$/),
      "trip-planner",
    ]);
    expect(rows()[1]?.querySelectorAll("td")[3]?.textContent).toBe("");
    await click($("tasks").querySelector(".tbl-foot button") as HTMLElement);
    expect(requests.at(-1)?.path).toBe("/ops/tasks?limit=50&cursor=c1");
    expect($("tasks").querySelector(".tbl-count")?.textContent).toBe("3 of 3 tasks loaded");
    const status = $("tasks").querySelector(".tbl-bar select") as HTMLSelectElement;
    status.value = "paid";
    status.dispatchEvent(new page.happy.Event("change") as unknown as Event);
    await page.settle();
    expect(requests.at(-1)?.path).toBe("/ops/tasks?status=paid&limit=50");
    for (const label of ["Bounty", "Worker distance", "Age", "Agent"])
      (
        [...$("tasks").querySelectorAll("th button")].find((b) => b.textContent === label) as HTMLElement
      ).click();
    await click(rows().find((tr) => tr.textContent?.includes("trip-planner")) as HTMLElement);
    const panel = $<HTMLDialogElement>("review-panel");
    expect(panel.open).toBe(true);
    const flow = [...(panel.querySelector(".flow")?.children ?? [])].map((s) => s.textContent);
    expect(flow.slice(1)).toEqual([
      "claimed +30s",
      "answered +4m",
      "released +5m",
      "paid out +6m",
      "refunded +7m",
      "fee +8m",
    ]);
    expect(flow[0]).toMatch(/^asked Oct 17/);
    panel.close();
    await click(rows().find((tr) => tr.textContent?.includes("paid")) as HTMLElement);
    expect(
      [...(panel.querySelector(".flow")?.children ?? [])].map((s) => s.textContent?.split(" ")[0]),
    ).toEqual(["asked", "answered"]);
  });

  it("refreshes tasks and the ledger with the feed only while their tab is shown, and survives going offline", async () => {
    let offline = false;
    const page = await setup({
      "GET /ops/tasks": () => {
        if (offline) throw new TypeError("Failed to fetch");
        return ok({ tasks: [], total: 0, next_cursor: null });
      },
    });
    const { requests, timers, win, happy } = page;
    const poll = async () => {
      timers
        .filter((t) => t.ms === 10000)
        .at(-1)
        ?.fn();
      await page.settle();
      await page.settle();
    };
    await poll();
    expect(requests.some((r) => r.path.startsWith("/ops/tasks") || r.path.startsWith("/ops/ledger"))).toBe(
      false,
    );
    win.location.hash = "#money";
    win.dispatchEvent(new happy.HashChangeEvent("hashchange") as unknown as Event);
    await page.settle();
    expect(requests.filter((r) => r.path.startsWith("/ops/ledger"))).toHaveLength(1);
    await poll();
    expect(requests.filter((r) => r.path.startsWith("/ops/ledger"))).toHaveLength(2);
    win.location.hash = "#tasks";
    win.dispatchEvent(new happy.HashChangeEvent("hashchange") as unknown as Event);
    await poll();
    expect(requests.filter((r) => r.path.startsWith("/ops/tasks"))).toHaveLength(2);
    offline = true;
    await poll();
    expect(page.$("tasks").querySelector(".tbl-end")?.textContent).toBe("");
  });

  it("pages the ledger with type and search, with the total for the filters", async () => {
    const page = await setup(
      {
        "GET /ops/ledger": (_init, url) =>
          ok({
            ledger: [
              {
                id: "l1",
                type: "fee",
                created_at: "2026-10-17T12:00:00Z",
                task_id: HELD,
                place_label: "37.76123, -122.38599",
                amount_cents: 50,
              },
              {
                id: "l2",
                type: "topup",
                created_at: "2026-10-17T11:00:00Z",
                task_id: null,
                amount_cents: 2000,
              },
              { id: "l3", type: "bonus", created_at: "2026-10-17T10:00:00Z", task_id: null, amount_cents: 1 },
            ],
            total: url.searchParams.get("type") ? 1 : 3,
            total_cents: url.searchParams.get("type") ? 50 : 2051,
            next_cursor: null,
          }),
      },
      { hash: "#money" },
    );
    const { $, text, requests } = page;
    expect(text("ledger-total")).toBe("$20.51 across 3 rows");
    expect(
      [...$("ledger").querySelectorAll("tbody tr")].map((tr) =>
        tr.textContent?.replace(/^Oct 17.*?(AM|PM)/, ""),
      ),
    ).toEqual(["Fee$0.50Near 37.761, -122.386 22222222", "Top-up$20.00", "bonus$0.01"]);
    const type = $("ledger").querySelector(".tbl-bar select") as HTMLSelectElement;
    type.value = "fee";
    type.dispatchEvent(new page.happy.Event("change") as unknown as Event);
    await page.settle();
    await page.settle();
    expect(requests.at(-1)?.path).toBe("/ops/ledger?type=fee&limit=50");
    expect(text("ledger-total")).toBe("$0.50 across 1 row");
    for (const label of ["Date", "Type", "Amount", "Task"])
      (
        [...$("ledger").querySelectorAll("th button")].find((b) => b.textContent === label) as HTMLElement
      ).click();
  });

  it("filters workers by state and location, and the map shows only those markers", async () => {
    const { L, calls } = leaflet();
    const page = await setup({}, { hash: "#workers", L });
    const { $ } = page;
    const [state, location] = [...$("workers").querySelectorAll(".tbl-bar select")] as HTMLSelectElement[];
    const pick = (select: HTMLSelectElement | undefined, value: string) => {
      (select as HTMLSelectElement).value = value;
      select?.dispatchEvent(new page.happy.Event("change") as unknown as Event);
    };
    calls.length = 0;
    pick(state, "available");
    expect([...$("workers").querySelectorAll("tbody tr")]).toHaveLength(1);
    expect(calls).toEqual(["clear", "marker 37.77,-122.42 #ffd60a"]);
    pick(state, "");
    calls.length = 0;
    pick(location, "no location");
    expect($("workers").querySelector("tbody tr")?.textContent).toContain("no location");
    expect(calls).toEqual(["clear"]);
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
    expect(page.raw.slice(0, 5)).toEqual(["/feed", "/tickets", "/tickets", "/events", "/series"]);
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

  it("filters by created day and bounty, and sorts by age", async () => {
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
    expect(win.location.hash).toBe("#support?state=open");
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
