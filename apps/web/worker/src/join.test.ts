import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCATION_HELP } from "./api.ts";

// No DOM library is installed. join.ts touches the page at import, so each test loads a fresh
// copy of the module against a plain fake document, then calls the handlers it registered.

interface El {
  tagName: string;
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  attrs: Record<string, string>;
  listeners: Record<string, (event: unknown) => unknown>;
  setAttribute: ReturnType<typeof vi.fn>;
  removeAttribute: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  replaceChildren: ReturnType<typeof vi.fn>;
  querySelectorAll: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  firstElementChild: { prepend: ReturnType<typeof vi.fn> };
}

function makeEl(tagName = ""): El {
  const el: El = {
    tagName,
    hidden: false,
    disabled: false,
    textContent: "",
    attrs: {},
    listeners: {},
    setAttribute: vi.fn((name: string, value: string) => {
      el.attrs[name] = value;
    }),
    removeAttribute: vi.fn((name: string) => {
      delete el.attrs[name];
    }),
    focus: vi.fn(),
    replaceChildren: vi.fn(),
    querySelectorAll: vi.fn(() => []),
    addEventListener: vi.fn((type: string, fn: (event: unknown) => unknown) => {
      el.listeners[type] = fn;
    }),
    firstElementChild: { prepend: vi.fn() },
  };
  return el;
}

let els = new Map<string, El>();
let fields: Record<string, string> = {};
let geo: { getCurrentPosition: ReturnType<typeof vi.fn> };
let fetchMock: ReturnType<typeof vi.fn>;

function byId(id: string): El {
  let found = els.get(id);
  if (!found) {
    found = makeEl();
    els.set(id, found);
  }
  return found;
}

async function loadJoin() {
  els = new Map();
  fields = {};
  geo = { getCurrentPosition: vi.fn() };
  fetchMock = vi.fn();
  vi.stubGlobal("document", {
    getElementById: byId,
    createElement: (tag: string) => makeEl(tag),
  });
  vi.stubGlobal(
    "FormData",
    class {
      get(key: string) {
        return fields[key] ?? null;
      }
    },
  );
  vi.stubGlobal("navigator", { geolocation: geo });
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  await import("./join.ts");
}

function fire(id: string, type: string, event: unknown = {}) {
  const handler = byId(id).listeners[type];
  if (!handler) throw new Error(`no ${type} handler on ${id}`);
  return handler(event);
}

function submitForm(name: string, phone: string) {
  fields = { name, phone };
  return fire("join", "submit", { preventDefault: vi.fn() });
}

// [headline, fix] of the last message shown in the error box.
function shown(): [string, string] {
  const [strong, , fix] = byId("error").replaceChildren.mock.calls.at(-1) ?? [];
  return [strong?.textContent, fix];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function gpsOk(accuracy = 12.4) {
  geo.getCurrentPosition.mockImplementation((ok: (pos: unknown) => void) =>
    ok({ coords: { latitude: 37.77, longitude: -122.42, accuracy } }),
  );
}

function gpsFail(code: number) {
  geo.getCurrentPosition.mockImplementation((_ok: unknown, fail: (err: unknown) => void) =>
    fail({ code, PERMISSION_DENIED: 1 }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("toE164", () => {
  let toE164: (input: string) => string | null;

  beforeAll(async () => {
    await loadJoin();
    ({ toE164 } = await import("./join.ts"));
  });

  const cases: [string, string | null][] = [
    ["(415) 555-0123", "+14155550123"],
    ["415.555.0123", "+14155550123"],
    ["1 (415) 555-0123", "+14155550123"],
    ["+1 415 555 0123", "+14155550123"],
    ["  +44 20 7946 0958 ", "+442079460958"],
    ["(012) 555-0123", null], // US area codes cannot start with 0 or 1
    ["555-0123", null], // seven digits, no area code
    ["+0 123", null],
    ["", null],
    ["call me", null],
  ];

  it.each(cases)("toE164(%j) is %j", (input, expected) => {
    expect(toE164(input)).toBe(expected);
  });
});

describe("join form", () => {
  beforeEach(async () => {
    await loadJoin();
  });

  it("marks a one-letter name and says why", async () => {
    await submitForm("A", "(415) 555-0123");
    expect(byId("name").attrs).toEqual({ "aria-invalid": "true", "aria-describedby": "error" });
    expect(byId("name").focus).toHaveBeenCalled();
    expect(byId("error").hidden).toBe(false);
    expect(shown()).toEqual(["Please enter your name.", "Use at least 2 letters."]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a phone number that is not valid", async () => {
    await submitForm("Ada", "(012) 555-0123");
    expect(byId("phone").attrs["aria-invalid"]).toBe("true");
    expect(shown()).toEqual([
      "That phone number does not look right.",
      "Enter a US mobile number like (415) 555-0123, or start with + and your country code.",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for a location before sending", async () => {
    await submitForm("Ada", "(415) 555-0123");
    expect(byId("locate").attrs["aria-invalid"]).toBe("true");
    expect(shown()).toEqual([
      "We need your location to send you nearby tasks.",
      "Tap the location button and allow access.",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the GPS fix and reports its accuracy in whole metres", async () => {
    gpsOk(12.4);
    await fire("locate", "click");
    expect(byId("where").textContent).toBe("Location set (within 12 m).");
  });

  it("explains the permission path when location is denied", async () => {
    gpsFail(1);
    await fire("locate", "click");
    expect(byId("where").textContent).toBe("");
    expect(byId("locate").textContent).toBe("Try location again");
    expect(shown()).toEqual(["We could not get your location.", LOCATION_HELP]);
  });

  it("suggests moving near a window when the fix is unavailable", async () => {
    gpsFail(2);
    await fire("locate", "click");
    expect(shown()[1]).toBe("Move near a window or step outside, then tap Try location again.");
  });

  it("clears the marks from the last attempt before checking again", async () => {
    await submitForm("A", "(415) 555-0123");
    const name = byId("name");
    expect(name.attrs["aria-invalid"]).toBe("true");
    byId("join").querySelectorAll.mockReturnValueOnce([name]);
    await submitForm("Ada", "(012) 555-0123");
    expect(name.removeAttribute).toHaveBeenCalledWith("aria-invalid");
    expect(name.removeAttribute).toHaveBeenCalledWith("aria-describedby");
    expect(name.attrs).toEqual({});
    expect(byId("phone").attrs["aria-invalid"]).toBe("true");
    expect(shown()[0]).toBe("That phone number does not look right.");
  });

  it("posts name, phone and location, then shows the text-to-start step", async () => {
    gpsOk();
    fetchMock.mockResolvedValue(json({ inkbox_number: "+14155550199" }));
    await fire("locate", "click");
    await submitForm("Ada Lovelace", "(415) 555-0123");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url).endsWith("/w/join")).toBe(true);
    expect(JSON.parse(init.body)).toEqual({
      name: "Ada Lovelace",
      phone: "+14155550123",
      lat: 37.77,
      lng: -122.42,
    });
    expect(byId("join").hidden).toBe(true);
    expect(byId("start").hidden).toBe(false);
    expect(byId("done").hidden).toBe(false);
    expect(byId("submit").disabled).toBe(false);
  });

  it("falls back to the configured Inkbox number when the server does not return one", async () => {
    vi.stubEnv("VITE_INKBOX_NUMBER", "+14155550100");
    await loadJoin();
    gpsOk();
    fetchMock.mockResolvedValue(json({}));
    await fire("locate", "click");
    await submitForm("Ada Lovelace", "(415) 555-0123");
    const [link] = byId("start").firstElementChild.prepend.mock.calls[0] ?? [];
    expect(link).toMatchObject({
      href: "sms:+14155550100?&body=START",
      textContent: "Text START to +14155550100",
    });
    expect(byId("closed").hidden).toBe(true);
  });

  it("offers the connect command first, then START, when a connect command is configured", async () => {
    vi.stubEnv("VITE_INKBOX_CONNECT", "JOIN eyes");
    await loadJoin();
    gpsOk();
    fetchMock.mockResolvedValue(json({ inkbox_number: "+14155550199" }));
    await fire("locate", "click");
    await submitForm("Ada Lovelace", "(415) 555-0123");
    const [first, second] = byId("start").firstElementChild.prepend.mock.calls[0] ?? [];
    expect(first).toMatchObject({
      href: "sms:+14155550199?&body=JOIN%20eyes",
      textContent: 'First text "JOIN eyes" to +14155550199',
    });
    expect(second).toMatchObject({
      href: "sms:+14155550199?&body=START",
      textContent: "Then text START to +14155550199",
    });
  });

  it("shows the rate-limit words and re-enables the button when the join fails", async () => {
    gpsOk();
    fetchMock.mockResolvedValue(json({ error: "rate_limited" }, 429));
    await fire("locate", "click");
    // join.ts hides the form when no Inkbox number is configured; show it so the failure path is checked.
    byId("join").hidden = false;
    await submitForm("Ada Lovelace", "(415) 555-0123");
    expect(byId("error").hidden).toBe(false);
    expect(shown()).toEqual([
      "Too many sign-ups from this network right now.",
      "Wait up to an hour, then try again.",
    ]);
    expect(byId("join").hidden).toBe(false);
    expect(byId("submit").disabled).toBe(false);
  });
});
