import { expect, test } from "@playwright/test";

for (const site of [process.env.LANDING_URL, process.env.WORKER_URL].filter(Boolean)) {
  test(`unknown paths return a usable 404 at ${site}`, async ({ page }) => {
    for (const path of ["/missing-u1", "/missing-u1/nested"]) {
      const response = await page.goto(`${site}${path}`);
      expect(response?.status()).toBe(404);
      await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
      await page.getByRole("link", { name: "Back to home" }).click();
      await expect(page).toHaveURL(`${site}/`);
    }
  });
}
