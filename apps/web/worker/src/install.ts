import { Problem } from "./api.ts";

// Served by the API (no redirect): iOS reads it for the itms-services install.
export const DEFAULT_MANIFEST_URL = "https://api.eyes.pictures/w/app/manifest.plist";

export type DeviceStatus = {
  profile_url: string;
  registered: boolean;
  ready: boolean;
  app_connected?: boolean;
};

/**
 * What the page shows: a notice (not-iphone, missing, expired, error), the steps at one current step
 * (register, waiting, install, open), or all steps done: the app connected, or the worker said so.
 */
export type InstallStep =
  | "not-iphone"
  | "missing"
  | "register"
  | "waiting"
  | "install"
  | "open"
  | "connected"
  | "done"
  | "expired"
  | "error";

/** Steps still waiting on the worker: the page keeps asking the server while one of these shows. */
const WAITING: InstallStep[] = ["register", "waiting", "install", "open"];
export const POLL_MS = 5_000;
export const POLL_MAX_MS = 10 * 60_000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type InstallDeps = {
  hash: string;
  pathname: string;
  search: string;
  userAgent: string;
  replaceUrl: (url: string) => void;
  send: (path: string, init: RequestInit) => Promise<unknown>;
  show: (step: InstallStep) => void;
  setHref: (id: "profile" | "itms" | "open", href: string) => void;
  report: (err: unknown) => void;
  store: Store;
  now: number;
  /** Ask the server again every POLL_MS while the page is visible, for up to POLL_MAX_MS. */
  poll?: { sleep: (ms: number) => Promise<void>; visible: () => boolean; clock: () => number };
};

/** The location code from the URL fragment, or null when it is missing or malformed. */
export function readCode(hash: string): string | null {
  const code = new URLSearchParams(hash.slice(1)).get("c") ?? "";
  return /^[\w-]{20,200}$/.test(code) ? code : null;
}

/**
 * The code survives the trip through Settings (the profile redirect drops the fragment) and a restart,
 * on this iPhone only: localStorage, 24 hours, removed once the app connects with it.
 * It is only ever sent as the Bearer header of /w/device. `done` counts the steps the worker finished
 * that the server can't see (Install tapped, "I already did this").
 */
export const SAVED_KEY = "eyes-install";
const SAVED_MS = 24 * 3_600_000;
export type Saved = { code: string; savedAt: number; done?: number };

export function loadSaved(store: Store, now: number): Saved | null {
  let saved: Saved | null | undefined; // undefined: unparsable
  try {
    saved = JSON.parse(store.getItem(SAVED_KEY) ?? "null");
  } catch {}
  if (saved === null) return null;
  if (saved && readCode(`#c=${saved.code}`) && saved.savedAt <= now && now - saved.savedAt < SAVED_MS)
    return saved;
  store.removeItem(SAVED_KEY);
  return null;
}

/** The worker finished the first `done` steps (1 Register, 2 Install, 3 Open Eyes). Never goes back. */
export function markDone(store: Store, now: number, done: number) {
  const saved = loadSaved(store, now);
  if (saved && done > (saved.done ?? 0)) store.setItem(SAVED_KEY, JSON.stringify({ ...saved, done }));
}

/** The app connected with the code: it has it now. */
export const forgetCode = (store: Store) => store.removeItem(SAVED_KEY);

/** Link that makes iOS install the ad hoc build described by the manifest. */
export const itmsUrl = (manifest = import.meta.env.VITE_ADHOC_MANIFEST_URL || DEFAULT_MANIFEST_URL) =>
  `itms-services://?action=download-manifest&url=${encodeURIComponent(manifest)}`;

/**
 * The current step from the server's state and the steps the worker marked done. iOS lands on
 * `?registered=1` after the profile, so that also proves this iPhone is registered. Developer Mode is not a
 * step: a web page can't see it, so it is help inside "Open Eyes".
 */
export function deviceStep(
  status: DeviceStatus,
  registeredParam: boolean,
  done = 0,
): "register" | "waiting" | "install" | "open" | "connected" | "done" {
  if (status.app_connected) return "connected";
  if (done >= 3) return "done";
  if (done >= 2) return "open";
  if (status.ready) return "install";
  return status.registered || registeredParam || done >= 1 ? "waiting" : "register";
}

/** One look at the server with the saved code; shows and resolves to the step. */
export async function checkInstall(d: InstallDeps, manifest?: string): Promise<InstallStep> {
  const saved = loadSaved(d.store, d.now);
  const registered = new URLSearchParams(d.search).get("registered") === "1";
  let step: InstallStep;
  if (!saved) step = registered ? "waiting" : "missing";
  else {
    try {
      const status = (await d.send("/w/device", {
        method: "POST",
        headers: { Authorization: `Bearer ${saved.code}` },
      })) as DeviceStatus;
      step = deviceStep(status, registered, saved.done);
      d.setHref("open", `eyes://connect#c=${saved.code}`);
      if (step === "register") d.setHref("profile", status.profile_url);
      if (status.ready) d.setHref("itms", itmsUrl(manifest));
      if (step === "connected") forgetCode(d.store);
    } catch (err) {
      step = err instanceof Problem && err.status === 401 ? "expired" : "error";
      if (step === "expired") forgetCode(d.store);
      if (step === "error") d.report(err);
    }
  }
  d.show(step);
  return step;
}

/**
 * Wires the install page. The code arrives in the URL fragment (never sent to a server), goes only into the
 * Authorization header, and is cleared from the address bar. With `poll`, it keeps checking until the app
 * connects. Resolves to the last step shown.
 */
export async function startInstall(d: InstallDeps, manifest?: string): Promise<InstallStep> {
  const fresh = readCode(d.hash);
  if (d.hash) d.replaceUrl(d.pathname + d.search);
  const saved = loadSaved(d.store, d.now);
  if (fresh && fresh !== saved?.code)
    d.store.setItem(SAVED_KEY, JSON.stringify({ code: fresh, savedAt: d.now }));
  if (!d.userAgent.includes("iPhone")) {
    d.show("not-iphone");
    return "not-iphone";
  }
  let step = await checkInstall(d, manifest);
  const end = d.now + POLL_MAX_MS;
  while (d.poll && WAITING.includes(step) && d.poll.clock() < end) {
    await d.poll.sleep(POLL_MS);
    if (d.poll.visible()) step = await checkInstall(d, manifest);
  }
  return step;
}
