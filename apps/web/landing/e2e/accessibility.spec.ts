import { expect, test } from "@playwright/test";
import { PAGE_CSS, PAGE_HEADER } from "../../../../packages/ui/src/page.ts";

for (const colorScheme of ["light", "dark"] as const) {
  test(`status text meets AA contrast in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.setContent(`<style>${PAGE_CSS}</style><body class="ui">${PAGE_HEADER}<main class="page">
      <p class="note error">Request failed</p>
      <span class="ui-badge ui-badge--success">Success</span>
      <span class="ui-badge ui-badge--warning">Warning</span>
      <span class="ui-badge ui-badge--danger">Danger</span></main></body>`);
    const ratios = await page.locator(".note, .ui-badge").evaluateAll((elements) => {
      const rgb = (color: string) => color.match(/[\d.]+/g)?.map(Number) ?? [];
      const luminance = (color: number[]) =>
        color.slice(0, 3).reduce((sum, value, index) => {
          const channel = value / 255;
          const weight = [0.2126, 0.7152, 0.0722][index] ?? 0;
          return sum + (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) * weight;
        }, 0);
      const surface = rgb(getComputedStyle(document.body).backgroundColor);
      return elements.map((element) => {
        const style = getComputedStyle(element);
        const background = rgb(style.backgroundColor);
        const alpha = background[3] ?? 1;
        const back = luminance(
          background.slice(0, 3).map((channel, index) => {
            const surfaceChannel = surface[index] ?? 0;
            return channel * alpha + surfaceChannel * (1 - alpha);
          }),
        );
        const front = luminance(rgb(style.color));
        return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
      });
    });
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
}

test("phone navigation targets are at least 44 by 44 pixels", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  for (const target of await page.locator(".ui-site-head__home, footer a").all()) {
    const box = await target.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  await page.setContent(
    `<style>${PAGE_CSS}</style><body class="ui"><main class="page"><ul class="docs"><li><a href="/llms.txt">llms.txt</a><span>Agent documentation</span></li></ul></main></body>`,
  );
  const box = await page.locator(".docs a").boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
});

test("keyboard users can focus and scroll every code sample", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const details = page.locator("#agents details");
  await details.locator("summary").click();
  await details.locator("a").focus();
  for (const sample of await details.locator("pre").all()) {
    await page.keyboard.press("Tab");
    await expect(sample).toBeFocused();
    await expect(sample).toHaveAccessibleName(/.+/);
    await expect(sample).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => sample.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  }
});

test("marquee pause persists after focus leaves and reduced motion stops animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const track = page.locator(".marquee__track");
  const pause = page.getByRole("button", { name: /^(Pause|Play) questions$/ });
  await expect(track).toHaveCSS("animation-play-state", "running");
  await pause.focus();
  await expect(track).toHaveCSS("animation-play-state", "paused");
  await page.keyboard.press("Space");
  await expect(pause).toHaveAttribute("aria-pressed", "true");
  await expect(pause).toHaveAccessibleName("Play questions");
  await expect(pause.locator(".marquee__play-icon")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(track).toHaveCSS("animation-play-state", "paused");
  await pause.focus();
  await page.keyboard.press("Space");
  await expect(pause).toHaveAttribute("aria-pressed", "false");
  await expect(pause).toHaveAccessibleName("Pause questions");
  await expect(pause.locator(".marquee__pause-icon")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(track).toHaveCSS("animation-play-state", "running");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(track).toHaveCSS("animation-name", "none");
  await expect(pause).toBeHidden();
});

test("mouse users can resume the marquee without moving focus", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const track = page.locator(".marquee__track");
  const pause = page.getByRole("button", { name: /^(Pause|Play) questions$/ });
  await pause.click();
  await page.mouse.move(0, 0);
  await expect(track).toHaveCSS("animation-play-state", "paused");
  await pause.click();
  await page.mouse.move(0, 0);
  await expect(pause).toBeFocused();
  await expect(track).toHaveCSS("animation-play-state", "running");
});

test("marquee controls preserve the band height on phones and desktops", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    const band = await page.locator(".marquee").boundingBox();
    const track = await page.locator(".marquee__track").boundingBox();
    const button = await page.getByRole("button", { name: "Pause questions" }).boundingBox();
    expect(band?.height).toBe(track?.height);
    expect(button?.width).toBe(44);
    expect(button?.height).toBe(44);
    expect(button && band && button.y + button.height / 2).toBeCloseTo(band ? band.y + band.height / 2 : NaN);
    expect(button?.x).toBeGreaterThan(width / 2);
  }
});

test("marquee text fades before the button's reserved space", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    const textWindow = page.locator(".marquee__track").locator("..");
    const text = await textWindow.boundingBox();
    const button = await page.getByRole("button", { name: "Pause questions" }).boundingBox();
    expect(text && button && text.x + text.width).toBeLessThanOrEqual(button ? button.x - 8 : NaN);
    await expect(textWindow).toHaveCSS("overflow-x", "hidden");
    await expect(textWindow).toHaveCSS("mask-image", /linear-gradient/);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  const textWindow = page.locator(".marquee__track").locator("..");
  const band = await page.locator(".marquee").boundingBox();
  const text = await textWindow.boundingBox();
  expect(text?.width).toBe(band?.width);
  await expect(textWindow).toHaveCSS("mask-image", "none");
});
