import { Problem } from "./api.ts";

// Served by the API (no redirect): iOS reads it for the itms-services install.
export const DEFAULT_MANIFEST_URL = "https://api.eyes.pictures/w/app/manifest.plist";

export type DeviceStatus = { profile_url: string; registered: boolean; ready: boolean };

/** What the page shows: a notice (not-iphone, missing, expired, error) or the steps at one current step. */
export type InstallStep =
  | "not-iphone"
  | "missing"
  | "register"
  | "waiting"
  | "install"
  | "installed"
  | "expired"
  | "error";

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
};

/** The location code from the URL fragment, or null when it is missing or malformed. */
export function readCode(hash: string): string | null {
  const code = new URLSearchParams(hash.slice(1)).get("c") ?? "";
  return /^[\w-]{20,200}$/.test(code) ? code : null;
}

/**
 * The code survives the trip through Settings (the profile redirect drops the fragment) and the restart
 * for Developer Mode, on this iPhone only: localStorage, 24 hours, removed once Eyes opens with it.
 * It is only ever sent as the Bearer header of /w/device.
 */
export const SAVED_KEY = "eyes-install";
const SAVED_MS = 24 * 3_600_000;
export type Saved = { code: string; savedAt: number; installed?: boolean };

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

/** Tapped "Install Eyes": the next visit starts at Developer Mode. */
export function markInstalled(store: Store, now: number) {
  const saved = loadSaved(store, now);
  if (saved) store.setItem(SAVED_KEY, JSON.stringify({ ...saved, installed: true }));
}

/** Eyes opened with the code (the page went hidden after "Open Eyes"): the app has it now. */
export const forgetCode = (store: Store) => store.removeItem(SAVED_KEY);

/** Link that makes iOS install the ad hoc build described by the manifest. */
export const itmsUrl = (manifest = import.meta.env.VITE_ADHOC_MANIFEST_URL || DEFAULT_MANIFEST_URL) =>
  `itms-services://?action=download-manifest&url=${encodeURIComponent(manifest)}`;

/** iOS lands on `?registered=1` after the profile, so that also proves this iPhone is registered. */
export function deviceStep(
  status: DeviceStatus,
  registeredParam: boolean,
  installed = false,
): "register" | "waiting" | "install" | "installed" {
  if (status.ready) return installed ? "installed" : "install";
  return status.registered || registeredParam ? "waiting" : "register";
}

/**
 * Wires the install page. The code arrives in the URL fragment (never sent to a server), goes only into the
 * Authorization header, and is cleared from the address bar. Resolves to the step shown.
 */
export async function startInstall(d: InstallDeps, manifest?: string): Promise<InstallStep> {
  const fresh = readCode(d.hash);
  if (d.hash) d.replaceUrl(d.pathname + d.search);
  let saved = loadSaved(d.store, d.now);
  if (fresh && fresh !== saved?.code) {
    saved = { code: fresh, savedAt: d.now };
    d.store.setItem(SAVED_KEY, JSON.stringify(saved));
  }
  const code = saved?.code ?? null;
  const registered = new URLSearchParams(d.search).get("registered") === "1";
  let step: InstallStep;
  if (!d.userAgent.includes("iPhone")) step = "not-iphone";
  else if (code === null) step = registered ? "waiting" : "missing";
  else {
    try {
      const status = (await d.send("/w/device", {
        method: "POST",
        headers: { Authorization: `Bearer ${code}` },
      })) as DeviceStatus;
      step = deviceStep(status, registered, saved?.installed);
      d.setHref("open", `eyes://connect#c=${code}`);
      if (step === "register") d.setHref("profile", status.profile_url);
      if (step === "install" || step === "installed") d.setHref("itms", itmsUrl(manifest));
    } catch (err) {
      step = err instanceof Problem && err.status === 401 ? "expired" : "error";
      if (step === "expired") forgetCode(d.store);
      if (step === "error") d.report(err);
    }
  }
  d.show(step);
  return step;
}
