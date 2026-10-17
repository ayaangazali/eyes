import { expect, type Page, type Route, test } from "@playwright/test";

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

const okResult = {
  task_id: offer.task_id,
  status: "verified",
  verification: {
    gps_ok: true,
    fresh_ok: true,
    vision_ok: true,
    vision_reason: "Oat milk cartons are on the shelf.",
  },
  message: "Verified. $3.00 is on its way to you.",
};

function mockOffer(page: Page, view: object, onPost?: (route: Route) => Promise<void> | void) {
  return page.route("**/api/**", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: view });
    return onPost ? onPost(route) : route.fulfill({ json: okResult });
  });
}

async function formOf(route: Route) {
  const request = route.request();
  return new Response(new Uint8Array(request.postDataBuffer() ?? []), {
    headers: { "content-type": (await request.allHeaders())["content-type"] ?? "" },
  }).formData();
}

async function fakeGps(page: Page) {
  await page.addInitScript(() => {
    const watchers = new Map<number, [PositionCallback, PositionErrorCallback | null | undefined]>();
    let id = 0;
    const geo = {
      watchPosition(ok: PositionCallback, err?: PositionErrorCallback | null) {
        id += 1;
        watchers.set(id, [ok, err]);
        return id;
      },
      clearWatch(n: number) {
        watchers.delete(n);
      },
    };
    const w = window as unknown as Record<string, unknown>;
    w.__watchers = () => watchers.size;
    w.__emit = (latitude: number, longitude: number, accuracy: number) => {
      for (const [ok] of [...watchers.values()]) {
        ok({ coords: { latitude, longitude, accuracy }, timestamp: Date.now() } as GeolocationPosition);
      }
    };
    w.__deny = () => {
      for (const [, err] of [...watchers.values()]) {
        err?.({ code: 1, PERMISSION_DENIED: 1, message: "denied" } as GeolocationPositionError);
      }
    };
    Object.defineProperty(Navigator.prototype, "geolocation", { get: () => geo });
  });
}

async function emit(page: Page, lat: number, lng: number, accuracy: number) {
  await expect(page.getByText("Getting your location...")).toBeVisible();
  await page.evaluate(
    (args) => (window as unknown as { __emit: (...x: number[]) => void }).__emit(...args),
    [lat, lng, accuracy],
  );
}

const takePhoto = async (page: Page, name = "Take photo") => {
  await page.getByRole("button", { name }).click();
  await expect(page.getByAltText("What you captured")).toBeVisible();
};

test("capture sends a live photo with GPS and shows the verification", async ({ page }) => {
  let form: FormData | undefined;
  let captureUrl = "";
  await mockOffer(page, offer, async (route) => {
    captureUrl = route.request().url();
    form = await formOf(route);
    await route.fulfill({ json: okResult });
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

  await takePhoto(page);
  await expect(page.getByText("You are 0 m from the place.")).toBeVisible();
  await page.getByLabel("Yes").check();
  await page.getByLabel("Anything to add?").fill("Two cartons left");
  await page.getByRole("button", { name: "Send to Eyes" }).click();

  await expect(page.getByText(okResult.message)).toBeVisible();
  await expect(page.getByText("Photo answers the question: passed")).toBeVisible();
  await expect(page.getByText(okResult.verification.vision_reason)).toBeVisible();

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

for (const [why, view, reason] of [
  [
    "claimed by someone else",
    { ...offer, claimed_by_you: false },
    "Another worker already claimed this task.",
  ],
  [
    "past its deadline",
    { ...offer, deadline_at: new Date(Date.now() - 1000).toISOString() },
    "This task expired.",
  ],
] as const) {
  test(`an offer ${why} stops with a reason and starts no camera or GPS`, async ({ page }) => {
    await fakeGps(page);
    await mockOffer(page, view);
    await page.goto("/capture.html?t=tok");
    await expect(page.getByText(reason)).toBeVisible();
    await expect(page.getByRole("button", { name: "Take photo" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Send to Eyes" })).toBeHidden();
    expect(await page.evaluate(() => (window as unknown as { __watchers: () => number }).__watchers())).toBe(
      0,
    );
  });
}

test("after the shutter, a search that finds nothing better keeps the earlier fix", async ({ page }) => {
  let form: FormData | undefined;
  await page.clock.install();
  await fakeGps(page);
  await mockOffer(page, offer, async (route) => {
    form = await formOf(route);
    await route.fulfill({ json: okResult });
  });
  await page.goto("/capture.html?t=tok");
  await emit(page, offer.lat, offer.lng, 10);
  await takePhoto(page);
  await emit(page, 37.79554, -122.39377, 400);

  const send = page.getByRole("button", { name: "Send to Eyes" });
  await expect(send).toBeDisabled();
  await page.clock.runFor(16_000);
  await expect(send).toBeEnabled();
  await expect(page.getByRole("alert")).toBeHidden();
  await send.click();
  await expect(page.getByText(okResult.message)).toBeVisible();
  expect([form?.get("lat"), form?.get("accuracy_m")]).toEqual(["37.78246", "10"]);
});

test("denied location explains how to allow it and keeps Send disabled", async ({ page }) => {
  await fakeGps(page);
  await mockOffer(page, offer);
  await page.goto("/capture.html?t=tok");
  await expect(page.getByRole("button", { name: "Take photo" })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { __deny: () => void }).__deny());

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("We could not get your location.");
  await expect(alert).toContainText("Allow location for this page");
  await takePhoto(page);
  await expect(alert).toBeHidden();
  await expect(page.getByRole("button", { name: "Send to Eyes" })).toBeDisabled();
});

for (const [name, fallback] of [
  ["NotAllowedError", false],
  ["NotFoundError", true],
] as const) {
  test(`camera ${name} ${fallback ? "offers the capture fallback" : "says the camera is blocked"}`, async ({
    page,
  }) => {
    await page.addInitScript((errorName) => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("no camera", errorName));
    }, name);
    await mockOffer(page, offer);
    await page.goto("/capture.html?t=tok");
    await expect(page.getByRole("button", { name: "Take photo" })).toBeHidden();
    if (fallback) {
      await expect(page.getByLabel("Take the photo")).toHaveAttribute("capture", "environment");
      await expect(page.getByRole("alert")).toBeHidden();
    } else {
      await expect(page.getByRole("alert")).toContainText("Your camera is blocked.");
      await expect(page.getByLabel("Take the photo")).toBeHidden();
    }
  });
}

test("a task type without a yes/no answer hides it and sends an empty answer_bool", async ({ page }) => {
  let form: FormData | undefined;
  await mockOffer(page, { ...offer, task_type: "line_length" }, async (route) => {
    form = await formOf(route);
    await route.fulfill({ json: okResult });
  });
  await page.goto("/capture.html?t=tok");
  await takePhoto(page);
  await expect(page.getByLabel("Yes")).toBeHidden();
  await page.getByRole("button", { name: "Send to Eyes" }).click();
  await expect(page.getByText(okResult.message)).toBeVisible();
  expect([form?.get("answer_bool"), form?.get("answer_text")]).toEqual(["", ""]);
});

test("Send stays disabled during an upload despite a double tap, a retake and a new GPS fix", async ({
  page,
}) => {
  let posts = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await fakeGps(page);
  await mockOffer(page, offer, async (route) => {
    posts += 1;
    await held;
    await route.fulfill({ json: okResult });
  });
  await page.goto("/capture.html?t=tok");
  await emit(page, offer.lat, offer.lng, 10);
  await takePhoto(page);
  await emit(page, offer.lat, offer.lng, 10);

  const send = page.getByRole("button", { name: "Send to Eyes" });
  await send.dblclick();
  await expect.poll(() => posts).toBe(1);
  await takePhoto(page, "Retake photo");
  await emit(page, offer.lat, offer.lng, 5);
  await expect(page.getByText("GPS within 5 m")).toBeVisible();
  await expect(send).toBeDisabled();
  release();
  await expect(page.getByText(okResult.message)).toBeVisible();
  expect(posts).toBe(1);
});

test("a final capture error (409) shows worker wording and closes the form", async ({ page }) => {
  await mockOffer(page, offer, (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: "task_already_claimed",
        message: "Another worker already claimed this task.",
        fix: "No action needed. Watch for the next task text.",
      },
    }),
  );
  await page.goto("/capture.html?t=tok");
  await takePhoto(page);
  await page.getByRole("button", { name: "Send to Eyes" }).click();

  await expect(page.getByRole("alert")).toContainText("Another worker already claimed this task.");
  await expect(page.getByRole("button", { name: "Send to Eyes", includeHidden: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Send to Eyes" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Sent" })).toBeHidden();
});

test("a server error (500) shows worker wording, not the agent fix, and allows a retry", async ({ page }) => {
  await mockOffer(page, offer, (route) =>
    route.fulfill({
      status: 500,
      json: {
        error: "internal_error",
        message: "Something went wrong on our side.",
        fix: "Retry the same call. If you passed an idempotency_key, reuse it; retries are safe.",
      },
    }),
  );
  await page.goto("/capture.html?t=tok");
  await takePhoto(page);
  await page.getByRole("button", { name: "Send to Eyes" }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Something went wrong at Eyes.");
  await expect(alert).not.toContainText("idempotency_key");
  await expect(page.getByRole("button", { name: "Send to Eyes" })).toBeEnabled();
});

test("the deadline passing mid-capture shows the expired state and blocks capture", async ({ page }) => {
  let posts = 0;
  await page.clock.install();
  await mockOffer(page, { ...offer, deadline_at: new Date(Date.now() + 30_000).toISOString() }, (route) => {
    posts += 1;
    return route.fulfill({ json: okResult });
  });
  await page.goto("/capture.html?t=tok");
  await takePhoto(page);
  await page.clock.runFor(31_000);

  await expect(page.getByText("Deadline passed")).toBeVisible();
  await expect(page.getByText("This task expired.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send to Eyes", includeHidden: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Retake photo", includeHidden: true })).toBeDisabled();
  expect(posts).toBe(0);
});
