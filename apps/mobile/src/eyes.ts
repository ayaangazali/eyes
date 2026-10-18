// Pure logic: no Expo imports, so the root vitest run covers it.
export const API = "https://api.eyes.pictures/w/location";
export const MIN_GAP_MS = 60_000;

export const isCode = (s: string) => /^[A-Za-z0-9_-]{43}$/.test(s);

// eyes://connect#c=<code> (the code rides in the fragment); ?c= is accepted too.
export const codeFromUrl = (url: string) =>
  /^eyes:\/\/connect\/?[?#](?:[^#]*[&#?])?c=([A-Za-z0-9_-]{43})(?:[&#]|$)/.exec(url)?.[1] ?? null;

export type Fix = { lat: number; lng: number; accuracy_m?: number; captured_at?: string };
export type Result = "sent" | "stopped" | "rate_limited" | "failed";
export type Last = { at: number; result: Result; lat: number; lng: number };

// A 429 means the server stored a fix for this worker seconds ago (1 per 30 s), so the spot is fresh.
export const MESSAGES: Record<Result, string> = {
  sent: "Sent",
  stopped: "Code stopped working: text AUTO to Eyes for a new one",
  rate_limited: "Up to date",
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
  load: () => Promise<{ code: string | null; last: Last | null }>;
  save: (last: Last) => Promise<void>;
  stop: () => Promise<void>;
  fetch?: typeof fetch;
  now?: number;
};

let inFlight = false;

// Returns null when nothing was sent: no code, a send already in flight, or a success < 60 s ago.
// `at` is the time of the last success; failures keep it, so the next update retries.
export async function onFix(fix: Fix, d: Deps): Promise<Last | null> {
  if (inFlight) return null;
  inFlight = true;
  try {
    const now = d.now ?? Date.now();
    const { code, last } = await d.load();
    if (!code) {
      await d.stop();
      return null;
    }
    const ok = last?.result === "sent" || last?.result === "rate_limited";
    // ponytail: a throttled fix is dropped, not queued (no timers in a background wake).
    if (ok && last && now - last.at < MIN_GAP_MS) return null;
    const result = await postFix(code, fix, d.fetch);
    const next = {
      at: result === "sent" || !ok || !last ? now : last.at,
      result,
      lat: Math.round(fix.lat * 100) / 100,
      lng: Math.round(fix.lng * 100) / 100,
    };
    await d.save(next);
    if (result === "stopped") await d.stop();
    return next;
  } finally {
    inFlight = false;
  }
}
