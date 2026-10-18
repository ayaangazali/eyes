import { expect, type Page, test } from "@playwright/test";
import { OPS_PAGE } from "../src/server.ts";

const ORIGIN = "http://internal.eyes.test";
const ticket = {
  id: 10,
  kind: "classifier_feedback",
  status: "open",
  classifier_status: "open",
  agent_id: "11111111-2222-4333-8444-555555555555",
  task_id: null,
  question: "Is the cafe open?",
  place_label: "Blue Bottle Coffee, Mint Plaza",
  bounty_cents: 300,
  message: "Client-reported classifier feedback",
  reported_context: {
    error: "unsafe_task",
    category: "privacy",
    reason: "Possible surveillance",
    layer: "classifier",
  },
  request: {
    question: "Is the cafe open?",
    location: "Blue Bottle Coffee, Mint Plaza",
    task_type: "photo",
    bounty_usd: 3,
    deadline_minutes: 30,
    require_photo: true,
    idempotency_key: "original-key",
  },
  request_fingerprint: "ae7a65a4f50d723a39ab2fa0adf749a3d6d4a742d724b4cf3cceafe3dc02698a",
  created_at: "2026-10-18T12:00:00Z",
};

async function openReview(page: Page) {
  const posts: { path: string; body: unknown }[] = [];
  const response = {
    status: 200,
    body: { status: "approved", already_resolved: false } as Record<string, unknown>,
  };
  const gate = Promise.withResolvers<void>();
  let hold = false;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return route.abort();
    if (request.isNavigationRequest()) return route.fulfill({ contentType: "text/html", body: OPS_PAGE });
    let body: unknown = {};
    if (request.method() === "POST") {
      posts.push({ path: url.pathname, body: request.postDataJSON() });
      if (hold) await gate.promise;
      return route.fulfill({ status: response.status, json: response.body });
    }
    if (url.pathname === "/feed")
      body = {
        tasks: [],
        workers: [],
        ledger: [],
        totals: {},
        ops: {
          health: { uptime_s: 60, providers: {}, db: "test", classifier: "test", node: "test" },
          statuses: {},
          partial: {},
          money_24h: {},
          queue: [],
          workers: { online: 0, opted_in: 0, total: 0 },
        },
      };
    if (url.pathname === "/tickets") body = { tickets: [ticket], total: 1, next_cursor: null };
    if (url.pathname === "/api/settings") body = { classifier_block_min: 0.95 };
    if (url.pathname === "/events") body = { source: "db", events: [] };
    if (url.pathname === "/issues") body = { issues: [] };
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
  await page.goto(`${ORIGIN}/#support`);
  await page.getByRole("button", { name: /Ticket 10:/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  return {
    posts,
    response,
    gate,
    hold: () => {
      hold = true;
    },
  };
}

test("mobile classifier review shows original context and submits only one explicit approval", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 1100 });
  const api = await openReview(page);
  const panel = page.getByRole("dialog");
  await expect(panel.getByText("Pending review", { exact: true })).toBeVisible();
  await expect(panel.getByText("Is the cafe open?", { exact: true })).toBeVisible();
  await expect(panel.getByText("Blue Bottle Coffee, Mint Plaza", { exact: true })).toBeVisible();
  await expect(panel.locator("details").first()).toContainText("Possible surveillance");
  await expect(panel.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Reject", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: /Release|Refund|Resolve/ })).toHaveCount(0);
  await expect(panel.getByLabel("Decision note (optional)")).toHaveAttribute("maxlength", "500");
  await expect(panel).toHaveJSProperty("scrollWidth", await panel.evaluate((node) => node.clientWidth));
  await expect(page.locator("#updated")).not.toContainText("failed");
  await page.screenshot({
    path: testInfo.outputPath("classifier-review-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
  await panel.getByRole("button", { name: "Approve", exact: true }).click();
  api.hold();
  await panel.getByRole("button", { name: "Approve retry", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Approve retry…", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await expect
    .poll(() => api.posts)
    .toEqual([{ path: "/tickets/10/approve_classifier", body: { note: "" } }]);
  api.gate.resolve();
  await expect(panel.getByRole("status")).toContainText(
    "No task dispatched, charge made or worker messaged.",
  );
  await expect(panel.locator(".decide button")).toHaveCount(0);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("slider")).toHaveValue("0.95");
});

test("rejection preserves the note after failure and uses only the classifier route", async ({ page }) => {
  const api = await openReview(page);
  const panel = page.getByRole("dialog");
  await panel.getByLabel("Decision note (optional)").fill("  Public-place request still unsafe.  ");
  api.response.status = 503;
  api.response.body = { error: "Review service unavailable" };
  await panel.getByRole("button", { name: "Reject", exact: true }).click();
  await panel.getByRole("button", { name: "Reject report", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("Failed: Review service unavailable");
  await expect(panel.getByLabel("Decision note (optional)")).toHaveValue(
    "  Public-place request still unsafe.  ",
  );
  api.response.status = 200;
  api.response.body = { status: "rejected", already_resolved: false };
  await panel.getByRole("button", { name: "Reject", exact: true }).click();
  await panel.getByRole("button", { name: "Reject report", exact: true }).click();
  expect(api.posts).toEqual([
    { path: "/tickets/10/reject_classifier", body: { note: "Public-place request still unsafe." } },
    { path: "/tickets/10/reject_classifier", body: { note: "Public-place request still unsafe." } },
  ]);
  await expect(panel.getByRole("status")).toContainText(
    "Decision saved: rejected. No new retry authorization.",
  );
});
