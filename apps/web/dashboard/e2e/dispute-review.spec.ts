import { expect, type Page, test } from "@playwright/test";
import { OPS_PAGE } from "../src/server.ts";

const ORIGIN = "http://internal.eyes.test";
const WORKER = "11111111-2222-4333-8444-555555555555";
const AT = "2026-10-18T12:00:00Z";

// Controlled browser data only: these requests never reach a live worker or operator API.
async function openWorker(page: Page) {
  const worker = {
    id: WORKER,
    lat: null,
    lng: null,
    available: true,
    opted_in: true,
    banned: false,
    dispute_hold_at: AT as string | null,
    dispute_reviewed_at: null as string | null,
    created_at: AT,
    location_at: AT,
  };
  const review = {
    worker_id: WORKER,
    dispute_hold_at: AT as string | null,
    dispute_reviewed_at: null as string | null,
    disputed_tasks: 3,
    history: [
      "aaaaaaaa-2222-4333-8444-555555555555",
      "bbbbbbbb-2222-4333-8444-555555555555",
      "cccccccc-2222-4333-8444-555555555555",
    ].map((task_id) => ({
      task_id,
      created_at: AT,
      message: "Agent disputed the answer for this task",
      dispute_status: "open",
    })),
    last_review: null as { actor: string; at: string; note: string; decision: "lift_hold" } | null,
  };
  const posts: { path: string; body: unknown; origin?: string }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.clock.setFixedTime(new Date(AT));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return route.abort();
    if (request.isNavigationRequest()) return route.fulfill({ contentType: "text/html", body: OPS_PAGE });
    let body: unknown = {};
    if (request.method() === "POST") {
      posts.push({ path: url.pathname, body: request.postDataJSON(), origin: request.headers().origin });
      await gate;
      worker.dispute_hold_at = null;
      worker.dispute_reviewed_at = AT;
      review.dispute_hold_at = null;
      review.dispute_reviewed_at = AT;
      review.disputed_tasks = 0;
      review.history = [];
      review.last_review = {
        actor: "operator@example.test",
        at: AT,
        note: "Checked all three disputes",
        decision: "lift_hold",
      };
      return route.fulfill({ json: review });
    }
    if (url.pathname === "/feed")
      body = {
        tasks: [],
        workers: [worker],
        ledger: [],
        totals: {},
        ops: {
          health: { uptime_s: 60, providers: {}, db: "controlled test", classifier: "test", node: "test" },
          statuses: {},
          partial: {},
          money_24h: {},
          queue: [],
          workers: { online: 0, opted_in: 1, total: 1 },
        },
      };
    if (url.pathname === `/workers/${WORKER}`)
      body = { worker, tasks: [], earnings: { paid_cents: 300, payouts: 1 } };
    if (url.pathname === `/workers/${WORKER}/dispute-review`) body = review;
    if (url.pathname === "/tickets") body = { tickets: [], total: 0, next_cursor: null };
    if (url.pathname === "/api/settings") body = { classifier_block_min: 0.95 };
    if (url.pathname === "/events") body = { source: "db", events: [] };
    if (url.pathname === "/issues") body = { issues: [] };
    if (url.pathname === "/map/tasks") body = { tasks: [] };
    if (url.pathname === "/series")
      body = {
        source: "db",
        minutes: [],
        requests: [],
        errors: [],
        p95_ms: [],
        hours: [],
        tasks: {},
        payouts: { ok: [], failed: [] },
      };
    await route.fulfill({ json: body });
  });
  await page.goto(`${ORIGIN}/#workers`);
  await page.getByRole("button", { name: /Worker 11111111, Paused: dispute review/ }).click();
  await expect(
    page.getByRole("dialog").getByText("3 distinct disputed tasks since last review"),
  ).toBeVisible();
  return { posts, release };
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 1100 },
]) {
  test(`${viewport.name}: dispute hold review preserves scope, note and single submission`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const api = await openWorker(page);
    const panel = page.getByRole("dialog");
    await expect(panel.getByText("Paused: dispute review", { exact: true })).toBeVisible();
    await expect(panel.getByRole("link", { name: /Dispute tickets for task/ })).toHaveCount(3);
    await expect(panel.getByRole("link").first()).toHaveAttribute(
      "href",
      "#support?q=aaaaaaaa-2222-4333-8444-555555555555",
    );
    await expect(panel.getByLabel("Operator review note")).toHaveAttribute("maxlength", "1000");
    await expect(panel).toHaveJSProperty("scrollWidth", await panel.evaluate((node) => node.clientWidth));
    await page.screenshot({
      path: testInfo.outputPath(`dispute-review-${viewport.name}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await panel.getByLabel("Operator review note").fill("Checked all three disputes");
    await panel.getByRole("button", { name: "Review and lift temporary hold" }).click();
    await expect(panel.locator(".decide__question")).toContainText("Only new dispatch and claims may resume");
    await expect(panel.locator(".decide__question")).toContainText(
      "Existing payments and disputes do not change",
    );
    await expect(panel.locator(".decide__question")).toContainText("permanent fraud ban is not overridden");
    await page.screenshot({
      path: testInfo.outputPath(`dispute-confirm-${viewport.name}.png`),
      fullPage: true,
      animations: "disabled",
    });
    await panel.getByRole("button", { name: "Lift temporary hold", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Lift temporary hold…", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(panel).toBeVisible();
    await expect
      .poll(() => api.posts)
      .toEqual([
        {
          path: `/workers/${WORKER}/dispute-review`,
          body: { note: "Checked all three disputes" },
          origin: ORIGIN,
        },
      ]);
    api.release();
    await expect(panel.getByText("No temporary dispute hold.")).toBeVisible();
    await expect(panel.getByText("Checked all three disputes", { exact: true })).toBeVisible();
    await expect(panel.getByText(/Temporary hold lifted by operator@example.test/)).toBeVisible();
    await expect(panel.getByText("earned $3.00 in 1 payout", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Review and lift temporary hold" })).toHaveCount(0);
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("#workers tbody")).not.toContainText("Paused: dispute review");
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await expect(page.getByRole("slider")).toHaveValue("0.95");
  });
}
