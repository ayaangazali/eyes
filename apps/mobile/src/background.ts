import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import { type Last, onFix } from "./eyes.ts";

export const TASK = "eyes-location";
// Readable while the phone is locked, so background wakes can send.
const KEY = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

export const getCode = () => SecureStore.getItemAsync("code", KEY);
// A new code starts clean: no old result, no throttle from the previous code, not paused.
export async function saveCode(code: string) {
  await SecureStore.setItemAsync("code", code, KEY);
  await SecureStore.deleteItemAsync("last", KEY);
  await SecureStore.deleteItemAsync("paused", KEY);
}
export const isPaused = async () => (await SecureStore.getItemAsync("paused", KEY)) === "1";
// "Stop sharing" in the app: stays off across launches until "Share again" or a new link.
export async function pause(on: boolean) {
  if (on) {
    await SecureStore.setItemAsync("paused", "1", KEY);
    await stopSharing();
  } else await SecureStore.deleteItemAsync("paused", KEY);
}
export async function getLast(): Promise<Last | null> {
  return JSON.parse((await SecureStore.getItemAsync("last", KEY)) ?? "null");
}

export async function startSharing() {
  await Location.startLocationUpdatesAsync(TASK, {
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: 300,
    timeInterval: 5 * 60_000,
    deferredUpdatesInterval: 5 * 60_000,
    pausesUpdatesAutomatically: true,
    activityType: Location.ActivityType.Other,
    showsBackgroundLocationIndicator: false,
  });
}

export async function stopSharing() {
  if (await Location.hasStartedLocationUpdatesAsync(TASK)) await Location.stopLocationUpdatesAsync(TASK);
}

export async function removeCode() {
  await stopSharing();
  await SecureStore.deleteItemAsync("code", KEY);
}

// The task and the foreground send share this JS runtime; onFix skips a send while one is in flight.
export function report(loc: Location.LocationObject) {
  const { latitude: lat, longitude: lng, accuracy } = loc.coords;
  return onFix(
    { lat, lng, accuracy_m: accuracy ?? undefined, captured_at: new Date(loc.timestamp).toISOString() },
    {
      load: async () => ({ code: await getCode(), last: await getLast() }),
      save: (last) => SecureStore.setItemAsync("last", JSON.stringify(last), KEY),
      stop: removeCode,
    },
  );
}

// Must run at module top level: iOS relaunches the JS bundle in the background for this task.
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(TASK, async ({ data, error }) => {
  const loc = data?.locations.at(-1);
  if (!error && loc) await report(loc);
});
