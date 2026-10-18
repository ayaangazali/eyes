import { Problem } from "./api.ts";

export const DEFAULT_MANIFEST_URL =
  "https://pagp38bu.us-west.insforge.app/api/storage/buckets/apps/objects/eyes-worker/manifest.plist";

export type DeviceStatus = { profile_url: string; registered: boolean; ready: boolean };

/** Ids of the page sections; exactly one is shown. */
export type InstallStep = "not-iphone" | "missing" | "register" | "waiting" | "install" | "expired" | "error";

export type InstallDeps = {
  hash: string;
  pathname: string;
  search: string;
  userAgent: string;
  replaceUrl: (url: string) => void;
  send: (path: string, init: RequestInit) => Promise<unknown>;
  show: (step: InstallStep) => void;
  setHref: (id: "profile" | "itms", href: string) => void;
  report: (err: unknown) => void;
};

/** The location code from the URL fragment, or null when it is missing or malformed. */
export function readCode(hash: string): string | null {
  const code = new URLSearchParams(hash.slice(1)).get("c") ?? "";
  return /^[\w-]{20,200}$/.test(code) ? code : null;
}

/** Link that makes iOS install the ad hoc build described by the manifest. */
export const itmsUrl = (manifest = import.meta.env.VITE_ADHOC_MANIFEST_URL || DEFAULT_MANIFEST_URL) =>
  `itms-services://?action=download-manifest&url=${encodeURIComponent(manifest)}`;

/** iOS lands on `?registered=1` after the profile, so that also proves this iPhone is registered. */
export function deviceStep(
  status: DeviceStatus,
  registeredParam: boolean,
): "register" | "waiting" | "install" {
  if (status.ready) return "install";
  return status.registered || registeredParam ? "waiting" : "register";
}

/**
 * Wires the install page. The code arrives in the URL fragment (never sent to a server), goes only into the
 * Authorization header, and is cleared from the address bar. Resolves to the step shown.
 */
export async function startInstall(d: InstallDeps, manifest?: string): Promise<InstallStep> {
  const code = readCode(d.hash);
  if (d.hash) d.replaceUrl(d.pathname + d.search);
  const registered = new URLSearchParams(d.search).get("registered") === "1";
  let step: InstallStep;
  if (!d.userAgent.includes("iPhone")) step = "not-iphone";
  // The redirect back from the profile drops the fragment, so a bare ?registered=1 has no code.
  else if (code === null) step = registered ? "waiting" : "missing";
  else {
    try {
      const status = (await d.send("/w/device", {
        method: "POST",
        headers: { Authorization: `Bearer ${code}` },
      })) as DeviceStatus;
      step = deviceStep(status, registered);
      if (step === "register") d.setHref("profile", status.profile_url);
      if (step === "install") d.setHref("itms", itmsUrl(manifest));
    } catch (err) {
      step = err instanceof Problem && err.status === 401 ? "expired" : "error";
      if (step === "error") d.report(err);
    }
  }
  d.show(step);
  return step;
}
