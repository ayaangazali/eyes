import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import { type Last, onFix } from "./eyes.ts";

export const TASK = "eyes-location";
// Readable while the phone is locked, so background wakes can send.
const KEY = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

export const getCode = () => SecureStore.getItemAsync("code", KEY);
export const saveCode = (code: string) => SecureStore.setItemAsync("code", code, KEY);
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

export async function report(loc: Location.LocationObject, force = false) {
  const { latitude: lat, longitude: lng, accuracy } = loc.coords;
  return onFix(
    { lat, lng, accuracy_m: accuracy ?? undefined, captured_at: new Date(loc.timestamp).toISOString() },
    {
      code: await getCode(),
      last: await getLast(),
      save: (last) => SecureStore.setItemAsync("last", JSON.stringify(last), KEY),
      stop: removeCode,
    },
    force,
  );
}

// Must run at module top level: iOS relaunches the JS bundle in the background for this task.
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(TASK, async ({ data, error }) => {
  const loc = data?.locations.at(-1);
  if (!error && loc) await report(loc);
});
