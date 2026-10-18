// Pure logic: no Expo imports, so the root vitest run covers it.
export const API = "https://api.eyes.pictures/w/location";
export const MIN_GAP_MS = 60_000;

export const isCode = (s: string) => /^[A-Za-z0-9_-]{43}$/.test(s);

export type Fix = { lat: number; lng: number; accuracy_m?: number; captured_at?: string };
export type Result = "sent" | "stopped" | "rate_limited" | "failed";
export type Last = { at: number; result: Result; lat: number; lng: number };

export const MESSAGES: Record<Result, string> = {
  sent: "Sent",
  stopped: "Code stopped working: text AUTO to Eyes for a new one",
  rate_limited: "Too many updates, will retry",
  failed: "Not sent, will retry",
};

export async function postFix(code: string, fix: Fix, fetchFn: typeof fetch = fetch): Promise<Result> {
  let status: number;
  try {
    status = (
      await fetchFn(API, {
        method: "POST",
        headers: { authorization: `Bearer ${code}`, "content-type": "application/json" },
        body: JSON.stringify({ ...fix, source: "app" }),
      })
    ).status;
  } catch {
    return "failed";
  }
  if (status === 204) return "sent";
  if (status === 401) return "stopped";
  if (status === 429) return "rate_limited";
  return "failed";
}

export type Deps = {
  code: string | null;
  last: Last | null;
  save: (last: Last) => Promise<void>;
  stop: () => Promise<void>;
  fetch?: typeof fetch;
  now?: number;
};

// Returns null when nothing was sent (no code, or throttled).
export async function onFix(fix: Fix, d: Deps, force = false): Promise<Last | null> {
  const now = d.now ?? Date.now();
  if (!d.code) {
    await d.stop();
    return null;
  }
  // ponytail: a throttled fix is dropped, not queued (no timers in a background wake).
  if (!force && d.last && now - d.last.at < MIN_GAP_MS) return null;
  const result = await postFix(d.code, fix, d.fetch);
  const last = {
    at: now,
    result,
    lat: Math.round(fix.lat * 100) / 100,
    lng: Math.round(fix.lng * 100) / 100,
  };
  await d.save(last);
  if (result === "stopped") await d.stop();
  return last;
}
