import { expect, test } from "@playwright/test";

const code = "Xy3_abcDEFghiJKLmnoPQRstuVWXyz0123456789-_a";

test("/app hands the fragment code to the app and clears it from the address bar", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(`/app.html#c=${code}`, { waitUntil: "commit" });
  const open = page.getByRole("link", { name: "Install / open Eyes app" });
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute("href", `eyes://connect#c=${code}`);
  expect(new URL(page.url()).hash).toBe("");
  expect(requests.filter((u) => u.includes(code) && !u.startsWith("eyes:"))).toEqual([]);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
});

test("/app sends a tap with no app to TestFlight, or to the install page with the code", async ({ page }) => {
  const testflight = process.env.VITE_TESTFLIGHT_URL;
  if (testflight) await page.route(testflight, (r) => r.fulfill({ body: "TestFlight" }));
  await page.goto(`/app.html#c=${code}`);
  await page.getByRole("link", { name: "Install / open Eyes app" }).click();
  // Polls page.url(): the eyes:// attempt fails (ERR_ABORTED) in Chromium, which ends a toHaveURL wait early.
  await expect
    .poll(() => page.url(), { timeout: 8000 })
    .toBe(testflight ?? `${new URL(page.url()).origin}/install#c=${code}`);
});

test("/app without a code offers a text APP button", async ({ page }) => {
  await page.goto("/app.html");
  await expect(page.getByText("This link has no code.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Text APP for a new link" })).toHaveAttribute(
    "href",
    "sms:+14155550100?&body=APP",
  );
  await expect(page.getByRole("link", { name: "Install / open Eyes app" })).toBeHidden();
});
