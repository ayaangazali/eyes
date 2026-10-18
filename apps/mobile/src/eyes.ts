// Pure logic: no Expo imports, so the root vitest run covers it.
// EXPO_PUBLIC_EYES_API is a dev-only override (simulator proof against a local server); releases leave it unset.
export const API = `${process.env.EXPO_PUBLIC_EYES_API ?? "https://api.eyes.pictures"}/w/location`;
export const MIN_GAP_MS = 60_000;

export const isCode = (s: string) => /^[A-Za-z0-9_-]{43}$/.test(s);

// eyes://connect#c=<code> (the code rides in the fragment); ?c= is accepted too.
export const codeFromUrl = (url: string) =>
  /^eyes:\/\/connect\/?[?#](?:[^#]*[&#?])?c=([A-Za-z0-9_-]{43})(?:[&#]|$)/.exec(url)?.[1] ?? null;

export type Grant = { granted: boolean; canAskAgain: boolean };

// What the screen shows. "sharing" starts as soon as foreground ("While Using") is granted;
// `always` false means iOS kept it to While Using: one inline hint, not a blocker.
export type State =
  | { view: "loading" | "code" | "ask" | "denied" | "paused" }
  | { view: "sharing"; always: boolean };

export type Env = {
  code: () => Promise<string | null>;
  paused: () => Promise<boolean>;
  fg: () => Promise<Grant>;
  askFg: () => Promise<Grant>;
  bg: () => Promise<Grant>;
  askBg: () => Promise<Grant>;
  sharing: () => Promise<boolean>;
  start: () => Promise<void>;
  sendNow: () => Promise<void>;
  show: (s: State) => void;
};

// One pass from "app has a code" to "sharing": ask While Using right away, start updates, send the
// first fix, then ask Always (iOS shows that upgrade prompt once; later asks resolve with no dialog).
// `askAlways` false skips the Always prompt (already asked this launch).
export async function settle(e: Env, askAlways = true): Promise<State> {
  let s: State;
  if (!(await e.code())) s = { view: "code" };
  else if (await e.paused()) s = { view: "paused" };
  else {
    let fg = await e.fg();
    if (!fg.granted && fg.canAskAgain) fg = await e.askFg();
    if (!fg.granted) s = { view: fg.canAskAgain ? "ask" : "denied" };
    else {
      if (!(await e.sharing())) await e.start();
      let bg = await e.bg();
      e.show({ view: "sharing", always: bg.granted });
      await e.sendNow();
      if (!bg.granted && bg.canAskAgain && askAlways) bg = await e.askBg();
      s = { view: "sharing", always: bg.granted };
    }
  }
  e.show(s);
  return s;
}

export type Fix = { lat: number; lng: number; accuracy_m?: number; captured_at?: string };
export type Result = "sent" | "stopped" | "rate_limited" | "failed";
export type Last = { at: number; result: Result; lat: number; lng: number };

// A 429 means the server stored a fix for this worker seconds ago (1 per 30 s), so the spot is fresh.
export const MESSAGES: Record<Result, string> = {
  sent: "Sent",
  stopped: "Code stopped working: text HELP to Eyes for a new link",
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
