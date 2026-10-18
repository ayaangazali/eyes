import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as bg from "./background.ts";

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  tasks: new Map<string, (arg: unknown) => Promise<void>>(),
}));

vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK: "after-first-unlock",
  getItemAsync: vi.fn(async (key: string) => h.store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => void h.store.set(key, value)),
  deleteItemAsync: vi.fn(async (key: string) => void h.store.delete(key)),
}));
vi.mock("expo-location", () => ({
  Accuracy: { Balanced: 3 },
  ActivityType: { Other: 9 },
  startLocationUpdatesAsync: vi.fn(async () => undefined),
  stopLocationUpdatesAsync: vi.fn(async () => undefined),
  hasStartedLocationUpdatesAsync: vi.fn(async () => false),
}));
vi.mock("expo-task-manager", () => ({
  defineTask: vi.fn((name: string, fn: (arg: unknown) => Promise<void>) => void h.tasks.set(name, fn)),
}));

const CODE = `${"B".repeat(40)}-_9`;
const API_LOCATION = "https://api.eyes.pictures/w/location";

const fix = (lat: number, lng: number, accuracy: number | null = 12, timestamp = 1_700_000_000_000) =>
  ({ coords: { latitude: lat, longitude: lng, accuracy }, timestamp }) as unknown as Location.LocationObject;

let fetchMock: ReturnType<typeof vi.fn>;
const sentBodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init.body)));

beforeEach(() => {
  h.store.clear();
  vi.clearAllMocks();
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("secure storage", () => {
  it("reads and writes the code with the first-unlock accessibility class", async () => {
    await bg.saveCode(CODE);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("code", CODE, {
      keychainAccessible: "after-first-unlock",
    });
    expect(await bg.getCode()).toBe(CODE);
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith("code", {
      keychainAccessible: "after-first-unlock",
    });
  });

  it("saveCode drops the previous result so a new code starts clean", async () => {
    h.store.set("last", JSON.stringify({ at: 1, result: "sent", lat: 1, lng: 2 }));
    await bg.saveCode(CODE);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("last", {
      keychainAccessible: "after-first-unlock",
    });
    expect(h.store.has("last")).toBe(false);
  });

  it("getLast returns null when nothing is stored, else the parsed result", async () => {
    expect(await bg.getLast()).toBeNull();
    const last = { at: 5, result: "failed" as const, lat: 37.76, lng: -122.39 };
    h.store.set("last", JSON.stringify(last));
    expect(await bg.getLast()).toEqual(last);
  });

  it("getCode is null when no code is stored", async () => {
    expect(await bg.getCode()).toBeNull();
  });
});

describe("sharing lifecycle", () => {
  it("startSharing requests balanced background updates on the task", async () => {
    await bg.startSharing();
    expect(Location.startLocationUpdatesAsync).toHaveBeenCalledWith(bg.TASK, {
      accuracy: 3,
      distanceInterval: 300,
      timeInterval: 300_000,
      deferredUpdatesInterval: 300_000,
      pausesUpdatesAutomatically: true,
      activityType: 9,
      showsBackgroundLocationIndicator: false,
    });
  });

  it("stopSharing stops updates only when they were started", async () => {
    await bg.stopSharing();
    expect(Location.stopLocationUpdatesAsync).not.toHaveBeenCalled();

    vi.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValueOnce(true);
    await bg.stopSharing();
    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(bg.TASK);
  });

  it("removeCode stops sharing and deletes the stored code", async () => {
    h.store.set("code", CODE);
    vi.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValueOnce(true);
    await bg.removeCode();
    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(bg.TASK);
    expect(h.store.has("code")).toBe(false);
  });
});

describe("pause", () => {
  it("Stop sharing persists and stops updates; Share again or a new code clears it", async () => {
    vi.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValueOnce(true);
    expect(await bg.isPaused()).toBe(false);
    await bg.pause(true);
    expect(await bg.isPaused()).toBe(true);
    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(bg.TASK);
    await bg.pause(false);
    expect(await bg.isPaused()).toBe(false);
    await bg.pause(true);
    await bg.saveCode(CODE);
    expect(await bg.isPaused()).toBe(false);
  });
});

describe("report", () => {
  it("sends the fix with rounded-to-stored coordinates and the capture time", async () => {
    h.store.set("code", CODE);
    const out = await bg.report(fix(37.7607, -122.3857, 12, 1_700_000_000_000));
    expect(sentBodies()).toEqual([
      {
        lat: 37.7607,
        lng: -122.3857,
        accuracy_m: 12,
        captured_at: "2023-11-14T22:13:20.000Z",
        source: "app",
      },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(API_LOCATION);
    expect(out).toMatchObject({ result: "sent", lat: 37.76, lng: -122.39 });
    expect(JSON.parse(h.store.get("last") ?? "null")).toMatchObject({ result: "sent", lat: 37.76 });
  });

  it("omits accuracy when the platform reports none", async () => {
    h.store.set("code", CODE);
    await bg.report(fix(1, 2, null));
    expect(sentBodies()[0]).not.toHaveProperty("accuracy_m");
  });

  it("removes the code and sends nothing when no code is stored", async () => {
    vi.mocked(Location.hasStartedLocationUpdatesAsync).mockResolvedValueOnce(true);
    const out = await bg.report(fix(1, 2));
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith(bg.TASK);
  });
});

describe("background task", () => {
  const run = (arg: unknown) => h.tasks.get(bg.TASK)?.(arg);

  it("registers the location task under TASK at module load", () => {
    expect(h.tasks.has(bg.TASK)).toBe(true);
  });

  it("reports the most recent location in the batch", async () => {
    h.store.set("code", CODE);
    await run({
      data: { locations: [fix(1, 1, 5, 1_700_000_000_000), fix(2, 2, 5, 1_700_000_060_000)] },
      error: null,
    });
    expect(sentBodies()).toHaveLength(1);
    expect(sentBodies()[0]).toMatchObject({ lat: 2, lng: 2 });
  });

  it("does nothing on a task error", async () => {
    h.store.set("code", CODE);
    await run({ data: { locations: [fix(1, 1)] }, error: new Error("denied") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the batch is empty or data is missing", async () => {
    h.store.set("code", CODE);
    await run({ data: { locations: [] }, error: null });
    await run({ data: undefined, error: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
