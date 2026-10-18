import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { FIXTURES } from "../fixtures/index.ts";

const out = fileURLToPath(new URL("../../../../docs/manufact/widget/", import.meta.url));
const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "warn" });
await server.listen();
const base = server.resolvedUrls?.local[0] ?? "";
const browser = await chromium.launch();

try {
  for (const theme of ["light", "dark"] as const) {
    const page = await browser.newPage({ colorScheme: theme, reducedMotion: "reduce", deviceScaleFactor: 2 });
    const foreign: string[] = [];
    page.on("request", (req) => {
      if (!req.url().startsWith(base)) foreign.push(req.url());
    });
    await page.goto(`${base}preview/`);
    for (const state of Object.keys(FIXTURES)) {
      await page.locator(`#${state}-420 .eyes-card`).screenshot({ path: `${out}${state}-${theme}.png` });
    }
    await page.locator("#answered-320 .eyes-card").screenshot({ path: `${out}answered-${theme}-320.png` });
    await page.locator("#answered-420").getByRole("button", { name: "Dispute" }).click();
    await page.locator("#answered-420").getByText("Mock call: dispute_answer").waitFor();
    if (foreign.length > 0)
      throw new Error(`the preview made requests off the dev server: ${foreign.join(", ")}`);
    console.log(
      `${theme}: ${Object.keys(FIXTURES).length + 1} shots, Dispute click logged, no foreign requests`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}
