/** Deep link for a connect code in the URL fragment, or null when the code is missing or malformed. */
export function connectDeepLink(hash: string): string | null {
  const code = new URLSearchParams(hash.slice(1)).get("c") ?? "";
  return /^[\w-]{20,200}$/.test(code) ? `eyes://connect#c=${code}` : null;
}

export type AppPageDeps = {
  hash: string;
  pathname: string;
  search: string;
  replaceUrl: (url: string) => void;
  /** Shows the page section with this id and hides the other sections. */
  reveal: (id: string) => void;
  setHref: (id: string, href: string) => void;
  onLoad: (fn: () => void) => void;
  /** Runs fn instead of following the app link when it is tapped. */
  onTap: (fn: () => void) => void;
  later: (fn: () => void, ms: number) => void;
  navigate: (url: string) => void;
  doc: EventTarget & { hidden: boolean };
  win: EventTarget;
  testflightUrl: string | undefined;
};

export type OpenAppDeps = Pick<AppPageDeps, "reveal" | "navigate" | "doc" | "win" | "testflightUrl">;

/**
 * Opens the app, or installs it when it is missing. An opened app hides the page (cancel). iOS's
 * "Open in Eyes?" prompt and its "cannot open" alert both blur the page, so blur pauses the 2.5 s clock and
 * focus resumes it: confirming the prompt hides the page, dismissing either dialog lets the fallback run.
 * When the clock runs out: TestFlight, or the in-review notice while there is no TestFlight link.
 */
export function openApp(deep: string, d: OpenAppDeps): void {
  d.navigate(deep);
  let left = 2500;
  let started = Date.now();
  let done = false;
  let paused = false;
  const fallback = () => {
    done = true;
    if (d.testflightUrl) d.navigate(d.testflightUrl);
    else d.reveal("review");
  };
  let timer = setTimeout(fallback, left);
  d.doc.addEventListener("visibilitychange", () => {
    if (!d.doc.hidden) return;
    done = true;
    clearTimeout(timer);
  });
  d.win.addEventListener("pagehide", () => {
    done = true;
    clearTimeout(timer);
  });
  d.win.addEventListener("blur", () => {
    if (done || paused) return;
    paused = true;
    clearTimeout(timer);
    left -= Date.now() - started;
  });
  d.win.addEventListener("focus", () => {
    if (done || !paused) return;
    paused = false;
    started = Date.now();
    timer = setTimeout(fallback, left);
  });
}

/**
 * Wires the app landing page. The code arrives in the URL fragment, which browsers never send to a server.
 * It is read, handed only to the app, and cleared from the address bar so a shared screenshot or copied URL
 * does not carry it. Returns the deep link, or null when the page shows the "missing" message instead.
 */
export function startApp(d: AppPageDeps): string | null {
  const deep = connectDeepLink(d.hash);
  if (d.hash) d.replaceUrl(d.pathname + d.search);
  if (deep === null) {
    d.reveal("missing");
    return null;
  }
  d.setHref("open", deep);
  d.reveal("ready");
  d.onTap(() => openApp(deep, d));
  // Opens the app at once when it is installed; after load, so the page is there to fall back on.
  d.onLoad(() => d.later(() => d.navigate(deep), 300));
  return deep;
}
