import type { WorkerSetup } from "@eyes/core";
import { describe, expect, it, vi } from "vitest";
import { Problem } from "./api.ts";
import { ago, checklist, type MeDeps, meView, openInstall, showMe, takeCode, taskLines } from "./me.ts";

const CODE = "eyJwIjoiZTp3MSIsImUiOjF9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
const NOW = Date.parse("2026-10-17T12:00:00Z");
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const HERE = "https://app.eyes.pictures/here.html?t=h.t";
const EARNINGS = "https://app.eyes.pictures/earnings?t=e.t";
const CONNECT = "https://connect.stripe.com/setup/abc";
const START = "sms:+14155550100?&body=START";

function setup(over: Partial<WorkerSetup> = {}): WorkerSetup {
  return {
    opted_in: true,
    spot: { at: minAgo(12), fresh: true, max_age_h: 24 },
    app: { last_at: minAgo(5), sending: true },
    payouts: { set_up: true, live: true, setup_url: null },
    here_url: HERE,
    earnings_url: EARNINGS,
    tasks: [],
    ...over,
  };
}

const task = (over: Partial<WorkerSetup["tasks"][number]> = {}): WorkerSetup["tasks"][number] => ({
  question: "Is oat milk in stock right now?",
  place_label: "Blue Bottle Coffee, Mint Plaza",
  status: "verified",
  bounty_usd: 3,
  payout: "pending",
  claimed_at: minAgo(30),
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
        title: "Eyes app is on",
        detail: "App sent your spot 5 min ago",
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

  it("offers the install button (no href: it mints a link first) when the app is not sending", () => {
    expect(row({ app: { last_at: minAgo(2 * 24 * 60), sending: false } }, "app")).toEqual({
      id: "app",
      state: "todo",
      title: "Get the Eyes app",
      detail: "App last sent your spot 2 days ago",
      action: { label: "Install / open Eyes app", href: null, primary: true },
    });
    expect(row({ app: { last_at: null, sending: false } }, "app")).toMatchObject({
      detail: "It keeps your spot fresh for you.",
    });
  });

  it("hides the install button and asks for START first when texts are off", () => {
    expect(row({ opted_in: false, app: { last_at: null, sending: false } }, "app")).toEqual({
      id: "app",
      state: "todo",
      title: "Get the Eyes app",
      detail: "Text START first, then install the app.",
      action: null,
    });
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
      app: { last_at: null, sending: false },
      payouts: { set_up: false, live: true, setup_url: CONNECT },
    }).map((r) => r.action?.primary);
    expect(actions).toEqual([true, false, undefined, false]);
    const noSms = rows({ opted_in: false, spot: { at: null, fresh: false, max_age_h: 24 } }, null);
    expect(noSms.map((r) => r.action?.primary)).toEqual([undefined, true, undefined, undefined]);
  });
});

describe("taskLines", () => {
  it("puts the status and payout in plain words, with the amount in dollars", () => {
    expect(taskLines([task()])).toEqual([
      {
        question: "Is oat milk in stock right now?",
        place: "Blue Bottle Coffee, Mint Plaza",
        amount: "$3.00",
        state: "Verified · Payout pending",
        paid: false,
      },
    ]);
  });

  it("says Paid once when the task and the payout are both paid", () => {
    expect(taskLines([task({ status: "paid", payout: "paid", bounty_usd: 2.5 })])[0]).toMatchObject({
      amount: "$2.50",
      state: "Paid",
      paid: true,
    });
  });

  it("shows only the status when there is no payout, and the setup wait when payouts are not set up", () => {
    expect(taskLines([task({ status: "expired", payout: null })])[0]).toMatchObject({
      state: "Expired",
      paid: false,
    });
    expect(taskLines([task({ payout: "waiting_for_payout_setup" })])[0]?.state).toBe(
      "Verified · Waiting for payout setup",
    );
    expect(taskLines([task({ status: "claimed", payout: null })])[0]?.state).toBe("Claimed");
  });

  it("keeps at most 5 tasks", () => {
    expect(taskLines(Array.from({ length: 7 }, () => task()))).toHaveLength(5);
  });
});

describe("meView", () => {
  it("titles the page You're set up when nothing is left to do (simulated payouts count as done)", () => {
    const view = meView(
      setup({ payouts: { set_up: false, live: false, setup_url: null }, tasks: [task()] }),
      NOW,
    );
    expect(view).toMatchObject({ step: "loaded", title: "You're set up", earningsUrl: EARNINGS });
    expect(view.step === "loaded" && view.tasks).toHaveLength(1);
  });

  it("titles the page Finish setting up when a row is to do", () => {
    expect(meView(setup({ opted_in: false }), NOW)).toMatchObject({ title: "Finish setting up" });
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
