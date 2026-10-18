import { expect, type Page, test } from "@playwright/test";

// Worker email on /me and /login, against a mocked API.
const code = "eyJwIjoiZTp3MSIsImUiOjF9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
const loginCode = `${"A1_-".repeat(10)}abc`; // 43 base64url characters, like the API's
const MASKED = "a…@example.com";

const base = {
  opted_in: true,
  spot: { at: new Date().toISOString(), fresh: true, max_age_h: 24 },
  app: { connected: true, last_at: new Date().toISOString(), sending: true },
  payouts: { set_up: true, live: true, setup_url: null },
  here_url: "https://app.eyes.test/here.html?t=h.t",
};
const withEmail = (email_status: string, email_masked: string | null = MASKED, over: object = {}) => ({
  ...base,
  email_status,
  email_masked,
  email_skipped: false,
  ...over,
});

type Reply = { status?: number; json: object };

/** Mocks GET /w/me, its tasks, and POST /w/me/email (answers in order); records the email posts. */
async function mockMe(page: Page, setup: object, ...saves: Reply[]) {
  const posts: { body: { email: string | null }; auth?: string }[] = [];
  await page.route("**/api/w/me", (route) => route.fulfill({ json: setup }));
  await page.route("**/api/w/me/tasks?*", (route) =>
    route.fulfill({ json: { paid_usd: 0, pending_usd: 0, tasks: [], next_cursor: null } }),
  );
  await page.route("**/api/w/me/email", (route) => {
    posts.push({ body: route.request().postDataJSON(), auth: route.request().headers().authorization });
    return route.fulfill(saves.shift() ?? { status: 500, json: {} });
  });
  await page.goto(`/me.html#c=${code}`);
  return posts;
}

const emailRow = (page: Page) => page.locator("#checks > li.me-email");

test("/me shows no email row while the API does not send the email fields", async ({ page }) => {
  await mockMe(page, base);
  await expect(page.getByRole("heading", { name: "You're set up" })).toBeVisible();
  await expect(emailRow(page)).toHaveCount(0);
});

const instruction =
  "Reply EMAIL in your existing Eyes iMessage conversation. We’ll reply with a link to send your first email.";

for (const width of [390, 1440]) {
  for (const state of ["none", "pending", "verified"]) {
    test(`/me ${state} at ${width}px: text-only onboarding never starts email from the page`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      const starts: string[] = [];
      await page.route("**/api/w/me/email/start", (route) => {
        starts.push(route.request().method());
        return route.abort();
      });
      const posts = await mockMe(page, withEmail(state, state === "none" ? null : MASKED));
      const row = emailRow(page);
      await expect(row).toContainText(instruction);
      await expect(row).not.toContainText("Eyes iMessage:");
      await expect(row).not.toContainText("+14155550100");
      await expect(row).toContainText(
        "Send from an address your mail provider verifies; custom aliases need SPF/DKIM.",
      );
      const actions =
        state === "verified"
          ? ["Remove"]
          : state === "pending"
            ? ["Use iMessage only", "Remove"]
            : ["Use iMessage only"];
      await expect(row.getByRole("button")).toHaveText(actions);
      await expect(row.getByRole("link")).toHaveCount(0);
      await expect(
        row.locator("[data-act=add], [data-act=resend], [data-act=change], [data-act=copy]"),
      ).toHaveCount(0);
      await expect(page.locator(".me-email__send, .me-email__links, .me-email__fields")).toHaveCount(0);
      await row.locator(".ui-check__detail").click();
      await expect(row).toContainText(instruction);
      expect(starts).toEqual([]);
      expect(posts).toEqual([]);
      expect(new URL(page.url()).hash).toBe("");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      if (process.env.SHOTS) {
        await expect(row).toHaveCSS("opacity", "1");
        await row.screenshot({ path: `${process.env.SHOTS}/me-email-${state}-${width}.png` });
      }
    });
  }
}

for (const width of [390, 1440]) {
  test(`/me at ${width}px: iMessage-only choice is saved, survives reload and can resume email later`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const setup = withEmail("none", null, { app: { connected: true, last_at: null, sending: false } });
    const writes: { method: string; body: unknown; auth?: string }[] = [];
    let finish!: () => void;
    const save = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await page.route("**/api/w/me/email/skip", async (route) => {
      writes.push({
        method: route.request().method(),
        body: route.request().postDataJSON(),
        auth: route.request().headers().authorization,
      });
      await save;
      setup.email_skipped = true;
      await route.fulfill({ json: setup });
    });
    const emailWrites = await mockMe(page, setup);
    const button = emailRow(page).getByRole("button", { name: "Use iMessage only" });
    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(button).toBeDisabled();
    finish();
    await expect(emailRow(page)).toHaveClass(/ui-check--pass/);
    await expect(emailRow(page)).toContainText("Email optional — skipped");
    await expect(emailRow(page)).toContainText(instruction);
    await expect(emailRow(page).getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "You're set up" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Open \/ connect Eyes app/ })).toHaveCount(0);
    expect(writes).toEqual([{ method: "POST", body: {}, auth: `Bearer ${code}` }]);
    expect(emailWrites).toEqual([]);

    // Reload the signed setup link with no browser storage: the mocked server owns the saved choice.
    await page.evaluate((token) => {
      localStorage.clear();
      sessionStorage.clear();
      history.replaceState(null, "", `${location.pathname}#c=${token}`);
    }, code);
    await page.reload();
    await expect(emailRow(page)).toHaveClass(/ui-check--pass/);
    await expect(emailRow(page)).toContainText("Email optional — skipped");
    await expect(emailRow(page)).toContainText(instruction);
    expect(writes).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    if (process.env.SHOTS) {
      await expect(emailRow(page)).toHaveCSS("opacity", "1");
      await page.screenshot({ path: `${process.env.SHOTS}/setup-skipped-${width}.png`, fullPage: true });
    }
  });
}

test("/me: failed iMessage-only save stays unchecked and can be retried", async ({ page }) => {
  let attempts = 0;
  const setup = withEmail("none", null);
  await page.route("**/api/w/me/email/skip", (route) => {
    if (++attempts === 1)
      return route.fulfill({
        status: 503,
        json: { message: "Could not save your choice.", fix: "Try again." },
      });
    return route.fulfill({ json: { ...setup, email_skipped: true } });
  });
  await mockMe(page, setup);
  await emailRow(page).getByRole("button", { name: "Use iMessage only" }).click();
  await expect(emailRow(page).getByRole("alert")).toContainText("Could not save your choice.");
  await expect(emailRow(page)).not.toHaveClass(/ui-check--pass/);
  const retry = emailRow(page).getByRole("button", { name: "Use iMessage only" });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(emailRow(page)).toContainText("Email optional — skipped");
  expect(attempts).toBe(2);
});

test("/me: expired iMessage-only save shows the expired-link state", async ({ page }) => {
  await page.route("**/api/w/me/email/skip", (route) =>
    route.fulfill({ status: 401, json: { error: "unauthorized" } }),
  );
  await mockMe(page, withEmail("none", null));
  await emailRow(page).getByRole("button", { name: "Use iMessage only" }).click();
  await expect(page.getByText("This link has expired.")).toBeVisible();
});

test("/me before START: still gives text-first email instructions without an onboarding button", async ({
  page,
}) => {
  await mockMe(page, withEmail("none", null, { opted_in: false }));
  await expect(emailRow(page)).toContainText(instruction);
  await expect(emailRow(page).getByRole("button", { name: "Use iMessage only" })).toBeVisible();
});

test("/me pending: Remove asks first; Keep it backs out, Remove email removes", async ({ page }) => {
  const posts = await mockMe(page, withEmail("pending"), { json: withEmail("none", null) });
  const row = emailRow(page);
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row.getByText("Stop sending tasks to this email? Texts keep coming.")).toBeVisible();
  await expect(row.getByRole("button", { name: "Remove email" })).toBeFocused();
  await row.getByRole("button", { name: "Keep it" }).click();
  await expect(row.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  expect(posts).toEqual([]);
  await row.getByRole("button", { name: "Remove" }).click();
  await row.getByRole("button", { name: "Remove email" }).click();
  await expect(emailRow(page)).toContainText("Get tasks by email too");
  await expect(emailRow(page)).toContainText(instruction);
  await expect(page.locator("#title")).toBeFocused();
  expect(posts).toEqual([{ body: { email: null }, auth: `Bearer ${code}` }]);
});

test("/me verified: keeps the masked address and Remove, with text-first instructions instead of Change", async ({
  page,
}) => {
  await mockMe(page, withEmail("verified"));
  const row = emailRow(page);
  await expect(row).toHaveClass(/ui-check--pass/);
  await expect(row).toContainText(`Tasks also go to ${MASKED}.`);
  await expect(row).toContainText(instruction);
  await expect(row.getByRole("button", { name: "Remove" })).toBeVisible();
});

test("/me: an expired code on save shows the expired page", async ({ page }) => {
  await mockMe(page, withEmail("verified"), { status: 401, json: { error: "unauthorized" } });
  await emailRow(page).getByRole("button", { name: "Remove" }).click();
  await emailRow(page).getByRole("button", { name: "Remove email" }).click();
  await expect(page.getByText("This link has expired.")).toBeVisible();
});

test("/login sends a link for any email and says to check the inbox", async ({ page }) => {
  const asks: object[] = [];
  await page.route("**/api/w/login/email", (route) => {
    const body = route.request().postDataJSON();
    if (!body.email) return route.fulfill({ status: 400, json: { error: "invalid_input" } });
    asks.push(body);
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/login.html");
  const email = page.getByRole("textbox", { name: "Email" });
  await email.fill("ada@");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("That email does not look right.")).toBeVisible();
  await email.fill("ada@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("Check your inbox.")).toBeVisible();
  await expect(page.getByText("If that email is on an Eyes account, we sent a sign-in link.")).toBeVisible();
  expect(asks).toEqual([{ email: "ada@example.com" }]);
  await page.getByRole("button", { name: "Use a different email" }).click();
  await expect(email).toBeFocused();
  await expect(email).toHaveValue("");
});

test("/login shows the texted-link path while the API has no email sign-in", async ({ page }) => {
  await page.route("**/api/w/login/email", (route) => route.fulfill({ status: 404, json: {} }));
  await page.goto("/login.html");
  await expect(page.getByText("Open your Eyes page with the link Eyes texts you.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Text HELP for a new link" })).toHaveAttribute(
    "href",
    "sms:+14155550100?&body=HELP",
  );
  await expect(page.getByRole("textbox", { name: "Email" })).toBeHidden();
});

test("/login#c= trades the code for the /me code and opens /me with it, never in a URL sent to a server", async ({
  page,
}) => {
  const trades: object[] = [];
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  await page.route("**/api/w/login/code", (route) => {
    trades.push(route.request().postDataJSON());
    return route.fulfill({ json: { token: code } });
  });
  await page.route("**/api/w/me", (route) => route.fulfill({ json: withEmail("verified") }));
  await page.route("**/api/w/me/tasks?*", (route) =>
    route.fulfill({ json: { paid_usd: 0, pending_usd: 0, tasks: [], next_cursor: null } }),
  );
  await page.goto(`/login.html#c=${loginCode}`);
  await expect(page.getByRole("heading", { name: "You're set up" })).toBeVisible();
  expect(trades).toEqual([{ code: loginCode }]);
  expect(new URL(page.url()).pathname).toBe("/me.html");
  expect(new URL(page.url()).hash).toBe("");
  expect(urls.filter((u) => u.includes(loginCode) || u.includes(code))).toEqual([]);
  await expect(emailRow(page)).toContainText(`Tasks also go to ${MASKED}.`);
});

test("/login#c= with a used or expired code says so and offers a new link", async ({ page }) => {
  await page.route("**/api/w/login/code", (route) =>
    route.fulfill({ status: 401, json: { error: "unauthorized" } }),
  );
  await page.goto(`/login.html#c=${loginCode}`);
  await expect(page.getByText("This link expired or was used. Request a new one.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
});

test("/login#c= on a rate limit shows the API's words, not the expired notice", async ({ page }) => {
  await page.route("**/api/w/login/code", (route) =>
    route.fulfill({ status: 429, json: { error: "rate_limited" } }),
  );
  await page.goto(`/login.html#c=${loginCode}`);
  await expect(page.getByRole("alert")).toContainText("Too many");
  await expect(page.getByText("This link expired or was used.")).toBeHidden();
});
