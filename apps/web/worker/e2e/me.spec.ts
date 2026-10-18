import { expect, type Page, test } from "@playwright/test";

// Stand-ins for GET /w/me and GET /w/me/tasks, for the tests below.
const code = "eyJwIjoiZTp3MSIsImUiOjF9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
const minAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const HERE = "https://app.eyes.test/here.html?t=h.t";
const CONNECT = "https://connect.stripe.test/setup/abc";

const allDone = {
  opted_in: true,
  spot: { at: minAgo(12), fresh: true, max_age_h: 24 },
  app: { connected: true, last_at: minAgo(5), sending: true },
  payouts: { set_up: true, live: true, setup_url: null },
  here_url: HERE,
};

const partial = {
  ...allDone,
  spot: { at: minAgo(3 * 24 * 60), fresh: false, max_age_h: 24 },
  app: { connected: false, last_at: null, sending: false },
  payouts: { set_up: false, live: true, setup_url: CONNECT },
};

type Task = {
  task_id: string;
  question: string;
  place_label: string;
  status: string;
  bounty_usd: number;
  payout: "paid" | "pending" | "waiting_for_payout_setup" | null;
  claimed_at: string;
};

const PLACES = ["Pier 39", "Ferry Building", "Blue Bottle Coffee, Mint Plaza"];
const QUESTIONS = [
  "Is oat milk in stock right now?",
  "How long is the line at the DMV?",
  "Is the playground open?",
];
const STATES: [string, Task["payout"]][] = [
  ["paid", "paid"],
  ["verified", "pending"],
  ["needs_review", null],
  ["expired", null],
  ["claimed", null],
];

/** n tasks, newest first, one a day apart, cycling places, questions and states. */
const makeTasks = (n: number): Task[] =>
  Array.from({ length: n }, (_, i) => ({
    task_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    question: QUESTIONS[i % 3] as string,
    place_label: PLACES[i % 3] as string,
    status: STATES[i % 5]?.[0] as string,
    bounty_usd: 3,
    payout: STATES[i % 5]?.[1] ?? null,
    claimed_at: minAgo(60 + i * 24 * 60),
  }));

/**
 * Answers GET /w/me and GET /w/me/tasks like the API: search over the shown texts (date in the tz sent),
 * status filters, 20 per page by cursor. Records the Authorization header and the tasks query of every call.
 */
async function mockMe(
  page: Page,
  reply: (n: number) => { status?: number; json?: object } | "abort",
  tasks: Task[] = [],
) {
  const auth: (string | undefined)[] = [];
  const queries: URLSearchParams[] = [];
  await page.route("**/api/w/me", (route) => {
    auth.push(route.request().headers().authorization);
    const r = reply(auth.length);
    return r === "abort" ? route.abort() : route.fulfill(r);
  });
  await page.route("**/api/w/me/tasks?*", (route) => {
    const url = new URL(route.request().url());
    queries.push(url.searchParams);
    auth.push(route.request().headers().authorization);
    const p = url.searchParams;
    const tz = p.get("tz") ?? "UTC";
    const date = (iso: string) =>
      new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: tz,
      }).format(new Date(iso));
    const q = (p.get("q") ?? "").toLowerCase();
    const status = p.get("status");
    const rows = tasks.filter(
      (t) =>
        [t.question, t.place_label, date(t.claimed_at), `$${t.bounty_usd.toFixed(2)}`]
          .join(" ")
          .toLowerCase()
          .includes(q) &&
        (!status ||
          (status === "paid" && t.payout === "paid") ||
          (status === "pending" && (t.payout === "pending" || t.payout === "waiting_for_payout_setup")) ||
          (status === "review" && ["needs_review", "disputed"].includes(t.status)) ||
          (status === "expired" && ["expired", "refunded"].includes(t.status))),
    );
    const from = Number(p.get("cursor") ?? 0);
    const sum = (payout: string) =>
      tasks.filter((t) => t.payout === payout).reduce((s, t) => s + t.bounty_usd, 0);
    return route.fulfill({
      json: {
        paid_usd: sum("paid"),
        pending_usd: sum("pending"),
        tasks: rows.slice(from, from + 20),
        next_cursor: rows.length > from + 20 ? String(from + 20) : null,
      },
    });
  });
  return { auth, queries };
}

test("/me sends the fragment code only as a Bearer header, clears it, and shows every row done", async ({
  page,
}) => {
  const { auth, queries } = await mockMe(page, () => ({ json: allDone }), makeTasks(3));
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  await page.goto(`/me.html#c=${code}`);
  await expect(page.getByRole("heading", { name: "You're set up" })).toBeVisible();
  await expect(page.locator("#tasks > li")).toHaveCount(3);
  expect(auth).toEqual([`Bearer ${code}`, `Bearer ${code}`]);
  expect(queries[0]?.get("tz")).toBe(
    await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
  );
  expect(new URL(page.url()).hash).toBe("");
  expect(urls.filter((u) => u.includes(code))).toEqual([]);
  await expect(page.locator("#checks > li.ui-check--pass")).toHaveCount(4);
  await expect(page.getByText("Updated 12 min ago")).toBeVisible();
  await expect(page.locator("#checks > li").filter({ hasText: "Eyes app connected" })).toHaveClass(
    /ui-check--pass/,
  );
  await expect(page.locator("#checks").getByRole("button")).toHaveCount(0);
  const first = page.locator("#tasks > li").first();
  await expect(first).toContainText("$3.00");
  await expect(first).toContainText("Pier 39");
  await expect(first.locator(".ui-badge")).toHaveText("Paid");
  await expect(page.locator("#tasks > li").nth(1)).toContainText("Payout pending");
  await expect(page.locator("#tasks > li").nth(2)).toContainText("Reply HELP for a manual review.");
  await expect(page.locator("#paid")).toHaveText("$3.00");
  await expect(page.locator("#pending")).toHaveText("$3.00");
  await expect(page.getByRole("button", { name: "Load more" })).toBeHidden();
  await expect(page.getByRole("link", { name: /earnings/i })).toHaveCount(0);
});

test("/me searches what the rows show, filters by status, and loads 30 tasks 20 at a time", async ({
  page,
}) => {
  const { queries } = await mockMe(page, () => ({ json: allDone }), makeTasks(30));
  await page.goto(`/me.html#c=${code}`);
  await expect(page.locator("#tasks > li")).toHaveCount(20);
  await page.locator("#tasks > li").last().scrollIntoViewIfNeeded();
  await expect(page.locator("#tasks > li")).toHaveCount(30);
  await expect(page.getByRole("button", { name: "Load more" })).toBeHidden();

  const search = page.getByRole("searchbox", { name: "Search your tasks" });
  await search.fill("ferry");
  await expect(page.locator("#tasks > li")).toHaveCount(10);
  await expect(page.locator("#tasks > li").first()).toContainText("Ferry Building");
  // Every bounty is $3.00: an amount search matches them all, a wrong amount none.
  await search.fill("$3.75");
  await expect(page.locator("#tasks > li")).toHaveCount(0);
  await search.fill("$3.00");
  await expect(page.locator("#tasks > li")).not.toHaveCount(0);
  const shownDate = await page.locator("#tasks .me-task__date").first().textContent();
  await search.fill(shownDate ?? "");
  await search.press("Enter");
  await expect(page.locator("#tasks > li")).toHaveCount(1);

  await search.fill("");
  await page.getByText("Needs review", { exact: true }).first().click();
  await expect(page.getByRole("radio", { name: "Needs review" })).toBeChecked();
  await expect(page.locator("#tasks > li")).toHaveCount(6);
  expect(queries.at(-1)?.get("status")).toBe("review");
  await search.fill("zebra");
  await expect(page.getByText("Nothing in Needs review matches “zebra”.")).toBeVisible();
  await page.getByRole("radio", { name: "All" }).check({ force: true });
  await expect(page.getByText("No tasks match “zebra”.")).toBeVisible();
});

test("/me keeps the rows and offers Try again when a page fails", async ({ page }) => {
  await mockMe(page, () => ({ json: allDone }), makeTasks(30));
  await page.route("**/api/w/me/tasks?*cursor=*", (route) => route.abort(), { times: 1 });
  await page.goto(`/me.html#c=${code}`);
  await expect(page.locator("#tasks > li")).toHaveCount(20);
  await page.locator("#tasks > li").last().scrollIntoViewIfNeeded();
  await expect(page.getByText("Could not reach Eyes.")).toBeVisible();
  await expect(page.locator("#tasks > li")).toHaveCount(20);
  await page.locator("#more").click();
  await expect(page.locator("#tasks > li")).toHaveCount(30);
});

test("/me shows what is left to do, with one primary action", async ({ page }) => {
  await mockMe(page, () => ({ json: partial }));
  await page.goto(`/me.html#c=${code}`);
  await expect(page.getByRole("heading", { name: "Finish setting up" })).toBeVisible();
  await expect(page.getByText("Last spot 3 days ago")).toBeVisible();
  const spot = page.getByRole("link", { name: "Update my spot" });
  await expect(spot).toHaveAttribute("href", HERE);
  await expect(spot).toHaveClass(/ui-button--primary/);
  await expect(page.getByRole("button", { name: "Open / connect Eyes app" })).not.toHaveClass(/--primary/);
  await expect(page.getByRole("link", { name: "Set up payouts" })).toHaveAttribute("href", CONNECT);
  await expect(page.locator("#checks .ui-button--primary")).toHaveCount(1);
  await expect(page.getByText("No tasks yet. Eyes texts you when one is near.")).toBeVisible();
  await expect(page.getByRole("searchbox")).toBeHidden();
  await expect(page.locator("#totals")).toBeHidden();
});

test("/me install button posts with the code and opens the install link", async ({ page }) => {
  const installUrl = "https://app.eyes.test/install#c=loc_abcdefghijklmnopqrstu";
  await mockMe(page, () => ({ json: partial }));
  let installAuth: string | undefined;
  await page.route("**/api/w/me/install", (route) => {
    installAuth = route.request().headers().authorization;
    expect(route.request().method()).toBe("POST");
    return route.fulfill({ json: { install_url: installUrl } });
  });
  await page.route("https://app.eyes.test/**", (route) => route.fulfill({ body: "install page" }));
  await page.goto(`/me.html#c=${code}`);
  await page.getByRole("button", { name: "Open / connect Eyes app" }).click();
  await expect(page).toHaveURL(installUrl);
  expect(installAuth).toBe(`Bearer ${code}`);
});

test("/me with an expired code offers a text HELP button", async ({ page }) => {
  await mockMe(page, () => ({
    status: 401,
    json: {
      error: "unauthorized",
      message: "This link is invalid or has expired.",
      fix: "Text HELP to the Eyes number for a fresh link.",
    },
  }));
  await page.goto(`/me.html#c=${code}`);
  await expect(page.getByText("This link has expired.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Text HELP for a new link" })).toHaveAttribute(
    "href",
    "sms:+14155550100?&body=HELP",
  );
});

test("/me without a code offers a text HELP button and calls nobody", async ({ page }) => {
  const { auth } = await mockMe(page, () => ({ json: allDone }));
  await page.goto("/me.html");
  await expect(page.getByText("This link has no code.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Text HELP for a new link" })).toBeVisible();
  expect(auth).toEqual([]);
});

test("/me shows a notice on a network error and loads on Try again", async ({ page }) => {
  await mockMe(page, (n) => (n === 1 ? "abort" : { json: allDone }));
  await page.goto(`/me.html#c=${code}`);
  await expect(page.getByText("Could not reach Eyes.")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "You're set up" })).toBeVisible();
});

for (const width of [390, 1440]) {
  for (const fresh of [true, false]) {
    test(`/me at ${width}px: completing a photo task keeps app connected with spot fresh=${fresh}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      // Synthetic API state after capture replaced the latest GPS source; not a native-device proof.
      const setup = {
        ...allDone,
        app: { connected: true, last_at: null, sending: false },
        spot: { at: minAgo(fresh ? 1 : 3 * 24 * 60), fresh, max_age_h: 24 },
        email_status: "none",
        email_masked: null,
        email_skipped: true,
      };
      const writes: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST") writes.push(request.url());
      });
      await mockMe(page, () => ({ json: setup }), makeTasks(1));
      await page.goto(`/me.html#c=${code}`);
      const app = page.locator("#checks > li").filter({ hasText: "Eyes app connected" });
      const spot = page
        .locator("#checks > li")
        .filter({ hasText: fresh ? "Spot is fresh" : "Update your spot" });
      await expect(app).toHaveClass(/ui-check--pass/);
      await expect(app.getByRole("button")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Install|Open \/ connect Eyes app/ })).toHaveCount(0);
      await expect(page.locator("#checks > li.me-email")).toHaveClass(/ui-check--pass/);
      await expect(
        page.getByRole("heading", { name: fresh ? "You're set up" : "Finish setting up" }),
      ).toBeVisible();
      if (fresh) await expect(spot).toHaveClass(/ui-check--pass/);
      else await expect(spot.getByRole("link", { name: "Update my spot" })).toBeVisible();
      await expect(page.locator("#tasks > li")).toHaveCount(1);
      expect(writes).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      // Wider platform fonts must not let an offscreen chip's absolute radio escape the scroller.
      const fallback = await page.addStyleTag({ content: ".me-chip { font-family: monospace; }" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await fallback.evaluate((style) => style.remove());
      if (process.env.SHOTS) {
        await expect(app).toHaveCSS("opacity", "1");
        await page.screenshot({
          path: `${process.env.SHOTS}/setup-after-photo-${fresh ? "fresh" : "stale"}-${width}.png`,
          fullPage: true,
        });
      }
    });
  }
}
