import { AppConfig, type EyesService, fakeProviders } from "@eyes/core";
import type { Rpc } from "@eyes/db";
import { createEventLog } from "@eyes/web-dashboard";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "./server.ts";

const ORIGIN = "http://api.eyes.test";
const PHONE = "+15555550100";
const EMAIL = "ops@example.com";
const TASK_ID = "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b";
const OPS_KEY = "ops-5f2c9a1e7b3d4c8a9e0f1a2b3c4d5e6f";
type Entry = { id: string; kind: string; value: string; added_by: string; added_at: string };
type Code = { identifier: string; code_hash: string; expires_at: string; attempts: number };
type Args = Record<string, string>;

/** ops_allowlist and ops_codes in memory, with the same semantics as the SQL functions in 015. */
function setup(values = [PHONE, EMAIL]) {
  const allowlist: Entry[] = values.map((value, i) => ({
    id: `entry-${i}`,
    kind: value.includes("@") ? "email" : "phone",
    value,
    added_by: "seed",
    added_at: "2026-10-17T19:00:00.000Z",
  }));
  const codes = new Map<string, Code>();
  const calls: string[] = [];
  const rpc = (async (fn: string, a: Args) => {
    calls.push(fn);
    if (fn === "eyes_ops_allowlist") return allowlist.map((e) => ({ ...e }));
    if (fn === "eyes_ops_allowlist_add") {
      if (!allowlist.some((e) => e.value === a.p_value)) {
        allowlist.push({
          id: `entry-${allowlist.length}`,
          kind: a.p_kind ?? "",
          value: a.p_value ?? "",
          added_by: a.p_added_by ?? "",
          added_at: "",
        });
      }
      return allowlist.filter((e) => e.value === a.p_value);
    }
    if (fn === "eyes_ops_allowlist_remove") {
      const i = allowlist.findIndex((e) => e.id === a.p_id);
      return i < 0 ? [] : allowlist.splice(i, 1);
    }
    if (fn === "eyes_ops_code_put") {
      const row = {
        identifier: a.p_identifier ?? "",
        code_hash: a.p_code_hash ?? "",
        expires_at: a.p_expires_at ?? "",
        attempts: 0,
      };
      codes.set(row.identifier, row);
      return [row];
    }
    if (fn === "eyes_ops_code_attempt") {
      const row = codes.get(a.p_identifier ?? "");
      if (row) row.attempts++;
      return row ? [{ ...row }] : [];
    }
    if (fn === "eyes_ops_code_delete") return codes.delete(a.p_identifier ?? "") ? [] : [];
    if (fn === "eyes_dashboard_feed") return [{ tasks: [], ledger: [], workers: [], totals: {} }];
    throw new Error(`unexpected rpc ${fn}`);
  }) as Rpc;
  const providers = fakeProviders();
  const resolveTask = vi.fn(async () => ({}));
  const resolveTicket = vi.fn(async ({ ticket_id }: { ticket_id: number }) => ({
    ticket_id,
    task_id: TASK_ID,
    status: "resolved" as const,
  }));
  const confirmFraud = vi.fn(async ({ ticket_id }: { ticket_id: number }) => ({
    ticket_id,
    task_id: TASK_ID,
    dispute_status: "upheld",
    agent_refund_cents: 350,
    reversal: "owed",
    reversal_owed_cents: 300,
    worker_banned: true,
    already_resolved: false,
  }));
  const events = createEventLog();
  const server = createServer({
    service: { resolveTask, resolveTicket, confirmFraud } as unknown as EyesService,
    providers,
    config: AppConfig.parse({
      public_api_url: ORIGIN,
      worker_web_url: "http://worker.eyes.test",
      link_secret: "x".repeat(32),
    }),
    env: { EYES_OPS_KEY: OPS_KEY },
    rpc,
    events,
  });
  const fetch = (path: string, init?: RequestInit) => server.fetch(new Request(`${ORIGIN}${path}`, init));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(path, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.9",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  /** The code inside the newest text or email to `to`. */
  // Sends are fire-and-forget, but the fakes record synchronously, before the response returns.
  const codeFor = (to: string) => {
    const sent = [
      ...providers.messaging.outbox.map((m) => ({ to: m.to, text: String(m.payload) })),
      ...providers.email.outbox.map((m) => ({ to: m.to, text: m.text ?? "" })),
    ].filter((m) => m.to === to);
    return /\b\d{6}\b/.exec(sent.at(-1)?.text ?? "")?.[0] ?? "";
  };
  const signIn = async (identifier = PHONE) => {
    await post("/ops/login/code", { identifier });
    const res = await post("/ops/login/verify", { identifier, code: await codeFor(identifier) });
    expect(res.status).toBe(200);
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  return {
    fetch,
    post,
    codeFor,
    signIn,
    providers,
    calls,
    allowlist,
    events,
    resolveTask,
    resolveTicket,
    confirmFraud,
  };
}

describe("ops sign-in", () => {
  it("answers an allowlisted and a stranger's identifier identically, and only texts the allowlisted one", async () => {
    const { post, providers, calls } = setup();
    const listed = await post("/ops/login/code", { identifier: "(555) 555-0100" });
    const stranger = await post(
      "/ops/login/code",
      { identifier: "+14155550123" },
      { "cf-connecting-ip": "198.51.100.1" },
    );
    expect(listed.status).toBe(stranger.status);
    expect(await listed.text()).toBe(await stranger.text());
    expect(providers.messaging.outbox.map((m) => m.to)).toEqual([PHONE]);
    expect(calls.filter((fn) => fn === "eyes_ops_code_put")).toHaveLength(1);
  });

  it("signs in with the emailed code once, into a 12 h HttpOnly Secure SameSite=Strict cookie", async () => {
    const { post, fetch, codeFor } = setup();
    await post("/ops/login/code", { identifier: "Ops@Example.com" });
    const code = await codeFor(EMAIL);
    expect(code).toMatch(/^\d{6}$/);
    const ok = await post("/ops/login/verify", { identifier: EMAIL, code });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(
      /^__Host-eyes_ops=[^;]+; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
    );
    const feed = await fetch("/ops/feed", { headers: { cookie: cookie.split(";")[0] ?? "" } });
    expect(feed.status).toBe(200);
    expect((await feed.json()).ops.operator).toBe("***@example.com");
    expect((await post("/ops/login/verify", { identifier: EMAIL, code })).status).toBe(401);
  });

  it("logs a failed code send so ops can see it", async () => {
    const { post, providers, events } = setup();
    providers.email.send = async () => {
      throw new Error("primitive down");
    };
    await post("/ops/login/code", { identifier: EMAIL });
    expect(events.recent()).toContainEqual(
      expect.objectContaining({ kind: "auth", level: "error", summary: "login code send failed" }),
    );
  });

  it("rejects a code after 10 minutes", async () => {
    const { post, codeFor, providers } = setup();
    await post("/ops/login/code", { identifier: PHONE });
    const code = await codeFor(PHONE);
    providers.clock.advance(10 * 60 * 1000);
    expect((await post("/ops/login/verify", { identifier: PHONE, code })).status).toBe(401);
  });

  it("locks the code after 5 wrong guesses, even for the right one", async () => {
    const { post, codeFor } = setup();
    await post("/ops/login/code", { identifier: PHONE });
    const code = await codeFor(PHONE);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++)
      expect((await post("/ops/login/verify", { identifier: PHONE, code: wrong })).status).toBe(401);
    expect((await post("/ops/login/verify", { identifier: PHONE, code })).status).toBe(401);
  });

  it("rate limits per client IP and per identifier", async () => {
    const { post } = setup();
    for (let i = 0; i < 10; i++) {
      expect(
        (await post("/ops/login/code", { identifier: `+1415555${String(i).padStart(4, "0")}` })).status,
      ).toBe(200);
    }
    expect((await post("/ops/login/code", { identifier: "+14155559999" })).status).toBe(429);
    for (let i = 0; i < 10; i++) {
      await post("/ops/login/code", { identifier: PHONE }, { "cf-connecting-ip": `198.51.100.${i}` });
    }
    expect(
      (await post("/ops/login/code", { identifier: PHONE }, { "cf-connecting-ip": "192.0.2.1" })).status,
    ).toBe(429);
  });

  it("rejects sign-in and logout posts from another origin or none", async () => {
    const { post } = setup();
    for (const origin of ["https://evil.test", ""]) {
      expect((await post("/ops/login/code", { identifier: PHONE }, { origin })).status).toBe(403);
      expect((await post("/ops/logout", {}, { origin })).status).toBe(403);
    }
  });
});

describe("ops allowlist", () => {
  it("lists entries masked, adds a phone or email and rejects anything else", async () => {
    const { fetch, post, signIn, allowlist } = setup();
    const cookie = await signIn();
    const list = await (await fetch("/ops/allowlist", { headers: { cookie } })).json();
    expect(list.entries.map((e: Entry) => e.value)).toEqual(["***0100", "***@example.com"]);
    expect((await post("/ops/allowlist", { identifier: "+14155550123" }, { cookie })).status).toBe(200);
    expect((await post("/ops/allowlist", { identifier: "ops@eyes.pictures" }, { cookie })).status).toBe(200);
    expect((await post("/ops/allowlist", { identifier: "not a phone" }, { cookie })).status).toBe(400);
    expect(allowlist.map((e) => [e.value, e.added_by])).toEqual([
      [PHONE, "seed"],
      [EMAIL, "seed"],
      ["+14155550123", "***0100"],
      ["ops@eyes.pictures", "***0100"],
    ]);
  });

  it("removes another entry but never yourself or the last one", async () => {
    const { post, signIn, allowlist, fetch } = setup();
    const cookie = await signIn();
    expect((await post("/ops/allowlist/remove", { id: "entry-0" }, { cookie })).status).toBe(400);
    expect((await post("/ops/allowlist/remove", { id: "entry-1" }, { cookie })).status).toBe(200);
    expect(allowlist.map((e) => e.value)).toEqual([PHONE]);

    const glass = await fetch(`/ops/${OPS_KEY}`);
    const breakGlass = (glass.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await post("/ops/allowlist/remove", { id: "entry-0" }, { cookie: breakGlass })).status).toBe(400);
    expect(allowlist.map((e) => e.value)).toEqual([PHONE]);
  });

  it("needs a session and the right origin to change anything", async () => {
    const { post, signIn, allowlist } = setup();
    expect((await post("/ops/allowlist", { identifier: "+14155550123" })).status).toBe(401);
    const cookie = await signIn();
    expect(
      (await post("/ops/allowlist", { identifier: "+14155550123" }, { cookie, origin: "https://evil.test" }))
        .status,
    ).toBe(403);
    expect(allowlist).toHaveLength(2);
  });
});

describe("ops ticket actions", () => {
  const body = { task_id: TASK_ID, note: "Photo shows the line." };

  it("need a session and the right origin", async () => {
    const { post, signIn, resolveTask, resolveTicket } = setup();
    expect((await post("/ops/tickets/7/release", body)).status).toBe(401);
    const cookie = await signIn();
    expect((await post("/ops/tickets/7/release", body, { cookie, origin: "https://evil.test" })).status).toBe(
      403,
    );
    expect(resolveTask).not.toHaveBeenCalled();
    expect(resolveTicket).not.toHaveBeenCalled();
  });

  it("release and refund move money through resolveTask, then close the ticket; close moves no money", async () => {
    const { post, signIn, resolveTask, resolveTicket, events } = setup();
    const cookie = await signIn();
    for (const action of ["release", "refund", "close"] as const) {
      const res = await post(`/ops/tickets/7/${action}`, body, { cookie });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ticket_id: 7, task_id: TASK_ID, status: "resolved" });
      expect(resolveTicket).toHaveBeenLastCalledWith({ ticket_id: 7, outcome: action, note: body.note });
    }
    expect(resolveTask.mock.calls).toEqual([
      [TASK_ID, "release", body.note],
      [TASK_ID, "refund", body.note],
    ]);
    expect(events.recent()).toContainEqual(
      expect.objectContaining({ kind: "ops", summary: "ticket #7 close by ***0100" }),
    );
  });

  it("rejects an action without a note", async () => {
    const { post, signIn, resolveTicket } = setup();
    const cookie = await signIn();
    expect((await post("/ops/tickets/7/close", { task_id: TASK_ID, note: " " }, { cookie })).status).toBe(
      400,
    );
    expect(resolveTicket).not.toHaveBeenCalled();
  });

  it("confirm_fraud needs a session, the right origin and a note, then logs the outcome", async () => {
    const { post, signIn, confirmFraud, events } = setup();
    expect((await post("/ops/tickets/9/confirm_fraud", { note: "fake" })).status).toBe(401);
    const cookie = await signIn();
    const evil = { cookie, origin: "https://evil.test" };
    expect((await post("/ops/tickets/9/confirm_fraud", { note: "fake" }, evil)).status).toBe(403);
    expect((await post("/ops/tickets/9/confirm_fraud", { note: " " }, { cookie })).status).toBe(400);
    expect(confirmFraud).not.toHaveBeenCalled();
    const res = await post("/ops/tickets/9/confirm_fraud", { note: "fake" }, { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ticket_id: 9, reversal: "owed", already_resolved: false });
    expect(confirmFraud).toHaveBeenCalledWith({ ticket_id: 9, note: "fake" });
    expect(events.recent()).toContainEqual(
      expect.objectContaining({ kind: "ops", level: "warn", summary: "ticket #9 confirm_fraud by ***0100" }),
    );
  });
});
