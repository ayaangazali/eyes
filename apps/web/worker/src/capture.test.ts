import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCATION_HELP } from "./api.ts";

// capture.ts has no exports and runs on load, so each test loads a fresh copy against a plain
// fake page, then checks the elements it writes to.

const CLOSED_EXPIRED = "This task expired. Watch for the next task text.";
const CLOSED_DISPATCHED = "Reply YES to the Eyes text to claim this task, then open this link again.";

interface El {
  tagName: string;
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  className: string;
  innerHTML: string;
  listeners: Record<string, (event: unknown) => unknown>;
  addEventListener: ReturnType<typeof vi.fn>;
  replaceChildren: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
}

function makeEl(tagName = ""): El {
  const el: El = {
    tagName,
    hidden: false,
    disabled: false,
    textContent: "",
    className: "",
    innerHTML: "",
    listeners: {},
    addEventListener: vi.fn((type: string, fn: (event: unknown) => unknown) => {
      el.listeners[type] = fn;
    }),
    replaceChildren: vi.fn(),
    append: vi.fn(),
    focus: vi.fn(),
  };
  return el;
}

let els = new Map<string, El>();
let fetchMock: ReturnType<typeof vi.fn>;
let geo: { watchPosition: ReturnType<typeof vi.fn>; clearWatch: ReturnType<typeof vi.fn> };

function byId(id: string): El {
  let el = els.get(id);
  if (!el) {
    el = makeEl();
    els.set(id, el);
  }
  return el;
}

// Stands in for FormData: capture.ts only calls get() and set().
class FakeFormData {
  private values = new Map<string, unknown>();
  get(key: string) {
    return this.values.get(key) ?? null;
  }
  set(key: string, value: unknown) {
    this.values.set(key, value);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeOffer(overrides: Record<string, unknown> = {}) {
  return {
    question: "Is the shop open?",
    task_type: "is_open",
    bounty_usd: 2,
    place_label: "Market St",
    lat: 37.77,
    lng: -122.42,
    status: "claimed",
    claimed_by_you: true,
    require_photo: false,
    deadline_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    ...overrides,
  };
}

const RESULT = {
  status: "paid",
  message: "Verified. Photo checks pass.",
  verification: { gps_ok: true, fresh_ok: true, vision_ok: true, vision_reason: "Looks safe." },
};

interface Setup {
  search?: string;
  offer?: Record<string, unknown>;
  result?: unknown;
  camera?: unknown;
}

// Loads capture.ts on a fake page. main() runs on load, so callers wait for what they check.
async function load({ search = "?t=tok", offer = makeOffer(), result = RESULT, camera }: Setup = {}) {
  els = new Map();
  geo = { watchPosition: vi.fn(() => 7), clearWatch: vi.fn() };
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "POST" ? json(result) : json(offer),
  );
  vi.stubGlobal("document", { getElementById: byId, createElement: (tag: string) => makeEl(tag) });
  vi.stubGlobal("FormData", FakeFormData);
  vi.stubGlobal("location", { search });
  vi.stubGlobal("navigator", { geolocation: geo, mediaDevices: camera });
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  await import("./capture.ts");
}

// Resolves once locate() has started watching GPS. Returns [onFix, onError, options].
async function waitForWatch() {
  await vi.waitFor(() => expect(geo.watchPosition).toHaveBeenCalled());
  return geo.watchPosition.mock.calls[0] ?? [];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("capture page", () => {
  it("says the link is incomplete when the URL has no task token", async () => {
    await load({ search: "" });
    await vi.waitFor(() => expect(byId("question").textContent).toBe("We could not open this task"));
    expect(byId("error").hidden).toBe(false);
  });

  it("closes the task once its deadline has passed", async () => {
    await load({ offer: makeOffer({ deadline_at: new Date(Date.now() - 1_000).toISOString() }) });
    await vi.waitFor(() => expect(byId("closed").hidden).toBe(false));
    expect(byId("closed").textContent).toBe(CLOSED_EXPIRED);
    expect(byId("capture").hidden).toBe(true);
  });

  it("tells the worker to claim the task first when it is not claimed by them", async () => {
    await load({ offer: makeOffer({ status: "dispatched", claimed_by_you: false }) });
    await vi.waitFor(() => expect(byId("closed").hidden).toBe(false));
    expect(byId("closed").textContent).toBe(CLOSED_DISPATCHED);
  });

  it("accepts a GPS fix within 50 m and enables sending", async () => {
    await load();
    const [onFix] = await waitForWatch();
    onFix({ coords: { latitude: 37.77, longitude: -122.42, accuracy: 12.4 } });
    expect(byId("gps").textContent).toBe("GPS within 12 m. You are 0 m from the place.");
    expect(byId("send").disabled).toBe(false);
    expect(geo.clearWatch).toHaveBeenCalledWith(7);
  });

  it("explains how to allow location when permission is denied", async () => {
    await load();
    const [, onError] = await waitForWatch();
    onError({ code: 1, PERMISSION_DENIED: 1 });
    expect(byId("relocate").hidden).toBe(false);
    expect(byId("send").disabled).toBe(true);
    expect(byId("error").replaceChildren.mock.calls.at(-1)).toContain(LOCATION_HELP);
  });

  it.each([
    ["paid", "Verified", "Verified. Photo checks pass.", "Photo checks pass."],
    [
      "needs_review",
      "Sent, needs a quick review",
      "Left for a person to check.",
      "Left for a person to check.",
    ],
  ])(
    "shows the %s result and drops the title from the message when it repeats it",
    async (status, title, message, shown) => {
      await load({ result: { ...RESULT, status, message } });
      const [onFix] = await waitForWatch();
      onFix({ coords: { latitude: 37.77, longitude: -122.42, accuracy: 12.4 } });
      await byId("capture").listeners.submit?.({ preventDefault: vi.fn() });
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toMatch(/\/w\/offers\/tok\/capture$/);
      expect(byId("outcome").textContent).toBe(title);
      expect(byId("message").textContent).toBe(shown);
      expect(byId("reason").textContent).toBe("Looks safe.");
      expect(byId("result").hidden).toBe(false);
    },
  );

  it("explains the camera block and offers the phone camera fallback", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    await load({ camera: { getUserMedia: vi.fn(() => Promise.reject(denied)) } });
    await vi.waitFor(() => expect(byId("fallback").hidden).toBe(false));
    expect(byId("why").textContent).toContain("Camera access is blocked");
  });
});
