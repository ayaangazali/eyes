import { expect, test } from "@playwright/test";

const offer = {
  task_id: "3f1c2b9e-6a4d-4e8f-9b7a-2c5d8e1f0a37",
  question: "Is oat milk in stock right now?",
  task_type: "in_stock",
  place_label: "Blue Bottle Coffee, Mint Plaza, San Francisco",
  lat: 37.78246,
  lng: -122.40776,
  radius_m: 150,
  bounty_usd: 3,
  deadline_at: new Date(Date.now() + 20 * 60_000).toISOString(),
  require_photo: true,
  status: "claimed",
  claimed_by_you: true,
};

test("capture sends a live photo with GPS and shows the verification", async ({ page }) => {
  let form: FormData | undefined;
  let captureUrl = "";
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: offer });
    captureUrl = request.url();
    form = await new Response(new Uint8Array(request.postDataBuffer() ?? []), {
      headers: { "content-type": (await request.allHeaders())["content-type"] ?? "" },
    }).formData();
    await route.fulfill({
      json: {
        task_id: offer.task_id,
        status: "verified",
        verification: {
          gps_ok: true,
          fresh_ok: true,
          vision_ok: true,
          vision_reason: "Oat milk cartons are on the shelf.",
        },
        message: "Verified. $3.00 is on its way to you.",
      },
    });
  });

  await page.context().setGeolocation({ latitude: 37.79554, longitude: -122.39377, accuracy: 10 });
  await page.goto("/capture.html?t=tok_capture");
  await expect(page.getByRole("heading", { name: offer.question })).toBeVisible();
  await expect(page.getByText(/You are \d{4} m from the place\./)).toBeVisible();
  await page.context().setGeolocation({ latitude: 37.78246, longitude: -122.40776, accuracy: 10 });
  await expect(page.getByText("$3.00")).toBeVisible();
  await expect(page.getByText(/\d+:\d\d left/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Blue Bottle Coffee/ })).toHaveAttribute(
    "href",
    "https://www.google.com/maps/search/?api=1&query=37.78246,-122.40776",
  );
  await expect(page.getByText("Do not photograph faces.")).toBeVisible();

  await page.getByRole("button", { name: "Take photo" }).click();
  await expect(page.getByAltText("What you captured")).toBeVisible();
  await expect(page.getByText("You are 0 m from the place.")).toBeVisible();
  await page.getByLabel("Yes").check();
  await page.getByLabel("Anything to add?").fill("Two cartons left");
  await page.getByRole("button", { name: "Send to Eyes" }).click();

  await expect(page.getByText("Verified. $3.00 is on its way to you.")).toBeVisible();
  await expect(page.getByText("Photo answers the question: passed")).toBeVisible();
  await expect(page.getByText("Oat milk cartons are on the shelf.")).toBeVisible();

  expect(captureUrl).toBe("http://127.0.0.1:4173/api/w/offers/tok_capture/capture");
  const photo = form?.get("photo");
  expect(photo).toBeInstanceOf(File);
  expect((photo as File).type).toBe("image/jpeg");
  expect((photo as File).size).toBeGreaterThan(1000);
  expect(form?.get("lat")).toBe("37.78246");
  expect(form?.get("lng")).toBe("-122.40776");
  expect(form?.get("accuracy_m")).toBe("10");
  expect(form?.get("answer_bool")).toBe("true");
  expect(form?.get("answer_text")).toBe("Two cartons left");
  const capturedAt = Date.parse(String(form?.get("captured_at")));
  expect(Math.abs(Date.now() - capturedAt)).toBeLessThan(60_000);
});

test("an expired or invalid link shows the error and fix, with no camera", async ({ page }) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 404,
      json: {
        error: "offer_invalid",
        message: "This task link is invalid or has expired.",
        fix: "Open the newest link Eyes texted you. Expired tasks cannot be submitted.",
      },
    }),
  );
  await page.goto("/capture.html?t=tok_expired");

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("This task link is invalid or has expired.");
  await expect(alert).toContainText("Open the newest link Eyes texted you.");
  await expect(page.getByRole("button", { name: "Take photo" })).toBeHidden();
});
