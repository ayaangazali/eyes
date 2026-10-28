import type { WorkerSetup, WorkerTask, WorkerTasks } from "@eyes/core";
import { describe, expect, it, vi } from "vitest";
import { Problem } from "./api.ts";
import {
  ago,
  checklist,
  type ListDeps,
  type MeDeps,
  meView,
  openInstall,
  showMe,
  shownDate,
  type TaskList,
  takeCode,
  taskLine,
  taskList,
} from "./me.ts";

const CODE = "eyJwIjoiZTp3MSIsImUiOjF9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
const NOW = Date.parse("2026-10-17T12:00:00Z");
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const HERE = "https://app.eyes.pictures/here.html?t=h.t";
const TZ = "America/Los_Angeles";
const CONNECT = "https://connect.stripe.com/setup/abc";
const START = "sms:+14155550100?&body=START";

function setup(over: Partial<WorkerSetup> = {}): WorkerSetup {
  return {
    opted_in: true,
    texts_on: true,
    spot: { at: minAgo(12), fresh: true, max_age_h: 24 },
    app: { connected: true, last_at: minAgo(5), sending: true },
    payouts: { set_up: true, live: true, setup_url: null },
    here_url: HERE,
    email_masked: null,
    email_status: "none",
    email_skipped: false,
    ...over,
  };
}

const task = (over: Partial<WorkerTask> = {}): WorkerTask => ({
  task_id: "8b3e4d5c-6f7a-4b2c-9d0e-1f2a3b4c5d6e",
  question: "Is oat milk in stock right now?",
  place_label: "Blue Bottle Coffee, Mint Plaza",
  status: "verified",
  bounty_usd: 3,
  payout: "pending",
  claimed_at: "2026-10-17T05:30:00.000Z",
  ...over,
});

describe("takeCode", () => {
  const read = (hash: string) => {
    const replaceUrl = vi.fn();
    const code = takeCode({ hash, pathname: "/me", search: "?x=1", replaceUrl });
    return { code, replaceUrl };
  };

  it("reads the code from the fragment and clears the fragment from the address bar", () => {
    const { code, replaceUrl } = read(`#c=${CODE}`);
    expect(code).toBe(CODE);
    expect(replaceUrl).toHaveBeenCalledWith("/me?x=1");
  });

  it("takes the shape a page expects: /login reads 43 base64url characters", () => {
    const login = `#c=${"A1_-".repeat(10)}abc`;
    expect(
      takeCode({ hash: login, pathname: "/login", search: "", replaceUrl: vi.fn() }, /^[\w-]{43}$/),
    ).toBe(login.slice(3));
    expect(read(login).code).toBeNull();
  });

  it("finds c among other fragment parameters", () => {
    expect(read(`#x=1&c=${CODE}`).code).toBe(CODE);
  });

  it.each([
    ["no c parameter", "#x=1"],
    ["an empty code", "#c="],
    ["a code without the signature part", "#c=abcdef"],
    ["a code with a line break", "#c=ab%0A.cd"],
  ])("returns null for %s, but still clears the fragment", (_label, hash) => {
    const { code, replaceUrl } = read(hash);
    expect(code).toBeNull();
    expect(replaceUrl).toHaveBeenCalledWith("/me?x=1");
  });

  it("leaves the address bar alone when there is no fragment", () => {
    const { code, replaceUrl } = read("");
    expect(code).toBeNull();
    expect(replaceUrl).not.toHaveBeenCalled();
  });
});

describe("ago", () => {
  it.each([
    [0, "just now"],
    [0.9, "just now"],
    [-5, "just now"],
    [1, "1 min ago"],
    [12, "12 min ago"],
    [59, "59 min ago"],
    [60, "1 h ago"],
    [3 * 60 + 20, "3 h ago"],
    [23 * 60 + 59, "23 h ago"],
    [24 * 60, "1 day ago"],
    [2 * 24 * 60 + 60, "2 days ago"],
  ])("%s minutes back reads %s", (minutes, words) => {
    expect(ago(minAgo(minutes), NOW)).toBe(words);
  });
});

describe("checklist", () => {
  const rows = (over: Partial<WorkerSetup>, sms: string | null = START) => checklist(setup(over), NOW, sms);
  const row = (over: Partial<WorkerSetup>, id: string, sms: string | null = START) =>
    rows(over, sms).find((r) => r.id === id);

  it("marks every row done, with times, when all four are set up", () => {
    expect(rows({})).toEqual([
      {
        id: "texts",
        state: "done",
        title: "Number joined",
        detail: "Eyes texts you paid tasks near you.",
        action: null,
      },
      { id: "spot", state: "done", title: "Spot is fresh", detail: "Updated 12 min ago", action: null },
      {
        id: "app",
        state: "done",
        title: "Eyes app connected",
        detail: "Your app is connected to this account.",
        action: null,
      },
      {
        id: "payouts",
        state: "done",
        title: "Payouts set up",
        detail: "Eyes pays you for each verified task.",
        action: null,
      },
    ]);
  });

  it("offers a text START button when texts are off", () => {
    expect(row({ opted_in: false }, "texts")).toEqual({
      id: "texts",
      state: "todo",
      title: "Texts are off",
      detail: "Text START to turn them back on.",
      action: { label: "Text START", href: START, primary: true },
    });
  });

  it("names the Eyes number instead of a button when the build has no number", () => {
    expect(row({ opted_in: false }, "texts", null)).toMatchObject({
      state: "todo",
      detail: "Text START to the Eyes number to turn them back on.",
      action: null,
    });
  });

  it("asks for a spot update, with the age of the last spot, when the spot is stale", () => {
    expect(row({ spot: { at: minAgo(3 * 24 * 60), fresh: false, max_age_h: 24 } }, "spot")).toEqual({
      id: "spot",
      state: "todo",
      title: "Update your spot",
      detail: "Last spot 3 days ago",
      action: { label: "Update my spot", href: HERE, primary: true },
    });
  });

  it("asks for a spot when there is none", () => {
    expect(row({ spot: { at: null, fresh: false, max_age_h: 24 } }, "spot")).toMatchObject({
      state: "todo",
      detail: "Eyes has no spot for you yet.",
    });
  });

  it("offers installation only when the app has not connected", () => {
    expect(row({ app: { connected: false, last_at: null, sending: false } }, "app")).toMatchObject({
      state: "todo",
      action: { href: null },
    });
  });

  it.each([true, false])("keeps app completion independent of spot freshness=%j", (fresh) => {
    const summary = setup({
      app: { connected: true, last_at: null, sending: false },
      spot: { at: minAgo(3 * 24 * 60), fresh, max_age_h: 24 },
    });
    const checks = checklist(summary, NOW);
    expect(checks.find((r) => r.id === "app")).toMatchObject({ state: "done", action: null });
    expect(checks.find((r) => r.id === "spot")?.state).toBe(fresh ? "done" : "todo");
  });

  it("hides the install button and asks for START first when texts are off", () => {
    expect(row({ opted_in: false, app: { connected: false, last_at: null, sending: false } }, "app")).toEqual(
      {
        id: "app",
        state: "todo",
        title: "Connect the Eyes app",
        detail: "Text START first, then open the app.",
        action: null,
      },
    );
  });

  it("links to payout setup when payouts are live and not set up", () => {
    expect(row({ payouts: { set_up: false, live: true, setup_url: CONNECT } }, "payouts")).toEqual({
      id: "payouts",
      state: "todo",
      title: "Set up payouts",
      detail: "Do this once to get paid for tasks.",
      action: { label: "Set up payouts", href: CONNECT, primary: true },
    });
  });

  it("shows simulated payouts as neutral, with nothing to do, on a test server", () => {
    expect(row({ payouts: { set_up: false, live: false, setup_url: null } }, "payouts")).toEqual({
      id: "payouts",
      state: "neutral",
      title: "Test payouts",
      detail: "Payouts are simulated on this test server.",
      action: null,
    });
    expect(row({ payouts: { set_up: false, live: true, setup_url: null } }, "payouts")?.state).toBe(
      "neutral",
    );
  });

  it("gives the primary button to the first row with an action only", () => {
    const actions = rows({
      opted_in: false,
      spot: { at: null, fresh: false, max_age_h: 24 },
      app: { connected: false, last_at: null, sending: false },
      payouts: { set_up: false, live: true, setup_url: CONNECT },
    }).map((r) => r.action?.primary);
    expect(actions).toEqual([true, false, undefined, false]);
    const noSms = rows({ opted_in: false, spot: { at: null, fresh: false, max_age_h: 24 } }, null);
    expect(noSms.map((r) => r.action?.primary)).toEqual([undefined, true, undefined, undefined]);
  });
});

describe("shownDate", () => {
  it("shows the date in the worker's zone, as the server search formats it", () => {
    expect(shownDate("2026-10-17T05:30:00.000Z", TZ)).toBe("Oct 16, 2026");
    expect(shownDate("2026-10-17T05:30:00.000Z", "UTC")).toBe("Oct 17, 2026");
    expect(shownDate("2026-03-01T12:00:00.000Z", "UTC")).toBe("Mar 1, 2026");
  });
});

describe("taskLine", () => {
  it("puts the status, payout and local date in plain words, with the amount in dollars", () => {
    expect(taskLine(task(), TZ, true)).toEqual({
      id: "8b3e4d5c-6f7a-4b2c-9d0e-1f2a3b4c5d6e",
      question: "Is oat milk in stock right now?",
      place: "Blue Bottle Coffee, Mint Plaza",
      date: "Oct 16, 2026",
      amount: "$3.00",
      status: "Verified",
      tone: "success",
      payout: "Payout pending",
      review: false,
    });
  });

  it.each([
    [{ status: "paid", payout: "paid", bounty_usd: 3 }, "Paid", "success", null],
    [{ status: "disputed", payout: "paid" }, "Disputed", "warning", "Paid out"],
    [{ payout: "waiting_for_payout_setup" }, "Verified", "success", "Waiting for payout setup"],
    [{ status: "expired", payout: null }, "Expired", "", null],
    [{ status: "refunded", payout: null }, "Not paid", "", null],
    [{ status: "claimed", payout: null }, "Claimed", "", null],
    [{ status: "submitted", payout: null }, "Checking", "", null],
    [{ status: "dispatched", payout: null }, "Offered", "", null],
  ] as const)("labels %o", (over, status, tone, payout) => {
    expect(taskLine(task(over), "UTC", true)).toMatchObject({
      status,
      tone,
      payout,
      review: tone === "warning",
    });
  });

  it.each(["needs_review", "disputed"] as const)("offers a manual review for %s", (status) => {
    expect(taskLine(task({ status, payout: null }), "UTC", true)).toMatchObject({
      tone: "warning",
      review: true,
    });
  });

  it("says the payout is simulated on a test server, and nothing when no money moved", () => {
    expect(taskLine(task({ payout: "paid" }), "UTC", false).payout).toBe("Simulated, nothing sent");
    expect(taskLine(task({ payout: null }), "UTC", false).payout).toBeNull();
  });
});

describe("taskList", () => {
  const page = (over: Partial<WorkerTasks> = {}): WorkerTasks => ({
    paid_usd: 3,
    pending_usd: 6.25,
    tasks: [task()],
    next_cursor: null,
    ...over,
  });
  // Answers each request in the order the test resolves them, so races can be staged.
  function deps() {
    const waiting: { path: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
    const shown: TaskList[] = [];
    const send = vi.fn(
      (path: string, _init: RequestInit) =>
        new Promise<unknown>((resolve, reject) => waiting.push({ path, resolve, reject })),
    );
    const d: ListDeps = { send, show: (l) => shown.push(l), tz: TZ, live: true };
    const answer = async (i: number, value: unknown) => {
      waiting[i]?.resolve(value);
      await Promise.resolve();
      await Promise.resolve();
    };
    return { d, send, waiting, shown, answer, last: () => shown.at(-1) as TaskList };
  }

  it("loads the first page with the code in the header only and the browser's zone, then shows totals", async () => {
    const { d, send, waiting, last } = deps();
    const list = taskList(CODE, d);
    const done = list.load();
    expect(last()).toMatchObject({ state: "loading", any: false, tasks: [] });
    waiting[0]?.resolve(page());
    expect(await done).toMatchObject({
      state: "idle",
      paid: "$3.00",
      pending: "$6.25",
      any: true,
      cursor: null,
    });
    expect(last().tasks.map((t) => t.date)).toEqual(["Oct 16, 2026"]);
    expect(send).toHaveBeenCalledWith("/w/me/tasks?tz=America%2FLos_Angeles", {
      headers: { Authorization: `Bearer ${CODE}` },
    });
    expect(send.mock.calls[0]?.[0]).not.toContain(CODE);
  });

  it("knows a worker without tasks apart from a search that matches nothing", async () => {
    const { d, waiting } = deps();
    const list = taskList(CODE, d);
    const first = list.load();
    waiting[0]?.resolve(page({ tasks: [], paid_usd: 0, pending_usd: 0 }));
    expect(await first).toMatchObject({ any: false, tasks: [] });
    const second = list.load();
    waiting[1]?.resolve(page());
    await second;
    const none = list.search("zzz");
    waiting[2]?.resolve(page({ tasks: [] }));
    expect(await none).toMatchObject({ any: true, tasks: [], q: "zzz" });
  });

  it("sends the trimmed search and the filter, and appends the next page with the cursor", async () => {
    const { d, send, waiting } = deps();
    const list = taskList(CODE, d);
    const searched = list.search("  pier ");
    waiting[0]?.resolve(page({ next_cursor: "2026-10-17T05:30:00.123456+00:00|x" }));
    await searched;
    const filtered = list.filter("paid");
    waiting[1]?.resolve(page({ next_cursor: "c|1" }));
    await filtered;
    const more = list.more();
    await expect(list.more()).resolves.toMatchObject({ state: "more" }); // a second tap while loading does nothing
    waiting[2]?.resolve(page({ tasks: [task({ task_id: "b", question: "Second?" })] }));
    const after = await more;
    expect(send.mock.calls.map(([path]) => path)).toEqual([
      "/w/me/tasks?tz=America%2FLos_Angeles&q=pier",
      "/w/me/tasks?tz=America%2FLos_Angeles&q=pier&status=paid",
      "/w/me/tasks?tz=America%2FLos_Angeles&q=pier&status=paid&cursor=c%7C1",
    ]);
    expect(after.tasks.map((t) => t.question)).toEqual(["Is oat milk in stock right now?", "Second?"]);
    expect(after.cursor).toBeNull();
    expect(await list.more()).toBe(after); // no next page: nothing to load
    expect(send).toHaveBeenCalledTimes(3);
    const all = list.filter("all");
    waiting[3]?.resolve(page());
    await all;
    expect(send.mock.calls[3]?.[0]).toBe("/w/me/tasks?tz=America%2FLos_Angeles&q=pier");
  });

  it("shows only the newest request's answer when an older one lands late", async () => {
    const { d, waiting, answer, last } = deps();
    const list = taskList(CODE, d);
    void list.search("pie");
    void list.search("pier");
    await answer(1, page({ tasks: [task({ question: "Pier?" })] }));
    await answer(0, page({ tasks: [task({ question: "Pie?" })] }));
    expect(last().tasks.map((t) => t.question)).toEqual(["Pier?"]);
    expect(last().q).toBe("pier");
  });

  it("keeps the rows on a failure, ignores a stale failure, and tries the failed page again", async () => {
    const { d, send, waiting, last } = deps();
    const list = taskList(CODE, d);
    const first = list.load();
    waiting[0]?.resolve(page({ next_cursor: "c|1" }));
    await first;
    const failed = list.more();
    const boom = new Problem("Could not reach Eyes.", "Check your signal, then try again.");
    waiting[1]?.reject(boom);
    expect(await failed).toMatchObject({
      state: "error",
      error: boom,
      tasks: [{ question: task().question }],
    });
    const retry = list.load();
    expect(send.mock.calls[2]?.[0]).toContain("cursor=c%7C1");
    waiting[2]?.resolve(page({ tasks: [task({ task_id: "b" })] }));
    expect((await retry).tasks).toHaveLength(2);

    const stale = list.search("a");
    void list.search("ab");
    waiting[3]?.reject(new Error("late"));
    await stale;
    expect(last()).toMatchObject({ state: "loading", error: null });
  });
});

describe("meView", () => {
  it("titles the page You're set up when nothing is left to do (simulated payouts count as done)", () => {
    const view = meView(setup({ payouts: { set_up: false, live: false, setup_url: null } }), NOW);
    expect(view).toEqual({
      step: "loaded",
      title: "You're set up",
      rows: expect.any(Array),
      live: false,
      email: expect.objectContaining({ status: "none" }),
    });
  });

  it("titles the page Finish setting up when a row is to do", () => {
    expect(meView(setup({ opted_in: false }), NOW)).toMatchObject({ title: "Finish setting up", live: true });
  });
});

describe("showMe", () => {
  function deps(send: MeDeps["send"]) {
    return { send: vi.fn(send), now: () => NOW, show: vi.fn() };
  }

  it("sends the code only in the Authorization header, shows loading, then the loaded view", async () => {
    const d = deps(async () => setup());
    const view = await showMe(CODE, d);
    expect(d.send).toHaveBeenCalledWith("/w/me", { headers: { Authorization: `Bearer ${CODE}` } });
    expect(d.send.mock.calls[0]?.[0]).not.toContain(CODE);
    expect(d.show.mock.calls.map(([v]) => v.step)).toEqual(["loading", "loaded"]);
    expect(view).toMatchObject({ step: "loaded", title: "You're set up" });
  });

  it("shows the missing view without calling Eyes when there is no code", async () => {
    const d = deps(async () => setup());
    expect(await showMe(null, d)).toEqual({ step: "missing" });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.show).toHaveBeenCalledOnce();
  });

  it("shows the expired view on 401", async () => {
    const d = deps(async () => {
      throw new Problem("Eyes had a problem (HTTP 401).", "", 401, { error: "unauthorized" });
    });
    expect(await showMe(CODE, d)).toEqual({ step: "expired" });
    expect(d.show).toHaveBeenLastCalledWith({ step: "expired" });
  });

  it.each([
    ["a network failure", new Problem("Could not reach Eyes.", "Check your signal, then try again.")],
    ["a server error", new Problem("Something went wrong at Eyes.", "Wait a moment, then try again.", 500)],
    ["a non-Problem error", new TypeError("boom")],
  ])("shows the error view, with the error, on %s", async (_label, error) => {
    const d = deps(async () => {
      throw error;
    });
    expect(await showMe(CODE, d)).toEqual({ step: "error", error });
  });
});

describe("openInstall", () => {
  function deps(send: MeDeps["send"]) {
    return { send: vi.fn(send), busy: vi.fn(), navigate: vi.fn(), report: vi.fn() };
  }

  it("posts with the code in the header, stays busy, and navigates to the install link", async () => {
    const d = deps(async () => ({ install_url: "https://app.eyes.pictures/install#c=loc" }));
    await openInstall(CODE, d);
    expect(d.send).toHaveBeenCalledWith("/w/me/install", {
      method: "POST",
      headers: { Authorization: `Bearer ${CODE}` },
    });
    expect(d.busy.mock.calls).toEqual([[true]]);
    expect(d.navigate).toHaveBeenCalledWith("https://app.eyes.pictures/install#c=loc");
    expect(d.report).not.toHaveBeenCalled();
  });

  it("ends the busy state and reports the server's words on error", async () => {
    const d = deps(async () => {
      throw new Problem("Eyes had a problem (HTTP 401).", "x", 401, {
        error: "unauthorized",
        message: "This link is invalid or has expired.",
        fix: "Text HELP to the Eyes number for a fresh link.",
      });
    });
    await openInstall(CODE, d);
    expect(d.busy.mock.calls).toEqual([[true], [false]]);
    expect(d.navigate).not.toHaveBeenCalled();
    expect(d.report).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "This link is invalid or has expired.",
        fix: "Text HELP to the Eyes number for a fresh link.",
      }),
    );
  });
});
