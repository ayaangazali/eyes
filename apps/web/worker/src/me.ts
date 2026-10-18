import type { TaskStatus, WorkerSetup } from "@eyes/core";
import { Problem, smsHref } from "./api.ts";
import { serverProblem } from "./here.ts";

/** A checklist action: a link, or (href null) the button that mints an install link first. */
export type Action = { label: string; href: string | null; primary: boolean };

/** One checklist row: done (✓), to do (○, with an action), or neutral (nothing to do here). */
export type Row = {
  id: "texts" | "spot" | "app" | "payouts";
  state: "done" | "todo" | "neutral";
  title: string;
  detail: string;
  action: Action | null;
};

export type TaskLine = { question: string; place: string; amount: string; state: string; paid: boolean };

/** Ids of the page sections; exactly one is shown. */
export type MeView =
  | { step: "loading" | "missing" | "expired" }
  | { step: "error"; error: unknown }
  | { step: "loaded"; title: string; rows: Row[]; tasks: TaskLine[]; earningsUrl: string };

export type MeDeps = {
  send: (path: string, init: RequestInit) => Promise<unknown>;
  now: () => number;
  show: (view: MeView) => void;
};

export type InstallDeps = {
  send: MeDeps["send"];
  busy: (on: boolean) => void;
  navigate: (url: string) => void;
  report: (err: unknown) => void;
};

const STATUS: Record<TaskStatus, string> = {
  dispatched: "Offered",
  claimed: "Claimed",
  submitted: "Checking",
  verified: "Verified",
  paid: "Paid",
  expired: "Expired",
  refunded: "Not paid",
  disputed: "Disputed",
  needs_review: "In review",
};

const PAYOUT = {
  paid: "Paid",
  pending: "Payout pending",
  waiting_for_payout_setup: "Waiting for payout setup",
};

/**
 * Reads the code (a signed `body.mac` token) from the URL fragment, which browsers never send to a server, and
 * clears the fragment so a shared screenshot or copied URL does not carry it. Null when missing or malformed.
 */
export function takeCode(d: {
  hash: string;
  pathname: string;
  search: string;
  replaceUrl: (url: string) => void;
}): string | null {
  const code = new URLSearchParams(d.hash.slice(1)).get("c") ?? "";
  if (d.hash) d.replaceUrl(d.pathname + d.search);
  return /^[\w-]+\.[\w-]+$/.test(code) ? code : null;
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". A time ahead of the clock reads "just now". */
export function ago(iso: string, now: number): string {
  const min = Math.floor((now - Date.parse(iso)) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.floor(h / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** The four setup rows. The first row with an action gets the primary button, the rest secondary. */
export function checklist(s: WorkerSetup, now: number, startSms = smsHref("START")): Row[] {
  const { spot, app, payouts } = s;
  const todo = (id: Row["id"], title: string, detail: string, label: string, href: string | null) =>
    ({ id, state: "todo", title, detail, action: { label, href, primary: false } }) as Row;
  const rows: Row[] = [
    s.opted_in
      ? {
          id: "texts",
          state: "done",
          title: "Number joined",
          detail: "Eyes texts you paid tasks near you.",
          action: null,
        }
      : startSms
        ? todo("texts", "Texts are off", "Text START to turn them back on.", "Text START", startSms)
        : {
            id: "texts",
            state: "todo",
            title: "Texts are off",
            detail: "Text START to the Eyes number to turn them back on.",
            action: null,
          },
    spot.at && spot.fresh
      ? {
          id: "spot",
          state: "done",
          title: "Spot is fresh",
          detail: `Updated ${ago(spot.at, now)}`,
          action: null,
        }
      : todo(
          "spot",
          "Update your spot",
          spot.at ? `Last spot ${ago(spot.at, now)}` : "Eyes has no spot for you yet.",
          "Update my spot",
          s.here_url,
        ),
    app.last_at && app.sending
      ? {
          id: "app",
          state: "done",
          title: "Eyes app is on",
          detail: `App sent your spot ${ago(app.last_at, now)}`,
          action: null,
        }
      : // Location codes work only for opted-in workers: the install POST answers 401 until START.
        s.opted_in
        ? todo(
            "app",
            "Get the Eyes app",
            app.last_at
              ? `App last sent your spot ${ago(app.last_at, now)}`
              : "It keeps your spot fresh for you.",
            "Install / open Eyes app",
            null,
          )
        : {
            id: "app",
            state: "todo",
            title: "Get the Eyes app",
            detail: "Text START first, then install the app.",
            action: null,
          },
    payouts.set_up
      ? {
          id: "payouts",
          state: "done",
          title: "Payouts set up",
          detail: "Eyes pays you for each verified task.",
          action: null,
        }
      : payouts.live && payouts.setup_url
        ? todo(
            "payouts",
            "Set up payouts",
            "Do this once to get paid for tasks.",
            "Set up payouts",
            payouts.setup_url,
          )
        : {
            id: "payouts",
            state: "neutral",
            title: "Test payouts",
            detail: "Payouts are simulated on this test server.",
            action: null,
          },
  ];
  const first = rows.find((r) => r.action);
  if (first?.action) first.action.primary = true;
  return rows;
}

/** Up to 5 tasks, newest first: status and payout in plain words, the payout only when it adds something. */
export function taskLines(tasks: WorkerSetup["tasks"]): TaskLine[] {
  return tasks.slice(0, 5).map((t) => {
    const status = STATUS[t.status];
    const payout = t.payout ? PAYOUT[t.payout] : status;
    return {
      question: t.question,
      place: t.place_label,
      amount: `$${t.bounty_usd.toFixed(2)}`,
      state: payout === status ? status : `${status} · ${payout}`,
      paid: payout === "Paid",
    };
  });
}

export function meView(s: WorkerSetup, now: number): MeView {
  const rows = checklist(s, now);
  const title = rows.some((r) => r.state === "todo") ? "Finish setting up" : "You're set up";
  return { step: "loaded", title, rows, tasks: taskLines(s.tasks), earningsUrl: s.earnings_url };
}

/** Loads the setup with the code in the Authorization header only (never the URL) and shows the result. */
export async function showMe(code: string | null, d: MeDeps): Promise<MeView> {
  let view: MeView;
  if (code === null) view = { step: "missing" };
  else {
    d.show({ step: "loading" });
    try {
      view = meView(
        (await d.send("/w/me", { headers: { Authorization: `Bearer ${code}` } })) as WorkerSetup,
        d.now(),
      );
    } catch (error) {
      view =
        error instanceof Problem && error.status === 401 ? { step: "expired" } : { step: "error", error };
    }
  }
  d.show(view);
  return view;
}

/** Mints a fresh location code (POST, so viewing /me never rotates codes), then opens the install link. */
export async function openInstall(code: string, d: InstallDeps): Promise<void> {
  d.busy(true);
  try {
    const { install_url } = (await d.send("/w/me/install", {
      method: "POST",
      headers: { Authorization: `Bearer ${code}` },
    })) as { install_url: string };
    d.navigate(install_url);
  } catch (err) {
    d.busy(false);
    d.report(serverProblem(err));
  }
}
