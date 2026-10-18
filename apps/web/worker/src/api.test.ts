import { afterEach, describe, expect, it, vi } from "vitest";
import { call, LOCATION_HELP, Problem, showError, smsHref } from "./api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// call() rejects with a Problem. Return it so the test can check its fields.
async function problemFrom(promise: Promise<unknown>): Promise<Problem> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Problem) return err;
    throw err;
  }
  throw new Error("expected call() to reject");
}

describe("call()", () => {
  it("resolves with the parsed body on 2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ id: "task-1" })),
    );
    await expect(call<{ id: string }>("/v1/offers/abc")).resolves.toEqual({ id: "task-1" });
  });

  it("resolves with null when a 2xx body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    await expect(call("/v1/x")).resolves.toBeNull();
  });

  it("sends the path and init to fetch", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => json({}));
    vi.stubGlobal("fetch", fetchMock);

    await call("/v1/join", { method: "POST", body: "{}" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/v1\/join$/);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: "{}" });
  });

  it.each<[string, string, string]>([
    ["offer_invalid", "This task link is invalid or has expired.", "Open the newest link Eyes texted you."],
    [
      "task_already_claimed",
      "Another worker already claimed this task.",
      "No action needed. Watch for the next task text.",
    ],
    ["invalid_input", "Eyes could not accept that.", "Check what you entered, then try again."],
    ["internal_error", "Something went wrong at Eyes.", "Wait a moment, then try again."],
    ["rate_limited", "Too many sign-ups from this network right now.", "Wait up to an hour, then try again."],
    [
      "not_implemented",
      "Worker sign-up opens soon.",
      "Eyes cannot text tasks yet, so we are not taking sign-ups.",
    ],
  ])("maps error code %s to its words", async (code, message, fix) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: code }, 400)),
    );

    const p = await problemFrom(call("/v1/x"));

    expect(p.message).toBe(message);
    expect(p.fix).toBe(fix);
  });

  it("falls back to the HTTP status for an unmapped error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "made_up" }, 418)),
    );

    const p = await problemFrom(call("/v1/x"));

    expect(p.message).toBe("Eyes had a problem (HTTP 418).");
    expect(p.fix).toBe("Wait a moment, then try again.");
  });

  it("falls back to the HTTP status when an error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { status: 502 })),
    );

    const p = await problemFrom(call("/v1/x"));

    expect(p.message).toBe("Eyes had a problem (HTTP 502).");
    expect(p.fix).toBe("Wait a moment, then try again.");
  });

  it("reports a network failure as 'could not reach Eyes'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const p = await problemFrom(call("/v1/x"));

    expect(p.message).toBe("Could not reach Eyes.");
    expect(p.fix).toBe("Check your signal, then try again.");
  });
});

describe("LOCATION_HELP", () => {
  it("names the retry button and the iPhone permission path", () => {
    expect(LOCATION_HELP).toContain("Try location again");
    expect(LOCATION_HELP).toContain("Website Settings > Location > Allow");
  });
});

describe("LIVE_PAYOUTS", () => {
  it("is on only when VITE_LIVE_PAYOUTS is exactly 'true'", async () => {
    // Dynamic import on purpose: api.ts reads VITE_LIVE_PAYOUTS once at module load, so a static
    // import would evaluate it before stubEnv runs. Each case needs a fresh module instance.
    vi.stubEnv("VITE_LIVE_PAYOUTS", "true");
    vi.resetModules();
    expect((await import("./api.ts")).LIVE_PAYOUTS).toBe(true);

    vi.stubEnv("VITE_LIVE_PAYOUTS", "TRUE");
    vi.resetModules();
    expect((await import("./api.ts")).LIVE_PAYOUTS).toBe(false);
  });
});

describe("showError()", () => {
  // showError only needs createElement; the element is a plain object that records replaceChildren().
  function stubDocument() {
    vi.stubGlobal("document", {
      createElement: (tag: string) => ({ tag, textContent: "" }),
    });
  }

  it("shows the Problem's message in bold, a line break, then the fix, and unhides the box", () => {
    stubDocument();
    const el = { hidden: true, replaceChildren: vi.fn() };

    showError(
      el as unknown as HTMLElement,
      new Problem("Eyes could not accept that.", "Check what you entered."),
    );

    expect(el.hidden).toBe(false);
    const [strong, br, fix] = el.replaceChildren.mock.calls[0] ?? [];
    expect(strong).toEqual({ tag: "strong", textContent: "Eyes could not accept that." });
    expect(br).toEqual({ tag: "br", textContent: "" });
    expect(fix).toBe("Check what you entered.");
  });

  it("shows any other thrown value as its string form with the reload fix", () => {
    stubDocument();
    const el = { hidden: true, replaceChildren: vi.fn() };

    showError(el as unknown as HTMLElement, new Error("boom"));

    const [strong, , fix] = el.replaceChildren.mock.calls[0] ?? [];
    expect(strong).toEqual({ tag: "strong", textContent: "Error: boom" });
    expect(fix).toBe("Reload the page and try again.");
  });
});

describe("smsHref()", () => {
  it("builds an sms: link to the given number with the body encoded", () => {
    expect(smsHref("HELP me", "+14155550100")).toBe("sms:+14155550100?&body=HELP%20me");
  });

  it("returns null when the build has no Eyes number", () => {
    vi.stubEnv("VITE_INKBOX_NUMBER", "");
    expect(smsHref("APP")).toBeNull();
  });
});
