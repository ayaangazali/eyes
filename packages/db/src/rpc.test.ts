import { type DbConfig, EyesError } from "@eyes/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRpc, pgSafe } from "./rpc.ts";

const { unsafe, postgresCtor } = vi.hoisted(() => ({ unsafe: vi.fn(), postgresCtor: vi.fn() }));
vi.mock("postgres", () => ({ default: postgresCtor }));

const insforge: DbConfig = { kind: "insforge", base_url: "https://db.example.test", api_key: "ik_test_key" };
const pgUrl = "postgres://test:test@127.0.0.1:1/test";
const pg: DbConfig = { kind: "postgres", url: pgUrl };

function stubFetch(status: number, text: string) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(text, { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected rejection");
}

describe("createRpc over InsForge", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the args as JSON to the rpc path with the API key and returns the rows", async () => {
    const fetch = stubFetch(200, JSON.stringify([{ id: 1 }]));
    const rows = await createRpc(insforge)("eyes_thing", { p_limit: 5 });
    expect(rows).toEqual([{ id: 1 }]);
    expect(fetch).toHaveBeenCalledWith(
      "https://db.example.test/api/database/rpc/eyes_thing",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer ik_test_key", "Content-Type": "application/json" },
        body: JSON.stringify({ p_limit: 5 }),
      }),
    );
  });

  it("throws a plain Error with InsForge's message on HTTP failure when no eyes code is present", async () => {
    stubFetch(500, JSON.stringify({ message: "database is asleep" }));
    const err = await errorOf(createRpc(insforge)("eyes_thing", {}));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EyesError);
    expect((err as Error).message).toBe("database is asleep");
  });

  it("falls back to the HTTP status when the failure body is not JSON", async () => {
    stubFetch(502, "<html>bad gateway</html>");
    const err = await errorOf(createRpc(insforge)("eyes_thing", {}));
    expect((err as Error).message).toBe("InsForge rpc eyes_thing failed with HTTP 502");
  });

  it("maps an eyes:<code> message with JSON context to EyesError", async () => {
    stubFetch(400, JSON.stringify({ message: 'eyes:invalid_input {"issues":["name"]}' }));
    const err = await errorOf(createRpc(insforge)("eyes_thing", {}));
    expect(err).toBeInstanceOf(EyesError);
    expect(err).toMatchObject({ code: "invalid_input", status: 400, context: { issues: ["name"] } });
  });

  it("maps a bare eyes:<code> message to EyesError with empty context", async () => {
    stubFetch(401, JSON.stringify({ message: "eyes:unauthorized" }));
    const err = await errorOf(createRpc(insforge)("eyes_thing", {}));
    expect(err).toMatchObject({ code: "unauthorized", status: 401, context: {} });
  });

  it("passes network failures through untouched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const err = await errorOf(createRpc(insforge)("eyes_thing", {}));
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(EyesError);
  });

  it("rethrows non-Error rejections untouched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject("socket hang up")),
    );
    const err = await errorOf(createRpc(insforge)("eyes_thing", {}));
    expect(err).toBe("socket hang up");
  });
});

describe("createRpc over Postgres", () => {
  beforeEach(() => {
    unsafe.mockReset();
    postgresCtor.mockReset();
    postgresCtor.mockReturnValue({ unsafe });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens the connection with the url and calls the function with named positional params", async () => {
    unsafe.mockResolvedValue([{ r: { ok: true } }]);
    const rows = await createRpc(pg)("eyes_dashboard_feed", { p_limit: 50, p_kind: "x" });
    expect(postgresCtor).toHaveBeenCalledWith(pgUrl, expect.any(Object));
    expect(unsafe).toHaveBeenCalledWith(
      "select to_jsonb(r) as r from eyes_dashboard_feed(p_limit => $1, p_kind => $2) r",
      [50, "x"],
    );
    expect(rows).toEqual([{ ok: true }]);
  });

  it("maps an eyes:<code> error raised inside Postgres to EyesError", async () => {
    unsafe.mockRejectedValue(new Error('eyes:task_already_claimed {"task_id":"t1"}'));
    const err = await errorOf(createRpc(pg)("eyes_claim", { p_task: "t1" }));
    expect(err).toMatchObject({ code: "task_already_claimed", context: { task_id: "t1" } });
  });

  it("rethrows connection errors untouched", async () => {
    unsafe.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:1"));
    const err = await errorOf(createRpc(pg)("eyes_claim", {}));
    expect(err).not.toBeInstanceOf(EyesError);
    expect((err as Error).message).toBe("connect ECONNREFUSED 127.0.0.1:1");
  });

  it("swallows Postgres notices so they never reach the console", () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    createRpc(pg);
    const options = postgresCtor.mock.calls[0]?.[1] as { onnotice: (notice: unknown) => void };
    options.onnotice({ message: "NOTICE: function already exists" });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const spy of spies) spy.mockRestore();
  });
});

describe("pgSafe", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("drops NUL and replaces lone surrogates in nested strings and keys, keeping everything else", () => {
    const when = new Date(0);
    const input = {
      "k\u0000": "a\u0000b",
      emoji: "\u{1F4CD} ok",
      lone: "x\ud800y",
      list: [{ deep: "\u0000\u0000" }, 7, null, true],
      when,
    };
    expect(pgSafe(input)).toEqual({
      k: "ab",
      emoji: "\u{1F4CD} ok",
      lone: "x\ufffdy",
      list: [{ deep: "" }, 7, null, true],
      when,
    });
    expect(pgSafe(input).when).toBe(when);
  });

  it("sanitizes every arg before it goes over the wire", async () => {
    const fetch = stubFetch(200, "[]");
    await createRpc(insforge)("eyes_append_ticket", { p_message: "loc\u0000" });
    expect(fetch.mock.calls[0]?.[1].body).toBe('{"p_message":"loc"}');
  });
});
