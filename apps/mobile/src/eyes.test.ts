import { describe, expect, it } from "vitest";
import {
  codeFromUrl,
  type Deps,
  type Env,
  isCode,
  type Last,
  MESSAGES,
  onFix,
  postFix,
  type State,
  settle,
} from "./eyes.ts";

const CODE = `${"A".repeat(40)}-_9`;
const fix = { lat: 37.7607, lng: -122.3857 };
const fakeFetch = (...statuses: number[]) => {
  const bodies: { source: string }[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(null, { status: statuses.shift() ?? 500 });
  }) as typeof fetch;
  return { f, bodies };
};
type Over = Partial<Omit<Deps, "load">> & { code?: string | null; last?: Last | null };
const deps = ({ code = CODE, last = null, ...over }: Over) => {
  const log = { saved: [] as Last[], stopped: 0 };
  const d: Deps = {
    load: async () => ({ code, last }),
    save: async (l) => void log.saved.push(l),
    stop: async () => void log.stopped++,
    now: 1_000_000,
    ...over,
  };
  return { d, log };
};

describe("isCode", () => {
  it("accepts 43-char base64url only", () => {
    expect(isCode(CODE)).toBe(true);
    expect(isCode(CODE.slice(1))).toBe(false);
    expect(isCode(`${CODE}A`)).toBe(false);
    expect(isCode(`${CODE.slice(1)}=`)).toBe(false);
    expect(isCode(`${CODE.slice(1)}+`)).toBe(false);
  });
});

describe("postFix", () => {
  it("maps statuses", async () => {
    for (const [status, result] of [
      [204, "sent"],
      [401, "stopped"],
      [429, "rate_limited"],
      [503, "failed"],
    ] as const)
      expect(await postFix(CODE, fix, fakeFetch(status).f)).toBe(result);
  });

  it("sends source app once; 400 is failed", async () => {
    const { f, bodies } = fakeFetch(400, 204);
    expect(await postFix(CODE, fix, f)).toBe("failed");
    expect(bodies.map((b) => b.source)).toEqual(["app"]);
  });

  it("network error is failed", async () => {
    expect(await postFix(CODE, fix, (async () => Promise.reject(new Error("offline"))) as typeof fetch)).toBe(
      "failed",
    );
  });
});

describe("onFix", () => {
  it("skips a send within 60 s of the last success; failures do not hold it back", async () => {
    const { f, bodies } = fakeFetch(204, 204);
    const last: Last = { at: 1_000_000 - 59_000, result: "sent", lat: 0, lng: 0 };
    expect(await onFix(fix, deps({ last, fetch: f }).d)).toBeNull();
    expect(await onFix(fix, deps({ last: { ...last, result: "rate_limited" }, fetch: f }).d)).toBeNull();
    expect(bodies).toHaveLength(0);
    expect((await onFix(fix, deps({ last: { ...last, at: 1_000_000 - 60_000 }, fetch: f }).d))?.result).toBe(
      "sent",
    );
    expect((await onFix(fix, deps({ last: { ...last, result: "failed" }, fetch: f }).d))?.result).toBe(
      "sent",
    );
  });

  it("429 is 'Up to date', keeps the last success time, so the next update retries", async () => {
    const last: Last = { at: 1_000_000 - 120_000, result: "sent", lat: 0, lng: 0 };
    const { d, log } = deps({ last, fetch: fakeFetch(429).f });
    const next = await onFix(fix, d);
    expect(next).toMatchObject({ at: last.at, result: "rate_limited" });
    expect(MESSAGES.rate_limited).toBe("Up to date");
    expect(log.stopped).toBe(0);
    const retry = fakeFetch(204);
    expect((await onFix(fix, deps({ last: next, fetch: retry.f }).d))?.result).toBe("sent");
  });

  it("skips a send while another is in flight", async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const slow = (async () => {
      entered.resolve();
      await gate.promise;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const { f, bodies } = fakeFetch(204);
    const first = onFix(fix, deps({ fetch: slow }).d);
    await entered.promise;
    expect(await onFix(fix, deps({ fetch: f }).d)).toBeNull();
    gate.resolve();
    expect((await first)?.result).toBe("sent");
    expect(bodies).toHaveLength(0);
  });

  it("401 stops updates and saves a rounded place", async () => {
    const { d, log } = deps({ fetch: fakeFetch(401).f });
    expect(await onFix(fix, d)).toEqual({ at: 1_000_000, result: "stopped", lat: 37.76, lng: -122.39 });
    expect(log.stopped).toBe(1);
    expect(MESSAGES.stopped).toBe("Code stopped working: text HELP to Eyes for a new link");
  });

  it("no code stops without posting", async () => {
    const { f, bodies } = fakeFetch(204);
    const { d, log } = deps({ code: null, fetch: f });
    expect(await onFix(fix, d)).toBeNull();
    expect([bodies.length, log.stopped]).toEqual([0, 1]);
  });
});

describe("codeFromUrl", () => {
  it("reads the code from the fragment or the query", () => {
    expect(codeFromUrl(`eyes://connect#c=${CODE}`)).toBe(CODE);
    expect(codeFromUrl(`eyes://connect/#c=${CODE}`)).toBe(CODE);
    expect(codeFromUrl(`eyes://connect?c=${CODE}`)).toBe(CODE);
    expect(codeFromUrl(`eyes://connect?x=1&c=${CODE}&y=2`)).toBe(CODE);
    expect(codeFromUrl(`eyes://connect#v=1&c=${CODE}`)).toBe(CODE);
  });

  it("rejects other hosts, schemes and malformed codes", () => {
    expect(codeFromUrl(`eyes://other#c=${CODE}`)).toBeNull();
    expect(codeFromUrl(`https://connect#c=${CODE}`)).toBeNull();
    expect(codeFromUrl(`eyes://connect#c=${CODE}A`)).toBeNull();
    expect(codeFromUrl(`eyes://connect#c=${CODE.slice(1)}`)).toBeNull();
    expect(codeFromUrl(`eyes://connect#xc=${CODE}`)).toBeNull();
    expect(codeFromUrl("eyes://connect")).toBeNull();
  });
});

describe("settle", () => {
  const g = (granted: boolean, canAskAgain = true) => ({ granted, canAskAgain });
  const env = (o: Partial<Env> = {}) => {
    const calls: string[] = [];
    const shown: State[] = [];
    const log =
      <T>(name: string, v: T) =>
      async () => {
        calls.push(name);
        return v;
      };
    const e: Env = {
      code: log("code", CODE),
      paused: log("paused", false),
      fg: log("fg", g(false)),
      askFg: log("askFg", g(true)),
      bg: log("bg", g(false)),
      askBg: log("askBg", g(true)),
      sharing: log("sharing", false),
      start: log("start", undefined),
      sendNow: log("sendNow", undefined),
      show: (s) => void shown.push(s),
      ...o,
    };
    return { e, calls, shown };
  };

  it("asks While Using, shares and sends before asking Always (one tap to sharing)", async () => {
    const { e, calls, shown } = env();
    expect(await settle(e)).toEqual({ view: "sharing", always: true });
    expect(calls).toEqual(["code", "paused", "fg", "askFg", "sharing", "start", "bg", "sendNow", "askBg"]);
    expect(shown).toEqual([
      { view: "sharing", always: false },
      { view: "sharing", always: true },
    ]);
  });

  it("keeps sharing when Always is declined, and skips the Always ask when told to", async () => {
    expect(await settle(env({ askBg: async () => g(false) }).e)).toEqual({ view: "sharing", always: false });
    const { e, calls } = env({ fg: async () => g(true) });
    expect(await settle(e, false)).toEqual({ view: "sharing", always: false });
    expect(calls).not.toContain("askBg");
    expect(calls).not.toContain("askFg");
  });

  it("does not restart running updates or re-ask a granted Always", async () => {
    const { e, calls } = env({ fg: async () => g(true), sharing: async () => true, bg: async () => g(true) });
    expect(await settle(e)).toEqual({ view: "sharing", always: true });
    expect(calls).not.toContain("start");
    expect(calls).not.toContain("askBg");
    const never = env({ fg: async () => g(true), bg: async () => g(false, false) });
    await settle(never.e);
    expect(never.calls).not.toContain("askBg");
  });

  it("stops early without a code, when paused, or without foreground permission", async () => {
    expect(await settle(env({ code: async () => null }).e)).toEqual({ view: "code" });
    expect(await settle(env({ paused: async () => true }).e)).toEqual({ view: "paused" });
    expect(await settle(env({ askFg: async () => g(false, false) }).e)).toEqual({ view: "denied" });
    expect(await settle(env({ askFg: async () => g(false, true) }).e)).toEqual({ view: "ask" });
    const denied = env({ fg: async () => g(false, false) });
    expect(await settle(denied.e)).toEqual({ view: "denied" });
    expect(denied.calls).not.toContain("askFg");
    expect(denied.shown).toEqual([{ view: "denied" }]);
  });
});
