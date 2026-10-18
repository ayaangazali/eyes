import { describe, expect, it } from "vitest";
import { type Deps, isCode, type Last, onFix, postFix } from "./eyes.ts";

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
const deps = (over: Partial<Deps>) => {
  const log = { saved: [] as Last[], stopped: 0 };
  const d: Deps = {
    code: CODE,
    last: null,
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
  it("throttles to one post per 60 s unless forced, and 429 just records", async () => {
    const { f, bodies } = fakeFetch(429, 204);
    const last: Last = { at: 1_000_000 - 59_000, result: "sent", lat: 0, lng: 0 };
    expect(await onFix(fix, deps({ last, fetch: f }).d)).toBeNull();
    expect(bodies).toHaveLength(0);
    const { d, log } = deps({ last: { ...last, at: 1_000_000 - 60_000 }, fetch: f });
    expect((await onFix(fix, d))?.result).toBe("rate_limited");
    expect(log.stopped).toBe(0);
    expect((await onFix(fix, deps({ last, fetch: f }).d, true))?.result).toBe("sent");
  });

  it("401 stops updates and saves a rounded place", async () => {
    const { d, log } = deps({ fetch: fakeFetch(401).f });
    expect(await onFix(fix, d)).toEqual({ at: 1_000_000, result: "stopped", lat: 37.76, lng: -122.39 });
    expect(log.stopped).toBe(1);
  });

  it("no code stops without posting", async () => {
    const { f, bodies } = fakeFetch(204);
    const { d, log } = deps({ code: null, fetch: f });
    expect(await onFix(fix, d)).toBeNull();
    expect([bodies.length, log.stopped]).toEqual([0, 1]);
  });
});
