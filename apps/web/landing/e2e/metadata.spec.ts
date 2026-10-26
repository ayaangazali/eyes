import { expect, test } from "@playwright/test";

for (const [base, origin, paths] of [
  [process.env.LANDING_URL, "https://eyes.pictures", ["/", "/privacy", "/terms"]],
  [
    process.env.WORKER_URL,
    "https://app.eyes.pictures",
    ["/", "/app", "/automation", "/capture", "/here", "/install", "/login", "/me"],
  ],
] as const) {
  test(`published metadata and cache policy for ${origin}`, async ({ page, request }) => {
    test.skip(
      !base || !process.env.LANDING_URL,
      "Set LANDING_URL and WORKER_URL to the built asset servers.",
    );
    for (const path of paths) {
      await page.goto(`${base}${path}`);
      const canonical = `${origin}${path}`;
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", canonical);
      await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", canonical);
      await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /\S/);
      await expect(page.locator('meta[property="og:description"]')).toHaveAttribute("content", /\S/);
      await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
        "content",
        "summary_large_image",
      );
      const image = (await page.locator('meta[property="og:image"]').getAttribute("content")) ?? "";
      expect(image).toMatch(/^https:\/\/eyes\.pictures\/.*\.jpg$/);
      await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute("content", image);
      const imageResponse = await request.get(`${process.env.LANDING_URL}${new URL(image).pathname}`);
      expect(imageResponse.status()).toBe(200);
      expect(imageResponse.headers()["content-type"]).toContain("image/jpeg");
      if (origin.includes("app.")) {
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
      }
    }
    const html = await request.get(`${base}/`);
    expect(html.headers()["cache-control"]).toBe("public, max-age=60, must-revalidate");
    const asset = await page.locator('link[rel="stylesheet"]').first().getAttribute("href");
    const response = await request.get(`${base}${asset}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["x-frame-options"]).toBe("DENY");
    const robots = await request.get(`${base}/robots.txt`);
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toContain(
      origin.includes("app.") ? "Disallow: /" : "Sitemap: https://eyes.pictures/sitemap.xml",
    );
    const icon = (await page.locator('link[rel="apple-touch-icon"]').getAttribute("href")) ?? "";
    const iconResponse = await request.get(`${process.env.LANDING_URL}${new URL(icon).pathname}`);
    expect(iconResponse.status()).toBe(200);
    expect(iconResponse.headers()["content-type"]).toContain("image/png");
    const manifest = await request.get(`${base}/site.webmanifest`);
    expect(manifest.status()).toBe(200);
    expect(await manifest.json()).toMatchObject({ name: "Eyes", start_url: "/" });
  });
}

test("landing sitemap contains only indexable canonical pages", async ({ request }) => {
  test.skip(!process.env.LANDING_URL, "Set LANDING_URL to the built asset server.");
  const response = await request.get(`${process.env.LANDING_URL}/sitemap.xml`);
  expect(response.status()).toBe(200);
  const xml = await response.text();
  expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
  expect([...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1])).toEqual([
    "https://eyes.pictures/",
    "https://eyes.pictures/privacy",
    "https://eyes.pictures/terms",
  ]);
});

test("old worker privacy URLs permanently redirect to the canonical policy", async ({ request }) => {
  test.skip(!process.env.WORKER_URL, "Set WORKER_URL to the built asset server.");
  for (const path of ["/privacy", "/privacy/", "/privacy.html"]) {
    const response = await request.get(`${process.env.WORKER_URL}${path}`, { maxRedirects: 0 });
    expect(response.status()).toBe(301);
    expect(response.headers().location).toBe("https://eyes.pictures/privacy");
  }
});
