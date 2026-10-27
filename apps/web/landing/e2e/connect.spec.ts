import { expect, test } from "@playwright/test";

const serverURL = "https://mcp.eyes.pictures/mcp";

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`web connect ${viewport.width}px ${colorScheme}`, async ({ page, context }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme });
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto("/");
      await page.evaluate(() => document.fonts.ready);
      const ctas = page.locator(".pair").first().locator(":scope > .ui-button");
      const heights = await ctas.evaluateAll((buttons) =>
        buttons.map((button) => button.getBoundingClientRect().height),
      );
      expect(heights).toHaveLength(2);
      expect(heights[0]).toBe(heights[1]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath("hero.png") });

      const opener = page.getByRole("button", { name: "Connect your agent", exact: true });
      await opener.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Connect Eyes", exact: true });
      await expect(dialog).toBeVisible();
      await expect(page.locator("#connect-title")).toBeFocused();
      await expect(dialog.getByRole("region", { name: "ChatGPT setup" })).toBeVisible();
      await expect(dialog.getByRole("region", { name: "Claude setup" })).toBeHidden();
      const url = dialog.getByLabel("MCP server URL");
      await expect(url).toHaveValue(serverURL);
      await expect(url).toHaveAttribute("readonly", "");
      await dialog.getByRole("button", { name: "Copy server URL" }).click();
      await expect(dialog.getByRole("status")).toContainText("Copied.");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(serverURL);
      await expect(dialog.getByRole("link", { name: "Open ChatGPT" })).toHaveAttribute(
        "href",
        "https://chatgpt.com/plugins",
      );
      await expect(dialog).toContainText("Add custom MCP server");
      await expect(dialog).toContainText("OAuth");
      await expect(dialog).toContainText("existing Eyes API key");
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath("chatgpt.png") });
      await dialog.getByText("Account requirements & public listing", { exact: true }).click();
      await expect(dialog).toContainText("does not require Developer Mode");
      await expect(dialog).toContainText("Free and Plus access is not guaranteed");
      await expect(dialog).toContainText("OpenAI review, approval, and publishing");
      await dialog.getByLabel("Choose your app").selectOption("claude");
      expect(await dialog.evaluate((element) => element.scrollTop)).toBe(0);
      await expect(dialog.getByRole("region", { name: "ChatGPT setup" })).toBeHidden();
      const claude = dialog.getByRole("region", { name: "Claude setup" });
      await expect(claude).toBeVisible();
      await expect(claude.getByRole("link", { name: "Open Claude" })).toHaveAttribute(
        "href",
        "https://claude.ai/customize/connectors",
      );
      await expect(claude).toContainText("Add custom connector");
      await expect(claude).toContainText("Register automatically");
      await expect(claude).toContainText("existing Eyes API key");
      await dialog.getByRole("button", { name: "Copy server URL" }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(serverURL);
      await page.screenshot({ path: test.info().outputPath("claude.png") });
      await claude.getByText("Claude account requirements", { exact: true }).click();
      await expect(claude).toContainText("Free is limited to one custom connector");
      await expect(claude).toContainText("Owner or Primary Owner");
      await expect(claude).toContainText("not a one-click install");

      // Chromium may move focus to browser chrome (reported as body), never to background controls.
      for (const key of ["Tab", "Shift+Tab"]) {
        for (let tab = 0; tab < 12; tab++) {
          await page.keyboard.press(key);
          expect(
            await dialog.evaluate(
              (element) =>
                element.contains(document.activeElement) || document.activeElement === document.body,
            ),
          ).toBe(true);
        }
      }
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(opener).toBeFocused();
      const addClaude = page.getByRole("button", { name: "Add to Claude", exact: true });
      await addClaude.click();
      await expect(dialog.getByRole("region", { name: "Claude setup" })).toBeVisible();
      await expect(dialog.getByRole("region", { name: "ChatGPT setup" })).toBeHidden();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(addClaude).toBeFocused();
      await page.getByRole("button", { name: "Add to ChatGPT", exact: true }).click();
      await expect(dialog.getByRole("region", { name: "ChatGPT setup" })).toBeVisible();
      await expect(dialog.getByLabel("Choose your app")).toHaveValue("chatgpt");
    });
  }
}

test("app links open the chosen setup", async ({ page }) => {
  await page.goto("/#add-claude");
  const dialog = page.getByRole("dialog", { name: "Connect Eyes", exact: true });
  await expect(dialog.getByRole("region", { name: "Claude setup" })).toBeVisible();
  await expect(dialog.getByRole("region", { name: "ChatGPT setup" })).toBeHidden();
  await expect(dialog.getByLabel("Choose your app")).toHaveValue("claude");
});

test("clipboard denial selects the URL without false success", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("clipboard denied");
        },
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Connect your agent", exact: true }).click();
  await page.getByLabel("Choose your app").selectOption("claude");
  await page.getByRole("button", { name: "Copy server URL" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Copy unavailable. Select the server URL and copy it manually.",
  );
  await expect(page.getByLabel("MCP server URL")).toBeFocused();
  expect(
    await page
      .locator("#connect")
      .evaluate((element: HTMLInputElement) =>
        element.value.slice(element.selectionStart ?? 0, element.selectionEnd ?? 0),
      ),
  ).toBe(serverURL);
});
