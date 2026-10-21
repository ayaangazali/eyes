import type { TaskStatus, WorkerSetup, WorkerTask, WorkerTasks, WorkerTasksQuery } from "@eyes/core";
import { Problem, smsHref } from "./api.ts";
import { type EmailRow, emailRow } from "./email.ts";
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

/** One task row as shown: every text here is also what the server search matches (question, place, date, amount). */
export type TaskLine = {
  id: string;
  question: string;
  place: string;
  date: string;
  amount: string;
  status: string;
  tone: "success" | "warning" | "";
  payout: string | null;
  review: boolean;
};

export type Filter = NonNullable<WorkerTasksQuery["status"]> | "all";

export const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "paid", label: "Paid" },
  { id: "pending", label: "Pending" },
  { id: "review", label: "Needs review" },
  { id: "expired", label: "Expired" },
];

/** The list: what is shown, the totals over all tasks, and whether more pages, a request or a failure are pending. */
export type TaskList = {
  q: string;
  filter: Filter;
  tasks: TaskLine[];
  paid: string;
  pending: string;
  /** The worker has tasks at all (false only when an unfiltered, unsearched list came back empty). */
  any: boolean;
  cursor: string | null;
  state: "loading" | "idle" | "more" | "error";
  error: unknown;
};

export type ListDeps = {
  send: MeDeps["send"];
  show: (list: TaskList) => void;
  /** The browser's IANA zone: rows show dates in it, and the server search matches them that way. */
  tz: string;
  live: boolean;
};

/** Ids of the page sections; exactly one is shown. */
export type MeView =
  | { step: "loading" | "missing" | "expired" }
  | { step: "error"; error: unknown }
  | { step: "loaded"; title: string; rows: Row[]; live: boolean; email: EmailRow | null };

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

const STATUS: Record<TaskStatus, { label: string; tone: TaskLine["tone"] }> = {
  dispatched: { label: "Offered", tone: "" },
  claimed: { label: "Claimed", tone: "" },
  submitted: { label: "Checking", tone: "" },
  verified: { label: "Verified", tone: "success" },
  paid: { label: "Paid", tone: "success" },
  expired: { label: "Expired", tone: "" },
  refunded: { label: "Not paid", tone: "" },
  disputed: { label: "Disputed", tone: "warning" },
  needs_review: { label: "Needs review", tone: "warning" },
};

const PAYOUT = {
  paid: "Paid out",
  pending: "Payout pending",
  waiting_for_payout_setup: "Waiting for payout setup",
};

/**
 * Reads the code (a signed `body.mac` token) from the URL fragment, which browsers never send to a server, and
 * clears the fragment so a shared screenshot or copied URL does not carry it. Null when missing or malformed.
 */
export function takeCode(
  d: { hash: string; pathname: string; search: string; replaceUrl: (url: string) => void },
  pattern = /^[\w-]+\.[\w-]+$/,
): string | null {
  const code = new URLSearchParams(d.hash.slice(1)).get("c") ?? "";
  if (d.hash) d.replaceUrl(d.pathname + d.search);
  return pattern.test(code) ? code : null;
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

/** The first setup row with an action gets the primary button, the rest secondary. */
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
          detail: payouts.live
            ? "Eyes texts you paid tasks near you."
            : "Eyes texts you test tasks near you.",
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
    app.connected
      ? {
          id: "app",
          state: "done",
          title: "Eyes app connected",
          detail: "Your app is connected to this account.",
          action: null,
        }
      : // Location codes work only for opted-in workers: the install POST answers 401 until START.
        s.opted_in
        ? todo(
            "app",
            "Connect the Eyes app",
            "Open the app once to connect it to this account.",
            "Open / connect Eyes app",
            null,
          )
        : {
            id: "app",
            state: "todo",
            title: "Connect the Eyes app",
            detail: "Text START first, then open the app.",
            action: null,
          },
  ];
  if (payouts.live) {
    rows.push(
      payouts.set_up && !payouts.setup_url
        ? {
            id: "payouts",
            state: "done",
            title: "Payouts set up",
            detail: "Eyes pays you for each verified task.",
            action: null,
          }
        : todo(
            "payouts",
            "Set up payouts",
            "Do this once to get paid for tasks.",
            "Set up payouts",
            payouts.setup_url,
          ),
    );
  }
  const first = rows.find((r) => r.action);
  if (first?.action) first.action.primary = true;
  return rows;
}

/** "Oct 17, 2026" in the worker's zone; the server search formats dates the same way (eyes_shown_date). */
export function shownDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  }).format(new Date(iso));
}

/** A task in plain words: status badge, and the payout only when money moved and the badge does not say it already. */
export function taskLine(t: WorkerTask, tz: string, live: boolean): TaskLine {
  const status = STATUS[t.status];
  return {
    id: t.task_id,
    question: t.question,
    place: t.place_label,
    date: shownDate(t.claimed_at, tz),
    amount: `$${t.bounty_usd.toFixed(2)}`,
    status: status.label,
    tone: status.tone,
    payout:
      !t.payout || (live && t.status === "paid") ? null : live ? PAYOUT[t.payout] : "Simulated, nothing sent",
    review: status.tone === "warning",
  };
}

/**
 * The /me task list: search, status filter and "load more", each a GET /w/me/tasks with the code in the header.
 * Only the newest request may show its answer, so a slow page for "pie" never lands over the one for "pier".
 */
export function taskList(code: string, d: ListDeps) {
  let list: TaskList = {
    q: "",
    filter: "all",
    tasks: [],
    paid: "$0.00",
    pending: "$0.00",
    any: false,
    cursor: null,
    state: "loading",
    error: null,
  };
  let seq = 0;
  let lastMore = false;
  const update = (next: Partial<TaskList>) => {
    list = { ...list, ...next };
    d.show(list);
    return list;
  };
  async function fetchPage(next: Partial<TaskList>, more: boolean): Promise<TaskList> {
    const mine = ++seq;
    lastMore = more;
    const { q, filter, cursor } = update({ ...next, state: more ? "more" : "loading", error: null });
    const query = new URLSearchParams({ tz: d.tz });
    if (q.trim()) query.set("q", q.trim());
    if (filter !== "all") query.set("status", filter);
    if (more && cursor) query.set("cursor", cursor);
    try {
      const page = (await d.send(`/w/me/tasks?${query}`, {
        headers: { Authorization: `Bearer ${code}` },
      })) as WorkerTasks;
      if (mine !== seq) return list;
      const rows = page.tasks.map((t) => taskLine(t, d.tz, d.live));
      return update({
        tasks: more ? [...list.tasks, ...rows] : rows,
        paid: `$${page.paid_usd.toFixed(2)}`,
        pending: `$${page.pending_usd.toFixed(2)}`,
        any: list.any || rows.length > 0,
        cursor: page.next_cursor,
        state: "idle",
      });
    } catch (error) {
      return mine === seq ? update({ state: "error", error }) : list;
    }
  }
  return {
    /** The first page, or again whatever failed last (a page of more, or the search). */
    load: () => fetchPage({}, lastMore),
    search: (q: string) => fetchPage({ q }, false),
    filter: (filter: Filter) => fetchPage({ filter }, false),
    /** The next page; a no-op while a request runs or when there is none. */
    more: () => (list.state === "idle" && list.cursor ? fetchPage({}, true) : Promise.resolve(list)),
  };
}

export function meView(s: WorkerSetup, now: number): MeView {
  const rows = checklist(s, now);
  const title = rows.some((r) => r.state === "todo") ? "Finish setting up" : "You're set up";
  return { step: "loaded", title, rows, live: s.payouts.live, email: emailRow(s) };
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
