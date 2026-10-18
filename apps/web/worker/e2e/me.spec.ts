import { expect, type Page, test } from "@playwright/test";

const code = "eyJwIjoiZTp3MSIsImUiOjF9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
const minAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const HERE = "https://app.eyes.test/here.html?t=h.t";
const CONNECT = "https://connect.stripe.test/setup/abc";

const allDone = {
  opted_in: true,
  spot: { at: minAgo(12), fresh: true, max_age_h: 24 },
  app: { last_at: minAgo(5), sending: true },
  payouts: { set_up: true, live: true, setup_url: null },
  here_url: HERE,
  earnings_url: "https://app.eyes.test/earnings?t=e.t",
  tasks: [
    {
      question: "Is oat milk in stock right now?",
      place_label: "Blue Bottle Coffee, Mint Plaza",
      status: "paid",
      bounty_usd: 3,
      payout: "paid",
      claimed_at: minAgo(60),
    },
    {
      question: "How long is the line at the DMV?",
      place_label: "DMV, Fell Street",
      status: "verified",
      bounty_usd: 5,
      payout: "pending",
      claimed_at: minAgo(2 * 24 * 60),
    },
  ],
};

const partial = {
  ...allDone,
  spot: { at: minAgo(3 * 24 * 60), fresh: false, max_age_h: 24 },
  app: { last_at: null, sending: false },
  payouts: { set_up: false, live: true, setup_url: CONNECT },
  tasks: [],
};

/** Answers GET /w/me and records the Authorization header of every call. */
async function mockMe(page: Page, reply: (n: number) => { status?: number; json?: object } | "abort") {
  const auth: (string | undefined)[] = [];
  await page.route("**/api/w/me", (route) => {
    auth.push(route.request().headers().authorization);
    const r = reply(auth.length);
    return r === "abort" ? route.abort() : route.fulfill(r);
  });
  return auth;
}

test("/me sends the fragment code only as a Bearer header, clears it, and shows every row done", async ({
  page,
}) => {
  const auth = await mockMe(page, () => ({ json: allDone }));
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  await page.goto(`/me.html#c=${code}`);
  await expect(page.getByRole("heading", { name: "You're set up" })).toBeVisible();
  expect(auth).toEqual([`Bearer ${code}`]);
  expect(new URL(page.url()).hash).toBe("");
  expect(urls.filter((u) => u.includes(code))).toEqual([]);
  await expect(page.locator("#checks > li.ui-check--pass")).toHaveCount(4);
  await expect(page.getByText("Updated 12 min ago")).toBeVisible();
  await expect(page.getByText("App sent your spot 5 min ago")).toBeVisible();
  await expect(page.locator("#checks").getByRole("button")).toHaveCount(0);
  await expect(page.locator("#tasks > li")).toHaveCount(2);
  await expect(page.locator("#tasks > li").first()).toContainText("$3.00");
  await expect(page.getByText("Verified · Payout pending")).toBeVisible();
  await expect(page.getByRole("link", { name: "All earnings" })).toHaveAttribute(
    "href",
    allDone.earnings_url,
  );
});

test("/me shows what is left to do, with one primary action", async ({ page }) => {
  await mockMe(page, () => ({ json: partial }));
  await page.goto(`/me.html#c=${code}`);
  await expect(page.getByRole("heading", { name: "Finish setting up" })).toBeVisible();
  await expect(page.getByText("Last spot 3 days ago")).toBeVisible();
  const spot = page.getByRole("link", { name: "Update my spot" });
  await expect(spot).toHaveAttribute("href", HERE);
  await expect(spot).toHaveClass(/ui-button--primary/);
  await expect(page.getByRole("button", { name: "Install / open Eyes app" })).not.toHaveClass(/--primary/);
  await expect(page.getByRole("link", { name: "Set up payouts" })).toHaveAttribute("href", CONNECT);
  await expect(page.locator("#checks .ui-button--primary")).toHaveCount(1);
  await expect(page.getByText("No tasks yet. Eyes texts you when one is near.")).toBeVisible();
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
  await page.getByRole("button", { name: "Install / open Eyes app" }).click();
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
  const auth = await mockMe(page, () => ({ json: allDone }));
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
