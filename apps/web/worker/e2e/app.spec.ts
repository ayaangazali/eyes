import { expect, test } from "@playwright/test";

const code = "Xy3_abcDEFghiJKLmnoPQRstuVWXyz0123456789-_a";

test("/app hands the fragment code to the app and clears it from the address bar", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(`/app.html#c=${code}`, { waitUntil: "commit" });
  const open = page.getByRole("link", { name: "Open in the Eyes app" });
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute("href", `eyes://connect#c=${code}`);
  if (process.env.VITE_TESTFLIGHT_URL) {
    await expect(page.getByRole("link", { name: "Install it with TestFlight" })).toHaveAttribute(
      "href",
      process.env.VITE_TESTFLIGHT_URL,
    );
  } else {
    await expect(page.getByText("Ask the Eyes team for an invite")).toBeVisible();
  }
  expect(new URL(page.url()).hash).toBe("");
  expect(requests.filter((u) => u.includes(code) && !u.startsWith("eyes:"))).toEqual([]);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
});

test("/app without a code says to text APP", async ({ page }) => {
  await page.goto("/app.html");
  await expect(page.getByText("Text APP to the Eyes number")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open in the Eyes app" })).toBeHidden();
});
