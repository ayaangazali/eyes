import { expect, type Page, test } from "@playwright/test";

const CODE = "a".repeat(43);
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";
const base = { profile_url: "https://api.eyes.test/w/device/profile/t", registered: false, ready: false };

test.use({ userAgent: IPHONE, viewport: { width: 390, height: 844 } });

/** Answers POST /w/device; reply gets the call number. */
async function mockDevice(page: Page, reply: (n: number) => object) {
  let n = 0;
  await page.route("**/api/w/device", (route) => route.fulfill({ json: { ...base, ...reply(++n) } }));
  return () => n;
}

const current = (page: Page) => page.locator('#steps > li[aria-current="step"] h2');

/** SHOTS=<dir> saves light and dark 390 px screenshots of each state. */
async function shot(page: Page, name: string) {
  if (!process.env.SHOTS) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.evaluate(() => window.scrollTo(0, 0)); // the sticky header otherwise lands mid-page
    await page.screenshot({
      path: `${process.env.SHOTS}/install-${name}-${scheme}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
}

test("register, then waiting, install and open: Developer Mode is help, not a step", async ({ page }) => {
  await mockDevice(page, () => ({}));
  await page.goto(`/install.html#c=${CODE}`);
  await expect(current(page)).toHaveText("Register this iPhone");
  expect(page.url()).not.toContain(CODE);
  await expect(page.locator("#steps > li")).toHaveCount(3);
  await shot(page, "register");
  await page.getByRole("button", { name: "I already did this" }).first().click();
  await expect(current(page)).toHaveText("Install Eyes");
  await expect(page.locator("#waiting")).toBeVisible();
  await shot(page, "waiting");
});

test("Install tap moves to Open Eyes; the app connecting finishes the page", async ({ page }) => {
  await mockDevice(page, (n) => ({ registered: true, ready: true, app_connected: n >= 3 }));
  await page.goto(`/install.html#c=${CODE}`);
  await expect(current(page)).toHaveText("Install Eyes");
  await shot(page, "install");
  await page.locator("#itms").evaluate((a) => a.removeAttribute("href")); // no itms-services navigation here
  await page.locator("#itms").click();
  await expect(current(page)).toHaveText("Open Eyes");
  await expect(page.getByText("If Eyes won't open")).toBeVisible();
  await expect(page.getByText("Turn on Developer Mode")).toHaveCount(0);
  await shot(page, "open");
  // The page asks every 5 s; the third answer says the app sent a fix.
  await expect(page.getByText("Eyes is connected. You can close this page.")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator("#steps > li[data-done]")).toHaveCount(3);
  expect(await page.evaluate(() => localStorage.getItem("eyes-install"))).toBeNull();
  await shot(page, "connected");
});

test("I already did this on Open Eyes ends the steps, keeping the code", async ({ page }) => {
  await mockDevice(page, () => ({ registered: true, ready: true }));
  await page.goto(`/install.html#c=${CODE}`);
  await page.locator("#itms").evaluate((a) => a.removeAttribute("href"));
  await page.locator("#itms").click();
  await page.locator('li[data-key="open"]').getByRole("button", { name: "I already did this" }).click();
  await expect(page.getByText("All steps done. You can close this page.")).toBeVisible();
  await expect(page.locator("#steps > li[data-done]")).toHaveCount(3);
  await page.reload();
  await expect(page.getByText("All steps done. You can close this page.")).toBeVisible();
  await shot(page, "done");
});
