import { describe, expect, it, vi } from "vitest";
import { Problem } from "./api.ts";
import {
  checkInstall,
  DEFAULT_MANIFEST_URL,
  type DeviceStatus,
  deviceStep,
  forgetCode,
  type InstallDeps,
  itmsUrl,
  loadSaved,
  markDone,
  POLL_MAX_MS,
  POLL_MS,
  readCode,
  SAVED_KEY,
  startInstall,
} from "./install.ts";

const CODE = "a".repeat(43);
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";
const PROFILE = "https://api.eyes.pictures/w/device/profile/tkt";
const status = (over: Partial<DeviceStatus> = {}): DeviceStatus => ({
  profile_url: PROFILE,
  registered: false,
  ready: false,
  ...over,
});

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const memStore = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => void m.set(k, v)),
    removeItem: vi.fn((k: string) => void m.delete(k)),
  };
};
const savedStore = (saved: object) => memStore({ [SAVED_KEY]: JSON.stringify(saved) });

function fakeDeps(over: Partial<InstallDeps> = {}): InstallDeps {
  return {
    store: memStore(),
    now: NOW,
    hash: `#c=${CODE}`,
    pathname: "/install",
    search: "",
    userAgent: IPHONE,
    replaceUrl: vi.fn(),
    send: vi.fn(async () => status()),
    show: vi.fn(),
    setHref: vi.fn(),
    report: vi.fn(),
    ...over,
  };
}

describe("readCode", () => {
  it("reads a valid code, also among other fragment parameters", () => {
    expect(readCode(`#c=${CODE}`)).toBe(CODE);
    expect(readCode(`#x=1&c=${CODE}`)).toBe(CODE);
  });

  it.each([
    ["", ""],
    ["no c", `#x=${CODE}`],
    ["too short", "#c=short"],
    ["bad characters", `#c=${"a.".repeat(15)}`],
  ])("refuses %s", (_label, hash) => {
    expect(readCode(hash)).toBeNull();
  });
});

describe("itmsUrl", () => {
  it("encodes the manifest URL into the install link", () => {
    expect(itmsUrl("https://x.test/m.plist?a=1")).toBe(
      "itms-services://?action=download-manifest&url=https%3A%2F%2Fx.test%2Fm.plist%3Fa%3D1",
    );
  });

  it("falls back to the default manifest", () => {
    expect(itmsUrl()).toBe(
      `itms-services://?action=download-manifest&url=${encodeURIComponent(DEFAULT_MANIFEST_URL)}`,
    );
  });
});

describe("deviceStep", () => {
  it.each([
    [status(), false, "register"],
    [status(), true, "waiting"],
    [status({ registered: true }), false, "waiting"],
    [status({ registered: true, ready: true }), false, "install"],
  ] as const)("%o with registered=%s → %s", (s, param, step) => {
    expect(deviceStep(s, param)).toBe(step);
  });

  it("follows the steps marked done; Developer Mode never blocks; the app connecting ends it", () => {
    const ready = status({ registered: true, ready: true });
    expect(deviceStep(ready, false, 2)).toBe("open");
    expect(deviceStep(status({ registered: true }), false, 2)).toBe("open");
    expect(deviceStep(status(), false, 1)).toBe("waiting");
    expect(deviceStep(ready, false, 1)).toBe("install");
    expect(deviceStep(ready, false, 3)).toBe("done");
    expect(deviceStep({ ...ready, app_connected: true }, false, 0)).toBe("connected");
    expect(deviceStep(status({ app_connected: true }), false, 3)).toBe("connected");
  });
});

describe("saved code", () => {
  it("loads a fresh saved code and drops expired, future, malformed or unparsable ones", () => {
    expect(loadSaved(savedStore({ code: CODE, savedAt: NOW - 23 * HOUR }), NOW)).toEqual({
      code: CODE,
      savedAt: NOW - 23 * HOUR,
    });
    expect(loadSaved(memStore(), NOW)).toBeNull();
    for (const store of [
      savedStore({ code: CODE, savedAt: NOW - 24 * HOUR }),
      savedStore({ code: CODE, savedAt: NOW + HOUR }),
      savedStore({ code: "short", savedAt: NOW }),
      memStore({ [SAVED_KEY]: "{" }),
    ]) {
      expect(loadSaved(store, NOW)).toBeNull();
      expect(store.removeItem).toHaveBeenCalledWith(SAVED_KEY);
    }
  });

  it("markDone only moves forward on a saved code; forgetCode removes it", () => {
    const store = savedStore({ code: CODE, savedAt: NOW });
    markDone(store, NOW, 2);
    markDone(store, NOW, 1);
    expect(loadSaved(store, NOW)).toEqual({ code: CODE, savedAt: NOW, done: 2 });
    forgetCode(store);
    expect(loadSaved(store, NOW)).toBeNull();
    const empty = memStore();
    markDone(empty, NOW, 1);
    expect(empty.setItem).not.toHaveBeenCalled();
  });
});

describe("startInstall", () => {
  it("sends the code only as a Bearer header, clears the fragment, and shows the register step", async () => {
    const d = fakeDeps({ search: "?x=1" });
    expect(await startInstall(d)).toBe("register");
    expect(d.replaceUrl).toHaveBeenCalledWith("/install?x=1");
    expect(d.send).toHaveBeenCalledWith("/w/device", {
      method: "POST",
      headers: { Authorization: `Bearer ${CODE}` },
    });
    expect(d.setHref).toHaveBeenCalledWith("profile", PROFILE);
    expect(d.show).toHaveBeenCalledWith("register");
    expect(d.report).not.toHaveBeenCalled();
  });

  it("shows the waiting step once registered", async () => {
    const d = fakeDeps({ send: vi.fn(async () => status({ registered: true })) });
    expect(await startInstall(d)).toBe("waiting");
    expect(d.setHref).toHaveBeenCalledExactlyOnceWith("open", `eyes://connect#c=${CODE}`);
  });

  it("sets the install link when ready", async () => {
    const d = fakeDeps({ send: vi.fn(async () => status({ registered: true, ready: true })) });
    expect(await startInstall(d, "https://x.test/m.plist")).toBe("install");
    expect(d.setHref).toHaveBeenCalledWith("itms", itmsUrl("https://x.test/m.plist"));
    expect(d.setHref).toHaveBeenCalledWith("open", `eyes://connect#c=${CODE}`);
    expect(d.show).toHaveBeenCalledWith("install");
  });

  it("saves the code from the link, so the bare ready link and the profile redirect still work", async () => {
    const store = memStore();
    await startInstall(fakeDeps({ store }));
    expect(loadSaved(store, NOW)).toEqual({ code: CODE, savedAt: NOW });
    const d = fakeDeps({ store, hash: "", search: "?registered=1", now: NOW + HOUR });
    expect(await startInstall(d)).toBe("waiting");
    expect(d.send).toHaveBeenCalledWith("/w/device", {
      method: "POST",
      headers: { Authorization: `Bearer ${CODE}` },
    });
  });

  it("starts at Open Eyes after the Install tap, keeping the saved time for the same code", async () => {
    const store = savedStore({ code: CODE, savedAt: NOW - HOUR, done: 2 });
    const d = fakeDeps({ store, send: vi.fn(async () => status({ registered: true, ready: true })) });
    expect(await startInstall(d)).toBe("open");
    expect(store.setItem).not.toHaveBeenCalled();
    expect(d.setHref).toHaveBeenCalledWith("open", `eyes://connect#c=${CODE}`);
  });

  it("a new code in the link replaces the saved one and starts over", async () => {
    const store = savedStore({ code: "b".repeat(43), savedAt: NOW - HOUR, done: 2 });
    await startInstall(fakeDeps({ store }));
    expect(loadSaved(store, NOW)).toEqual({ code: CODE, savedAt: NOW });
  });

  it("shows connected and forgets the code once the app sent a fix", async () => {
    const d = fakeDeps({ send: vi.fn(async () => status({ ready: true, app_connected: true })) });
    expect(await startInstall(d)).toBe("connected");
    expect(d.show).toHaveBeenCalledWith("connected");
    expect(loadSaved(d.store, NOW)).toBeNull();
  });

  it("treats ?registered=1 without a code as registered, without calling the API", async () => {
    const d = fakeDeps({ hash: "", search: "?registered=1" });
    expect(await startInstall(d)).toBe("waiting");
    expect(d.send).not.toHaveBeenCalled();
    expect(d.replaceUrl).not.toHaveBeenCalled();
  });

  it("explains how to get a link when there is no valid code", async () => {
    const d = fakeDeps({ hash: "#c=short" });
    expect(await startInstall(d)).toBe("missing");
    expect(d.replaceUrl).toHaveBeenCalledWith("/install");
    expect(d.send).not.toHaveBeenCalled();
  });

  it("asks for an iPhone on other devices, still clearing the fragment", async () => {
    const d = fakeDeps({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    expect(await startInstall(d)).toBe("not-iphone");
    expect(d.replaceUrl).toHaveBeenCalledWith("/install");
    expect(d.send).not.toHaveBeenCalled();
  });

  it("shows the expired step on 401", async () => {
    const d = fakeDeps({ send: vi.fn().mockRejectedValue(new Problem("x", "y", 401)) });
    expect(await startInstall(d)).toBe("expired");
    expect(d.report).not.toHaveBeenCalled();
    expect(loadSaved(d.store, NOW)).toBeNull();
  });

  it.each([
    ["a network failure", new Problem("Could not reach Eyes.", "Check your signal, then try again.")],
    ["a server error", new Problem("Eyes had a problem (HTTP 500).", "Wait a moment, then try again.", 500)],
    ["a non-Problem error", new Error("boom")],
  ])("reports %s", async (_label, err) => {
    const d = fakeDeps({ send: vi.fn().mockRejectedValue(err) });
    expect(await startInstall(d)).toBe("error");
    expect(d.report).toHaveBeenCalledWith(err);
    expect(d.show).toHaveBeenCalledWith("error");
  });
});

describe("polling", () => {
  // A fake clock: each sleep moves it forward.
  const poller = (visible = () => true) => {
    let t = NOW;
    return {
      sleep: vi.fn(async (ms: number) => {
        t += ms;
      }),
      visible,
      clock: () => t,
    };
  };

  it("asks every 5 s until the app connects, then stops", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(status({ ready: true }))
      .mockResolvedValueOnce(status({ ready: true }))
      .mockResolvedValue(status({ ready: true, app_connected: true }));
    const poll = poller();
    const d = fakeDeps({ send, poll });
    expect(await startInstall(d)).toBe("connected");
    expect(send).toHaveBeenCalledTimes(3);
    expect(poll.sleep).toHaveBeenCalledWith(POLL_MS);
    expect(d.show).toHaveBeenLastCalledWith("connected");
    expect(loadSaved(d.store, NOW)).toBeNull();
  });

  it("gives up after 10 minutes, and skips the ask while the page is hidden", async () => {
    let n = 0;
    const poll = poller(() => ++n % 2 === 1); // visible every other tick
    const d = fakeDeps({ poll });
    expect(await startInstall(d)).toBe("register");
    expect(poll.sleep).toHaveBeenCalledTimes(POLL_MAX_MS / POLL_MS);
    expect(d.send).toHaveBeenCalledTimes(1 + POLL_MAX_MS / POLL_MS / 2);
  });

  it("stops on an error or a finished page, and never starts off an iPhone", async () => {
    const send = vi.fn().mockResolvedValueOnce(status()).mockRejectedValue(new Error("boom"));
    expect(await startInstall(fakeDeps({ send, poll: poller() }))).toBe("error");
    expect(send).toHaveBeenCalledTimes(2);
    const done = fakeDeps({
      store: savedStore({ code: CODE, savedAt: NOW, done: 3 }),
      hash: "",
      poll: poller(),
    });
    expect(await startInstall(done)).toBe("done");
    expect(done.send).toHaveBeenCalledOnce();
    const mac = fakeDeps({ userAgent: "Mozilla/5.0 (Macintosh)", poll: poller() });
    expect(await startInstall(mac)).toBe("not-iphone");
    expect(mac.poll?.sleep).not.toHaveBeenCalled();
  });
});

describe("I already did this", () => {
  it("advances one step per tap, kept with the code", async () => {
    const store = savedStore({ code: CODE, savedAt: NOW });
    const d = fakeDeps({ store, hash: "", send: vi.fn(async () => status()) });
    expect(await checkInstall(d)).toBe("register");
    for (const [done, step] of [
      [1, "waiting"],
      [2, "open"],
      [3, "done"],
    ] as const) {
      markDone(store, NOW, done);
      expect(await checkInstall(d)).toBe(step);
    }
    expect(loadSaved(store, NOW)?.done).toBe(3);
  });
});
