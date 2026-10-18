import { describe, expect, it, vi } from "vitest";
import { LOCATION_HELP, Problem } from "./api.ts";
import {
  currentPosition,
  type HereDeps,
  type HereElements,
  locationProblem,
  serverProblem,
  wireHere,
} from "./here.ts";

const TIME = 1_760_000_000_000;
const pos = {
  coords: { latitude: 40.71284, longitude: -74.00601, accuracy: 12.5 },
  timestamp: TIME,
} as unknown as GeolocationPosition;

const okGeo = () => ({ getCurrentPosition: (ok: PositionCallback) => ok(pos) });
const failGeo = (code: number) => ({
  getCurrentPosition: (_ok: PositionCallback, fail?: PositionErrorCallback | null) =>
    fail?.({ code, PERMISSION_DENIED: 1 } as GeolocationPositionError),
});

function harness(o: Partial<HereDeps> = {}) {
  const button = { disabled: false, addEventListener: vi.fn() };
  const done = { hidden: true, textContent: "" };
  const error = { hidden: true, textContent: "" };
  const ready = { hidden: false };
  const missing = { hidden: true };
  const send = o.send ? vi.fn(o.send) : vi.fn(async (_path: string, _init: RequestInit) => ({}) as unknown);
  const report = o.report ? vi.fn(o.report) : vi.fn((_el: HTMLElement, _err: unknown) => {});
  wireHere({ button, done, error, ready, missing } as unknown as HereElements, {
    token: o.token ?? "tok",
    geolocation: "geolocation" in o ? o.geolocation : okGeo(),
    send,
    report,
  });
  const listener = button.addEventListener.mock.calls[0]?.[1] as () => Promise<void>;
  const click = () => listener();
  return { button, done, error, ready, missing, send, report, click };
}

describe("currentPosition", () => {
  it("asks for a high-accuracy fix with a 20 second timeout and resolves with the fix", async () => {
    const getCurrentPosition = vi.fn(
      (ok: PositionCallback, _fail?: PositionErrorCallback | null, _opts?: unknown) => ok(pos),
    );
    await expect(currentPosition({ getCurrentPosition })).resolves.toBe(pos);
    expect(getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      enableHighAccuracy: true,
      timeout: 20_000,
    });
  });

  it("rejects with the geolocation error", async () => {
    await expect(currentPosition(failGeo(2))).rejects.toMatchObject({ code: 2 });
  });
});

describe("locationProblem", () => {
  it("says location is blocked when permission was denied, with the Safari steps", () => {
    const problem = locationProblem({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError);
    expect(problem).toBeInstanceOf(Problem);
    expect(problem.message).toBe("Location is blocked for this page.");
    expect(problem.fix).toBe(LOCATION_HELP);
  });

  it.each([2, 3])("says the spot could not be found for error code %i", (code) => {
    const problem = locationProblem({ code, PERMISSION_DENIED: 1 } as GeolocationPositionError);
    expect(problem.message).toBe("Could not find your location.");
    expect(problem.fix).toBe("Step outside or near a window, then tap again.");
  });
});

describe("serverProblem", () => {
  it("passes through an error that is not a Problem", () => {
    const err = new Error("boom");
    expect(serverProblem(err)).toBe(err);
  });

  it("passes through a Problem that has no body", () => {
    const err = new Problem("Could not reach Eyes.", "Check your signal, then try again.");
    expect(serverProblem(err)).toBe(err);
  });

  it("passes through a Problem whose body has no message", () => {
    const err = new Problem("Eyes had a problem (HTTP 500).", "Try again.", 500, { fix: "Try later." });
    expect(serverProblem(err)).toBe(err);
  });

  it("swaps in the server's message and fix", () => {
    const err = new Problem("Generic.", "Generic fix.", 409, { message: "Too soon.", fix: "Wait a minute." });
    expect(serverProblem(err)).toMatchObject({ message: "Too soon.", fix: "Wait a minute." });
  });

  it("uses an empty fix when the server sends a message without one", () => {
    const err = new Problem("Generic.", "Generic fix.", 410, { message: "Link expired." });
    const out = serverProblem(err);
    expect(out).toBeInstanceOf(Problem);
    expect(out).toMatchObject({ message: "Link expired.", fix: "" });
  });
});

describe("wireHere", () => {
  it("registers one click handler on the button and keeps the update step showing", () => {
    const { button, ready, missing } = harness();
    expect(button.addEventListener).toHaveBeenCalledWith("click", expect.any(Function));
    expect(ready.hidden).toBe(false);
    expect(missing.hidden).toBe(true);
  });

  it("sends the fix, shows the spot, and re-enables the button", async () => {
    const { button, done, error, send, click } = harness();
    await click();
    expect(send).toHaveBeenCalledWith("/w/location", {
      method: "POST",
      headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
      body: JSON.stringify({
        lat: 40.71284,
        lng: -74.00601,
        accuracy_m: 12.5,
        source: "here_link",
        captured_at: new Date(TIME).toISOString(),
      }),
    });
    expect(done).toMatchObject({
      hidden: false,
      textContent: "Spot updated. Near 40.713, -74.006. You can close this page.",
    });
    expect(error.hidden).toBe(true);
    expect(button.disabled).toBe(false);
  });

  it("disables the button and clears old messages while the request runs", () => {
    const { button, done, error, click } = harness({ send: vi.fn(() => new Promise<unknown>(() => {})) });
    done.hidden = false;
    error.hidden = false;
    void click();
    expect(button.disabled).toBe(true);
    expect(done.hidden).toBe(true);
    expect(error.hidden).toBe(true);
  });

  it("shows only the text-HERE step when the link has no code", () => {
    const { button, ready, missing } = harness({ token: "" });
    expect(ready.hidden).toBe(true);
    expect(missing.hidden).toBe(false);
    expect(button.addEventListener).not.toHaveBeenCalled();
  });

  it("says this browser cannot share location when geolocation is missing", async () => {
    const { error, send, report, click } = harness({ geolocation: undefined });
    await click();
    expect(send).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ message: "This browser cannot share your location.", fix: LOCATION_HELP }),
    );
  });

  it("reports a blocked location with the Safari steps", async () => {
    const { error, send, report, click } = harness({ geolocation: failGeo(1) });
    await click();
    expect(send).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ message: "Location is blocked for this page." }),
    );
  });

  it("reports a failed fix when the position is unavailable", async () => {
    const { error, report, click } = harness({ geolocation: failGeo(2) });
    await click();
    expect(report).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ message: "Could not find your location." }),
    );
  });

  it("shows the server's own words when the spot update is rejected", async () => {
    const send = vi.fn(async () => {
      throw new Problem("Generic.", "Generic fix.", 410, {
        message: "Link expired.",
        fix: "Text HERE for a new link.",
      });
    });
    const { done, error, report, click } = harness({ send });
    await click();
    expect(report).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ message: "Link expired.", fix: "Text HERE for a new link." }),
    );
    expect(done.hidden).toBe(true);
  });

  it("passes a rejection without a server message through unchanged", async () => {
    const err = new Problem("Could not reach Eyes.", "Check your signal, then try again.");
    const send = vi.fn(async () => {
      throw err;
    });
    const { report, click } = harness({ send });
    await click();
    expect(report.mock.calls[0]?.[1]).toBe(err);
  });
});
