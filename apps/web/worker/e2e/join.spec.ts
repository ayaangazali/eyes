import { expect, type Page, test } from "@playwright/test";

const joined = {
  worker_id: "8f14e45f-ceea-467e-a2d8-0a8a5f2b6c11",
  opt_in_instructions: "Text START to +14155550199.",
  inkbox_number: "+14155550199",
  connect_url: null,
};

async function mockJoin(page: Page, reply: { status?: number; json: object }) {
  const posts: { name: string; phone: string; lat: number; lng: number }[] = [];
  await page.route("**/api/**", async (route) => {
    posts.push(route.request().postDataJSON());
    await route.fulfill(reply);
  });
  return posts;
}

async function fill(page: Page, name: string, phone: string, locate = true) {
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Mobile number").fill(phone);
  if (locate) {
    await page.getByRole("button", { name: "Use my location" }).click();
    await expect(page.getByText("Location set")).toBeVisible();
  }
  await page.getByRole("button", { name: "Join" }).click();
}

test("join posts a normalized phone and location, then shows the START and payout steps", async ({
  page,
}) => {
  const posts = await mockJoin(page, { json: joined });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Worker sign-up opens soon" })).toBeHidden();
  await fill(page, "Ada Lovelace", "(415) 555-0123");

  await expect(page.getByRole("link", { name: "Text START to +14155550199" })).toHaveAttribute(
    "href",
    "sms:+14155550199?&body=START",
  );
  await expect(page.getByText("we'll text you a link to set up payouts")).toBeVisible();
  await expect(page.getByRole("link", { name: /payouts/i })).toHaveCount(0);
  await expect(page.getByText("Reply YES to claim a task")).toBeVisible();
  expect(posts).toEqual([{ name: "Ada Lovelace", phone: "+14155550123", lat: 37.78246, lng: -122.40776 }]);
});

test("a build without an Inkbox number says sign-up opens soon and asks for nothing", async ({ page }) => {
  const offsite: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("http://127.0.0.1:4174/")) offsite.push(request.url());
  });
  await page.goto("http://127.0.0.1:4174/");
  await expect(page.getByRole("heading", { name: "Worker sign-up opens soon" })).toBeVisible();
  await expect(page.getByText("You need an iPhone.")).toBeVisible();
  await expect(page.getByLabel("Mobile number")).toBeHidden();
  await expect(page.getByRole("button", { name: "Join" })).toBeHidden();
  expect(offsite).toEqual([]);
});

test("phone formats normalize to E.164 and the build-time number is the START fallback", async ({ page }) => {
  const posts = await mockJoin(page, { json: { ...joined, inkbox_number: null } });
  for (const phone of ["1 (415) 555-0123", "+1 415.555.0123", "+44 20 7946 0958"]) {
    await page.goto("/");
    await fill(page, "Ada Lovelace", phone);
    await expect(page.getByRole("link", { name: "Text START to +14155550100" })).toHaveAttribute(
      "href",
      "sms:+14155550100?&body=START",
    );
  }
  expect(posts.map((p) => p.phone)).toEqual(["+14155550123", "+14155550123", "+442079460958"]);
});

test("bad phone, short name or missing location explain the problem and post nothing", async ({ page }) => {
  const posts = await mockJoin(page, { json: joined });
  await page.goto("/");
  const alert = page.getByRole("alert");
  for (const phone of ["555-0123", "415-555-CALL", "(015) 555-0123", "(415) 155-0123", "+1 415 555 012"]) {
    await fill(page, "Ada Lovelace", phone, false);
    await expect(alert).toContainText("That phone number does not look right.");
  }
  const phone = page.getByLabel("Mobile number");
  await expect(phone).toBeFocused();
  await expect(phone).toHaveAttribute("aria-invalid", "true");
  await fill(page, "  A ", "(415) 555-0123", false);
  await expect(alert).toContainText("Please enter your name.");
  await fill(page, "Ada Lovelace", "(415) 555-0123", false);
  await expect(alert).toContainText("We need your location");
  await expect(phone).not.toHaveAttribute("aria-invalid");
  await expect(page.getByRole("button", { name: "Use my location" })).toBeFocused();
  expect(posts).toEqual([]);
});

test("join errors show worker wording, not the agent-facing fix", async ({ page }) => {
  await mockJoin(page, {
    status: 400,
    json: {
      error: "invalid_input",
      message: "The request did not match the expected schema.",
      fix: "Correct the fields listed in `issues` and retry.",
    },
  });
  await page.goto("/");
  await fill(page, "Ada Lovelace", "(415) 555-0123");

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Eyes could not accept that.");
  await expect(alert).toContainText("Check what you entered, then try again.");
  await expect(alert).not.toContainText("issues");
  await expect(page.getByRole("link", { name: /Text START/ })).toHaveCount(0);
});
