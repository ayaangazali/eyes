import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const PAGE = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
const LEAFLET_TAG = /<script src="https:\/\/unpkg\.com\/leaflet[^"]*"[^>]*><\/script>/;
const NO_LEAFLET = PAGE.replace(LEAFLET_TAG, "");
const ORIGIN = "http://dashboard.test";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const NOW = Date.now();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

type Row = Record<string, unknown>;
type Reply = { status: number; json: unknown } | "abort";
const ok = (json: unknown): Reply => ({ status: 200, json });
const fail = (status: number): Reply => ({ status, json: { error: "boom" } });

const BLUE_BOTTLE = "Blue Bottle Coffee, Mint Plaza, San Francisco";
const COORDS = "37.78246, -122.40776";

function task(over: Row): Row {
  return {
    id: "t1",
    status: "dispatched",
    question: "Is oat milk in stock?",
    place_label: BLUE_BOTTLE,
    lat: 37.78246,
    lng: -122.40776,
    bounty_cents: 300,
    fee_cents: 60,
    workers_notified: 3,
    created_at: minutesAgo(10),
    deadline_at: minutesAgo(-20),
    claimed_at: null,
    submitted_at: null,
    photo_url: null,
    gps_ok: null,
    fresh_ok: null,
    vision_ok: null,
    confidence: null,
    money_at: {},
    ...over,
  };
}

function feed(over: Row = {}): Row {
  return {
    tasks: [],
    ledger: [],
    workers: [],
    totals: { escrowed_cents: 0, released_today_cents: 0, paid_out_today_cents: 0 },
    ...over,
  };
}

// Serves the page and /feed from the test. Leaflet and map tiles are blocked unless `html` omits the tag.
async function open(
  page: Page,
  opts: { path?: string; html?: string; feedFor?: () => Reply } = {},
): Promise<string[]> {
  const paths: string[] = [];
  const feedFor = opts.feedFor ?? (() => ok(feed()));
  await page.route("https://unpkg.com/**", (r) => r.abort());
  await page.route("https://tile.openstreetmap.org/**", (r) => r.abort());
  await page.route(`${ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    paths.push(pathname);
    if (pathname.startsWith("/photo/")) {
      if (pathname.includes("broken")) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    }
    if (pathname.endsWith("/feed")) {
      const reply = feedFor();
      if (reply === "abort") return route.abort();
      return route.fulfill({
        status: reply.status,
        contentType: "application/json",
        body: JSON.stringify(reply.json),
      });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: opts.html ?? PAGE });
  });
  await page.goto(`${ORIGIN}${opts.path ?? "/"}`);
  return paths;
}

test.describe("dashboard index.html inline script", () => {
  test("renders the active task, its steps, the ledger, and totals", async ({ page }) => {
    await open(page, {
      feedFor: () =>
        ok(
          feed({
            tasks: [task({ id: "t1", status: "dispatched" })],
            workers: [{ id: "w1", lat: 37.78, lng: -122.41, available: true, opted_in: true }],
            ledger: [{ type: "escrow", task_id: "t1", created_at: minutesAgo(9), amount_cents: 360 }],
            totals: { escrowed_cents: 360, released_today_cents: 0, paid_out_today_cents: 0 },
          }),
        ),
    });
    await expect(page.locator("#online")).toHaveText("1 worker online");
    await expect(page.locator("#chip")).toHaveText("Waiting for a yes");
    await expect(page.locator("#headline")).toHaveText("3 workers notified near Blue Bottle Coffee");
    await expect(page.locator("#question")).toHaveText("“Is oat milk in stock?”");
    await expect(page.locator("#cost")).toContainText("$3.00 to the worker + $0.60 fee, expires");
    await expect(page.locator("#steps li.done")).toHaveCount(2);
    await expect(page.locator("#steps li.next b")).toHaveText("Claimed");
    await expect(page.locator("#escrowed")).toHaveText("$3.60");
    await expect(page.locator("#ledger .what")).toContainText("Held in escrow");
    await expect(page.locator("#ledger .what span")).toHaveText(
      "Blue Bottle Coffee, Mint Plaza, San Francisco",
    );
    await expect(page.locator("#ledger .amt")).toHaveText("$3.60");
    await expect(page.locator("#proof")).toBeHidden();
    await expect(page.locator("#live")).toHaveText("Live");
    await expect(page.locator("#live")).toHaveClass("ok");
  });

  test("shows the offline message on an HTTP error, then recovers", async ({ page }) => {
    let calls = 0;
    await open(page, { feedFor: () => (calls++ === 0 ? fail(500) : ok(feed())) });
    await expect(page.locator("#live")).toHaveText("Feed offline (HTTP 500), retrying");
    await expect(page.locator("#live")).toHaveClass("down");
    await expect(page.locator("#live")).toHaveText("Live", { timeout: 6000 });
  });

  test("shows the offline message when the request fails at the network level", async ({ page }) => {
    await open(page, { feedFor: () => "abort" });
    await expect(page.locator("#live")).toHaveText("Feed offline (Failed to fetch), retrying");
    await expect(page.locator("#live")).toHaveClass("down");
  });

  test("polls /feed when the page is served at /live", async ({ page }) => {
    const paths = await open(page, { path: "/live" });
    await expect(page.locator("#live")).toHaveText("Live");
    expect(paths).toContain("/feed");
  });

  test("empty feed shows the empty states and no headline", async ({ page }) => {
    await open(page);
    await expect(page.locator("#online")).toHaveText("0 workers online");
    await expect(page.locator("#headline")).toHaveText("Waiting for an agent to ask");
    await expect(page.locator("#question")).toHaveText(
      "When an agent asks about a place, the task shows up here.",
    );
    await expect(page.locator("#tasks li.empty")).toHaveText("None yet.");
    await expect(page.locator("#ledger li.empty")).toHaveText("No money has moved yet.");
    await expect(page.locator("#proof")).toBeHidden();
  });

  test("uses singular wording for one notified worker", async ({ page }) => {
    await open(page, {
      feedFor: () => ok(feed({ tasks: [task({ id: "t1", status: "dispatched", workers_notified: 1 })] })),
    });
    await expect(page.locator("#headline")).toHaveText("1 worker notified near Blue Bottle Coffee");
    await expect(page.locator("#steps li:nth-child(2) b")).toHaveText("1 notified");
  });

  test("shows the photo checks and confidence for a submitted answer", async ({ page }) => {
    await open(page, {
      feedFor: () =>
        ok(
          feed({
            tasks: [
              task({
                id: "t2",
                status: "submitted",
                claimed_at: minutesAgo(5),
                submitted_at: minutesAgo(2),
                photo_url: `${ORIGIN}/photo/ok.png`,
                gps_ok: true,
                fresh_ok: false,
                vision_ok: true,
                confidence: 0.876,
              }),
            ],
          }),
        ),
    });
    await expect(page.locator("#headline")).toHaveText("Photo in from Blue Bottle Coffee, checking it");
    await expect(page.locator("#proof")).toBeVisible();
    await expect(page.locator("#photo")).toBeVisible();
    await expect(page.locator("#photo")).toHaveAttribute("src", `${ORIGIN}/photo/ok.png`);
    await expect(page.locator("#checks li")).toHaveCount(4);
    await expect(page.locator("#checks li:nth-child(1) .ok")).toHaveText("✓");
    await expect(page.locator("#checks li:nth-child(2) .bad")).toHaveText("✗");
    await expect(page.locator("#checks li:nth-child(3) .ok")).toHaveText("✓");
    await expect(page.locator("#checks li:last-child span")).toHaveText("88%");
  });

  test("hides the photo when the answer has no photo, and labels the step Answer", async ({ page }) => {
    await open(page, {
      feedFor: () =>
        ok(
          feed({
            tasks: [
              task({ id: "t3", status: "submitted", claimed_at: minutesAgo(5), submitted_at: minutesAgo(2) }),
            ],
          }),
        ),
    });
    await expect(page.locator("#proof")).toBeVisible();
    await expect(page.locator("#photo")).toBeHidden();
    await expect(page.locator("#photo")).not.toHaveAttribute("src", /.+/);
    await expect(page.locator("#steps b", { hasText: "Answer" })).toHaveCount(1);
  });

  test("hides the photo when the image itself fails to load", async ({ page }) => {
    await open(page, {
      feedFor: () =>
        ok(
          feed({
            tasks: [
              task({
                id: "t4",
                status: "submitted",
                claimed_at: minutesAgo(5),
                submitted_at: minutesAgo(2),
                photo_url: `${ORIGIN}/photo/broken.jpg`,
                gps_ok: true,
                fresh_ok: true,
                vision_ok: true,
                confidence: 0.5,
              }),
            ],
          }),
        ),
    });
    await expect(page.locator("#photo")).toBeHidden();
    await expect(page.locator("#proof")).toBeVisible();
  });

  test("clears the photo when the next answer has none", async ({ page }) => {
    let calls = 0;
    await open(page, {
      feedFor: () => {
        const withPhoto = task({
          id: "t5",
          status: "submitted",
          claimed_at: minutesAgo(5),
          submitted_at: minutesAgo(2),
          photo_url: `${ORIGIN}/photo/ok.png`,
          gps_ok: true,
          fresh_ok: true,
          vision_ok: true,
          confidence: 0.9,
        });
        const without = { ...withPhoto, photo_url: null };
        return ok(feed({ tasks: [calls++ === 0 ? withPhoto : without] }));
      },
    });
    await expect(page.locator("#photo")).toBeVisible();
    await expect(page.locator("#photo")).toHaveAttribute("src", `${ORIGIN}/photo/ok.png`);
    await expect(page.locator("#photo")).toBeHidden({ timeout: 6000 });
    await expect(page.locator("#photo")).not.toHaveAttribute("src", /.+/);
  });

  test("uses coordinates as a rounded near-label everywhere they appear", async ({ page }) => {
    await open(page, {
      feedFor: () =>
        ok(
          feed({
            tasks: [
              task({ id: "t6", status: "dispatched", place_label: COORDS }),
              task({
                id: "t7",
                status: "expired",
                place_label: COORDS,
                claimed_at: null,
                money_at: { refund: minutesAgo(1) },
              }),
            ],
          }),
        ),
    });
    await expect(page.locator("#headline")).toHaveText("3 workers notified near 37.782, -122.408");
    await expect(page.locator("#tasks li.row strong")).toHaveText("Near 37.782, -122.408");
  });

  for (const c of [
    {
      status: "verified",
      money_at: { release: minutesAgo(1) },
      chip: "Verified",
      headline: "Verified at Blue Bottle Coffee, paying the worker",
    },
    {
      status: "paid",
      money_at: { release: minutesAgo(1), payout: minutesAgo(1) },
      chip: "Paid",
      headline: "Answered at Blue Bottle Coffee, worker paid $3.00",
    },
    {
      status: "needs_review",
      money_at: {},
      chip: "Needs review",
      headline: "Answer in from Blue Bottle Coffee, it needs a human look",
    },
    {
      status: "disputed",
      money_at: {},
      chip: "Disputed",
      headline: "The agent disputed the answer from Blue Bottle Coffee",
    },
  ]) {
    test(`headline and chip for ${c.status}`, async ({ page }) => {
      await open(page, {
        feedFor: () =>
          ok(
            feed({
              tasks: [
                task({
                  id: "t8",
                  status: c.status,
                  claimed_at: minutesAgo(5),
                  submitted_at: minutesAgo(2),
                  money_at: c.money_at,
                }),
              ],
            }),
          ),
      });
      await expect(page.locator("#chip")).toHaveText(c.chip);
      await expect(page.locator("#headline")).toHaveText(c.headline);
    });
  }

  for (const c of [
    {
      status: "expired",
      step: "Expired",
      headline: "Nobody reached 37.782, -122.408 in time, $3.60 refunded",
    },
    {
      status: "refunded",
      step: "Cancelled",
      headline: "Cancelled before anyone claimed it, $3.60 refunded",
    },
  ]) {
    test(`refund path for ${c.status} marks the steps done and nothing next`, async ({ page }) => {
      await open(page, {
        feedFor: () =>
          ok(
            feed({
              tasks: [
                task({
                  id: "t9",
                  status: c.status,
                  place_label: COORDS,
                  money_at: { refund: minutesAgo(1) },
                }),
              ],
            }),
          ),
      });
      await expect(page.locator("#headline")).toHaveText(c.headline);
      await expect(page.locator("#steps li.done")).toHaveCount(4);
      await expect(page.locator("#steps li", { hasText: c.step })).toHaveClass(/done/);
      await expect(page.locator("#steps li.next")).toHaveCount(0);
    });
  }

  test("features the active task, caps the earlier list at 11 rows and the ledger at 6", async ({ page }) => {
    const older = Array.from({ length: 13 }, (_, i) =>
      task({ id: `e${i}`, status: "expired", money_at: { refund: minutesAgo(30 + i) } }),
    );
    const active = task({ id: "a1", status: "claimed", claimed_at: minutesAgo(3) });
    const ledgerTypes = ["topup", "escrow", "release", "fee", "payout", "refund", "topup", "escrow"];
    const ledger = ledgerTypes.map((type, i) => ({
      type,
      task_id: i === 0 ? "gone" : "a1",
      created_at: minutesAgo(i + 1),
      amount_cents: 100 + i,
    }));
    await open(page, {
      feedFor: () => ok(feed({ tasks: [older[0], active, ...older.slice(1)], ledger })),
    });
    await expect(page.locator("#chip")).toHaveText("On the way");
    await expect(page.locator("#tasks li.row")).toHaveCount(11);
    await expect(page.locator("#ledger li")).toHaveCount(6);
    await expect(page.locator("#ledger li").first().locator(".what")).toHaveText("Agent balance topped up");
    await expect(page.locator("#ledger li").first().locator(".what span")).toHaveCount(0);
    await expect(page.locator("#ledger li").nth(1).locator(".what span")).toHaveText(
      "Blue Bottle Coffee, Mint Plaza, San Francisco",
    );
  });

  test("swaps the headline and lights the new step on a live update", async ({ page }) => {
    let calls = 0;
    await open(page, {
      feedFor: () =>
        ok(
          feed({
            tasks: [
              calls++ === 0
                ? task({ id: "t10", status: "dispatched" })
                : task({ id: "t10", status: "claimed", claimed_at: minutesAgo(1) }),
            ],
          }),
        ),
    });
    await expect(page.locator("#headline")).toHaveText("3 workers notified near Blue Bottle Coffee");
    await expect(page.locator("#headline")).toHaveText("A worker is on the way to Blue Bottle Coffee", {
      timeout: 6000,
    });
    await expect(page.locator("#headline")).toHaveClass(/swap/);
    await expect(page.locator("#steps li.lit")).toContainText("Claimed");
    await expect(page.locator("#steps li.next b")).toHaveText("Photo");
  });

  test("map is replaced by a message when Leaflet cannot load", async ({ page }) => {
    await open(page, { feedFor: () => ok(feed({ tasks: [task({ id: "t11" })] })) });
    await expect(page.locator("#map")).toHaveClass(/nomap/);
    await expect(page.locator("#map")).toHaveText(
      "The map needs internet access to load Leaflet and map tiles.",
    );
  });
});

// Recording stand-in for Leaflet, injected only in the map tests. It records what the page asks it to draw.
// distanceTo is a real haversine so the dispatch-radius filter is exercised for real.
const LEAFLET_STUB = `
(() => {
  const log = (window.__leaflet = { fits: 0, flies: 0, cleared: 0, circles: [], markers: [], tooltips: 0 });
  const pt = (lat, lng) => ({
    lat,
    lng,
    distanceTo([la, ln]) {
      const r = Math.PI / 180;
      const dLa = (la - lat) * r;
      const dLn = (ln - lng) * r;
      const a = Math.sin(dLa / 2) ** 2 + Math.cos(lat * r) * Math.cos(la * r) * Math.sin(dLn / 2) ** 2;
      return 2 * 6371000 * Math.asin(Math.sqrt(a));
    },
  });
  const map = {
    setView() { return map; },
    fitBounds() { log.fits++; },
    flyToBounds() { log.flies++; },
  };
  window.L = {
    latLng: pt,
    latLngBounds: () => ({}),
    map: () => map,
    layerGroup() {
      const g = { addTo() { return g; }, clearLayers() { log.cleared++; } };
      return g;
    },
    tileLayer: () => ({ addTo() { return this; } }),
    circleMarker(ll, opts) {
      log.circles.push({ lat: ll[0], lng: ll[1], color: opts.color, weight: opts.weight, fillColor: opts.fillColor });
      return { addTo() { return this; } };
    },
    divIcon: (opts) => opts,
    marker(ll, opts) {
      log.markers.push({ className: opts.icon.className, size: opts.icon.iconSize[0], zIndexOffset: opts.zIndexOffset });
      const m = { bindTooltip() { log.tooltips++; return m; } };
      return { addTo() { return m; } };
    },
  };
})();
`;

type MapLog = {
  fits: number;
  flies: number;
  cleared: number;
  circles: { lat: number; lng: number; color: string; weight: number; fillColor: string }[];
  markers: { className: string; size: number; zIndexOffset: number }[];
  tooltips: number;
};

const mapLog = (page: Page) => page.evaluate(() => (window as unknown as { __leaflet: MapLog }).__leaflet);

const WORKERS = [
  { id: "w1", lat: 37.78, lng: -122.41, available: true, opted_in: true }, // near, online: ringed
  { id: "w2", lat: 40.0, lng: -120.0, available: true, opted_in: true }, // online, outside 3 km
  { id: "w3", lat: 37.7825, lng: -122.4085, available: false, opted_in: true }, // near, offline
  { id: "w4", lat: null, lng: null, available: true, opted_in: true }, // no location: not drawn
];

test.describe("dashboard map with a recording Leaflet stand-in", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(LEAFLET_STUB);
  });

  test("draws workers and tasks, rings only the nearby online workers, and fits the first view", async ({
    page,
  }) => {
    await open(page, {
      html: NO_LEAFLET,
      feedFor: () =>
        ok(
          feed({
            tasks: [
              task({ id: "t1", status: "dispatched" }),
              task({ id: "t2", status: "expired", money_at: { refund: minutesAgo(1) } }),
            ],
            workers: WORKERS,
          }),
        ),
    });
    await expect.poll(async () => (await mapLog(page)).markers.length).toBe(2);
    const log = await mapLog(page);
    expect(log.circles).toHaveLength(3);
    const [w1, w2, w3] = log.circles;
    expect(w1).toMatchObject({ lat: 37.78, color: "#5cc8ff", weight: 4, fillColor: "#dbe7f3" });
    expect(w2).toMatchObject({ lat: 40, color: "#121820", weight: 2, fillColor: "#dbe7f3" });
    expect(w3).toMatchObject({ lat: 37.7825, color: "#121820", weight: 2, fillColor: "#4a5666" });
    expect(log.markers[0]).toMatchObject({ className: "pin s-expired old", size: 12, zIndexOffset: 0 });
    expect(log.markers[1]).toMatchObject({ className: "pin s-dispatched", size: 24, zIndexOffset: 1000 });
    expect(log.tooltips).toBe(1);
    expect(log.fits).toBe(1);
    expect(log.flies).toBe(0);
  });

  test("flies to the new focus when the active set changes", async ({ page }) => {
    let calls = 0;
    const base = [task({ id: "t1", status: "dispatched" })];
    const claimed = [...base, task({ id: "t3", status: "claimed", claimed_at: minutesAgo(1) })];
    await open(page, {
      html: NO_LEAFLET,
      feedFor: () => ok(feed({ tasks: calls++ === 0 ? base : claimed, workers: WORKERS })),
    });
    await expect.poll(async () => (await mapLog(page)).flies).toBe(1);
    const log = await mapLog(page);
    expect(log.fits).toBe(1);
    expect(log.cleared).toBeGreaterThanOrEqual(2);
  });

  test("fits instead of flying when the visitor asks for reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    let calls = 0;
    const base = [task({ id: "t1", status: "dispatched" })];
    const claimed = [...base, task({ id: "t3", status: "claimed", claimed_at: minutesAgo(1) })];
    await open(page, {
      html: NO_LEAFLET,
      feedFor: () => ok(feed({ tasks: calls++ === 0 ? base : claimed, workers: WORKERS })),
    });
    await expect.poll(async () => (await mapLog(page)).fits).toBe(2);
    expect((await mapLog(page)).flies).toBe(0);
  });

  test("does not draw the map at all when there are no tasks or workers to focus on", async ({ page }) => {
    await open(page, { html: NO_LEAFLET, feedFor: () => ok(feed()) });
    await expect(page.locator("#live")).toHaveText("Live");
    const log = await mapLog(page);
    expect(log.markers).toHaveLength(0);
    expect(log.fits).toBe(0);
    expect(log.flies).toBe(0);
  });
});
