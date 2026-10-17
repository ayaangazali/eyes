import { expect, type Page, test } from "@playwright/test";

async function fillAndJoin(page: Page) {
  await page.goto("/");
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Mobile number").fill("(415) 555-0123");
  await page.getByRole("button", { name: "Use my location" }).click();
  await expect(page.getByText("Location set")).toBeVisible();
  await page.getByRole("button", { name: "Join" }).click();
}

test("join posts a normalized phone and location, then shows the START step", async ({ page }) => {
  let sent: unknown;
  await page.route("**/api/**", async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      json: {
        worker_id: "8f14e45f-ceea-467e-a2d8-0a8a5f2b6c11",
        opt_in_instructions: "Text START to +14155550100.",
        inkbox_number: "+14155550100",
        connect_url: "http://127.0.0.1:4173/api/w/connect/tok_join",
      },
    });
  });
  await fillAndJoin(page);

  await expect(page.getByRole("link", { name: "Text START to +14155550100" })).toHaveAttribute(
    "href",
    "sms:+14155550100?&body=START",
  );
  await expect(page.getByRole("link", { name: "Set up payouts" })).toHaveAttribute(
    "href",
    "http://127.0.0.1:4173/api/w/connect/tok_join",
  );
  await expect(page.getByText("Reply YES to claim a task")).toBeVisible();
  expect(sent).toEqual({ name: "Ada Lovelace", phone: "+14155550123", lat: 37.78246, lng: -122.40776 });
});

test("join shows the catalog error message and fix", async ({ page }) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 400,
      json: {
        error: "invalid_input",
        message: "The request did not match the expected schema.",
        fix: "Correct the fields listed in `issues` and retry.",
      },
    }),
  );
  await fillAndJoin(page);

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("The request did not match the expected schema.");
  await expect(alert).toContainText("Correct the fields listed in `issues` and retry.");
  await expect(page.getByRole("link", { name: /Text START/ })).toBeHidden();
});
