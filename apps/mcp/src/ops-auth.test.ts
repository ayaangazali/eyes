import { AppConfig, EyesError, type EyesService, fakeProviders, signToken } from "@eyes/core";
import type { Rpc } from "@eyes/db";
import { createEventLog } from "@eyes/web-dashboard";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "./server.ts";

const ORIGIN = "http://api.eyes.test";
// The dashboard's own host: `/x` there is `/ops/x` on loopback.
const OPS = "http://internal.eyes.test";
const PHONE = "+15555550100";
const EMAIL = "ops@example.com";
const TASK_ID = "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b";
const OPS_KEY = "ops-5f2c9a1e7b3d4c8a9e0f1a2b3c4d5e6f";
type Entry = {
  id: string;
  kind: string;
  value: string;
  added_by: string;
  added_at: string;
  invite_status?: string | null;
  invite_at?: string | null;
  invite_day?: string | null;
  invites_today?: number;
};
type Code = { identifier: string; code_hash: string; expires_at: string; attempts: number };
type Args = Record<string, string>;

/** ops_allowlist and ops_codes in memory, with the same semantics as the SQL functions in 015. */
function setup(values = [PHONE, EMAIL], env: Record<string, string> = { EYES_OPS_KEY: OPS_KEY }) {
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
    if (fn === "eyes_manual_ticket")
      return [{ id: a.p_ticket_id, task_id: a.p_task_id, kind: "manual_review" }];
    // 031: 3 invites per entry per UTC day.
    if (fn === "eyes_ops_invite_take") {
      const e = allowlist.find((x) => x.id === a.p_id);
      const day = (a.p_now ?? "").slice(0, 10);
      if (!e || (e.invite_day === day && (e.invites_today ?? 0) >= 3)) return [];
      e.invites_today = e.invite_day === day ? (e.invites_today ?? 0) + 1 : 1;
      e.invite_day = day;
      return [{ ...e }];
    }
    if (fn === "eyes_ops_invite_record") {
      const e = allowlist.find((x) => x.id === a.p_id);
      if (!e) return [];
      Object.assign(e, { invite_status: a.p_status, invite_at: a.p_now });
      return [{ ...e }];
    }
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
    env,
    rpc,
    events,
  });
  const fetch = (path: string, init?: RequestInit) =>
    server.fetch(new Request(`${OPS}${path.replace(/^\/ops(?=\/|$)/, "") || "/"}`, init));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(path, {
      method: "POST",
      headers: {
        origin: OPS,
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

  it("invites who is added: a sign-in link by text or email, never a code; refused emails become a copy link", async () => {
    const { fetch, post, signIn, providers, events, allowlist } = setup();
    const cookie = await signIn();
    const add = async (identifier: string) =>
      (await (await post("/ops/allowlist", { identifier }, { cookie })).json()).entry;
    const phone = await add("+14155550123");
    expect(phone).toMatchObject({ value: "***0123", invite_status: "sent", invites_left: 2, self: false });
    const text = providers.messaging.outbox.at(-1);
    expect([text?.to, text?.payload]).toEqual([
      "+14155550123",
      "You've been added to Eyes ops. Sign in: http://internal.eyes.test/login",
    ]);
    expect(String(text?.payload)).not.toMatch(/\b\d{6}\b/);
    const email = await add("new@eyes.pictures");
    expect(email.invite_status).toBe("sent");
    expect(providers.email.outbox.at(-1)).toMatchObject({
      to: "new@eyes.pictures",
      subject: "You've been added to Eyes ops",
    });

    // Primitive refuses people who never emailed us (403 recipient_not_allowed, or a gate_denied send).
    const refuse = (err: Error) => vi.spyOn(providers.email, "send").mockRejectedValueOnce(err);
    refuse(
      Object.assign(new Error("recipient not allowed"), { status: 403, gates: [{ name: "known_address" }] }),
    );
    expect((await add("stranger@example.org")).invite_status).toBe("copy");
    refuse(new Error("Primitive send gate_denied (request r1)"));
    expect((await add("other@example.org")).invite_status).toBe("copy");
    refuse(new Error("socket hang up"));
    expect((await add("third@example.org")).invite_status).toBe("failed");
    vi.spyOn(providers.messaging, "sendText").mockRejectedValueOnce(new Error("inkbox down"));
    expect((await add("+14155550124")).invite_status).toBe("failed");

    const list = await (await fetch("/ops/allowlist", { headers: { cookie } })).json();
    expect(list.login_url).toBe("http://internal.eyes.test/login");
    expect(list.entries.map((e: { invite_status: string | null }) => e.invite_status ?? null)).toEqual([
      null,
      null,
      "sent",
      "sent",
      "copy",
      "copy",
      "failed",
      "failed",
    ]);
    // Resend: up to 3 a day per entry, then 429; an unknown entry is a 400.
    const id = allowlist.find((e) => e.value === "+14155550123")?.id;
    const resend = () => post("/ops/allowlist/invite", { id }, { cookie });
    expect((await (await resend()).json()).entry.invites_left).toBe(1);
    expect((await (await resend()).json()).entry.invites_left).toBe(0);
    const limited = await resend();
    expect([limited.status, (await limited.json()).error]).toEqual([429, "rate_limited"]);
    expect((await post("/ops/allowlist/invite", { id: "nope" }, { cookie })).status).toBe(400);
    expect(
      events
        .recent()
        .filter((e) => e.summary.startsWith("ops invite"))
        .map((e) => [e.summary, e.level]),
    ).toContainEqual(["ops invite failed", "warn"]);
    expect(JSON.stringify(events.recent())).not.toContain("+14155550123");
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

describe("ops review panel", () => {
  it("resolve needs a session and the right origin", async () => {
    const { post, signIn, resolveTask } = setup();
    expect((await post(`/ops/tasks/${TASK_ID}/resolve`, { outcome: "release" })).status).toBe(401);
    const cookie = await signIn();
    const evil = { cookie, origin: "https://evil.test" };
    expect((await post(`/ops/tasks/${TASK_ID}/resolve`, { outcome: "release" }, evil)).status).toBe(403);
    expect((await post(`/ops/tasks/${TASK_ID}/resolve`, { outcome: "pay" }, { cookie })).status).toBe(400);
    expect(resolveTask).not.toHaveBeenCalled();
  });

  it("releases once; a second click finds it paid, moves no money and says so", async () => {
    const { post, signIn, resolveTask, events } = setup();
    const cookie = await signIn();
    resolveTask
      .mockImplementationOnce(async () => ({ task_id: TASK_ID, status: "paid" }))
      .mockImplementationOnce(async () => {
        throw new EyesError("invalid_input", { status: "paid" });
      });
    const first = await post(
      `/ops/tasks/${TASK_ID}/resolve`,
      { outcome: "release", note: "Sign is visible." },
      { cookie },
    );
    expect(await first.json()).toEqual({ task_id: TASK_ID, status: "paid", already_resolved: false });
    const again = await post(`/ops/tasks/${TASK_ID}/resolve`, { outcome: "refund" }, { cookie });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ task_id: TASK_ID, status: "paid", already_resolved: true });
    expect(resolveTask.mock.calls).toEqual([
      [TASK_ID, "release", "Sign is visible."],
      [TASK_ID, "refund", "refund from the ops review panel by ***0100"],
    ]);
    expect(events.recent().map((e) => e.summary)).toEqual(
      expect.arrayContaining(["task release by ***0100", "task refund by ***0100 (already resolved)"]),
    );
  });

  it("passes other failures through instead of calling them resolved", async () => {
    const { post, signIn, resolveTask } = setup();
    const cookie = await signIn();
    resolveTask.mockImplementationOnce(async () => {
      throw new EyesError("invalid_input", { status: "dispatched" });
    });
    expect((await post(`/ops/tasks/${TASK_ID}/resolve`, { outcome: "refund" }, { cookie })).status).toBe(400);
  });
});

describe("ops sign-in and allowlist from a browser form", () => {
  const form = (fetch: ReturnType<typeof setup>["fetch"], path: string, fields: Args, headers: Args = {}) =>
    fetch(path, {
      method: "POST",
      headers: {
        origin: OPS,
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.9",
        ...headers,
      },
      body: new URLSearchParams(fields),
    });

  it("walks login page → code → wrong code → right code → allowlist → add → remove → logout in HTML", async () => {
    const { fetch, codeFor, allowlist } = setup();
    const login = await fetch("/ops/login");
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('action="/login/code"');

    const sent = await form(fetch, "/ops/login/code", { identifier: PHONE });
    expect(sent.status).toBe(200);
    const sentPage = await sent.text();
    expect(sentPage).toContain('action="/login/verify"');
    expect(sentPage).toContain(`value="${PHONE}"`);

    const code = codeFor(PHONE);
    const wrong = await form(fetch, "/ops/login/verify", {
      identifier: PHONE,
      code: code === "000000" ? "1" : "0",
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('role="alert"');

    const ok = await form(fetch, "/ops/login/verify", { identifier: PHONE, code });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/");
    const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    // The allowlist is the dashboard's Access tab now: the old page address goes there.
    const page = await fetch("/ops/allowlist", { headers: { cookie, accept: "text/html" } });
    expect([page.status, page.headers.get("location")]).toEqual([301, "/#access"]);
    const list = await fetch("/ops/allowlist", { headers: { cookie, accept: "application/json" } });
    const { entries } = (await list.json()) as { entries: { id: string; value: string; self: boolean }[] };
    expect(JSON.stringify(entries)).not.toContain(PHONE);
    expect(entries.map((e) => [e.value, e.self])).toEqual([
      ["***0100", true],
      ["***@example.com", false],
    ]);
    // Form posts get JSON answers; the dashboard posts JSON.
    const bad = await form(fetch, "/ops/allowlist", { identifier: "nope" }, { cookie });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toContain(
      "Enter a phone number with its country code",
    );
    const added = await form(fetch, "/ops/allowlist", { identifier: "+14155550123" }, { cookie });
    expect(added.status).toBe(200);
    const gone = await form(fetch, "/ops/allowlist/remove", { id: "missing" }, { cookie });
    expect(gone.status).toBe(400);
    expect(((await gone.json()) as { message: string }).message).toContain(
      "No allowlist entry with this id.",
    );
    const removed = await form(fetch, "/ops/allowlist/remove", { id: "entry-2" }, { cookie });
    expect([removed.status, await removed.json()]).toEqual([200, { ok: true }]);
    expect(allowlist.map((e) => e.value)).toEqual([PHONE, EMAIL]);

    const out = await form(fetch, "/ops/logout", {}, { cookie });
    expect([out.status, out.headers.get("location")]).toEqual([303, "/login"]);
    expect(out.headers.get("set-cookie")).toContain("__Host-eyes_ops=;");
  });

  it("answers logout over JSON and shows the rate-limit page in HTML", async () => {
    const { fetch, post } = setup();
    expect(await (await post("/ops/logout", {})).json()).toEqual({ ok: true });
    for (let i = 0; i < 10; i++)
      await form(fetch, "/ops/login/verify", { identifier: PHONE, code: "123456" });
    const limited = await form(fetch, "/ops/login/verify", { identifier: PHONE, code: "123456" });
    expect(limited.status).toBe(429);
    expect(await limited.text()).toMatch(/Too many sign-in tries\. Wait \d+ minutes/);
  });

  it("treats unparseable or non-string identifiers as invalid without telling strangers apart", async () => {
    const { fetch, post, calls } = setup();
    // A form body that cannot be parsed reads as empty: the same "code sent" page as anyone else.
    const broken = await fetch("/ops/login/code", {
      method: "POST",
      headers: {
        origin: OPS,
        "content-type": "multipart/form-data",
        "x-forwarded-for": "10.0.0.1, 198.51.100.4",
      },
      body: "--x\r\nnot a form",
    });
    expect(broken.status).toBe(200);
    expect(await broken.text()).toContain('action="/login/verify"');
    expect(await (await post("/ops/login/code", { identifier: 15555550100 })).json()).toMatchObject({
      ok: true,
    });
    expect((await post("/ops/login/verify", { identifier: "nobody", code: "123456" })).status).toBe(401);
    expect(calls).not.toContain("eyes_ops_code_put");
    expect(calls).not.toContain("eyes_ops_code_attempt");
  });

  it("keys the limit on the last X-Forwarded-For hop, or on nothing, when Cloudflare sends no client IP", async () => {
    const { fetch } = setup();
    const send = (headers: Args) =>
      fetch("/ops/login/code", {
        method: "POST",
        headers: { origin: OPS, "content-type": "application/json", ...headers },
        body: JSON.stringify({ identifier: "+14155550123" }),
      });
    for (let i = 0; i < 10; i++) await send({ "x-forwarded-for": `10.0.0.${i}, 198.51.100.4` });
    expect((await send({ "x-forwarded-for": "198.51.100.4" })).status).toBe(429);
    expect((await send({})).status).toBe(429);
  });

  it("reads a bodiless or non-object JSON post as empty, and answers a session-less HTML post 401", async () => {
    const { fetch, post } = setup();
    const bare = await fetch("/ops/login/code", { method: "POST", headers: { origin: OPS } });
    expect(bare.status).toBe(200);
    expect(await bare.text()).toContain('action="/login/verify"');
    expect(await (await post("/ops/login/code", null)).json()).toMatchObject({ ok: true });
    const denied = await form(fetch, "/ops/allowlist", { identifier: "+14155550123" });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "unauthorized" });
  });

  it("forgets rate-limit keys an hour old", async () => {
    const { post, providers } = setup();
    for (let i = 0; i < 10; i++) await post("/ops/login/code", { identifier: "+14155550123" });
    expect((await post("/ops/login/code", { identifier: "+14155550123" })).status).toBe(429);
    providers.clock.advance(60 * 60 * 1000 + 1);
    expect((await post("/ops/login/code", { identifier: "+14155550123" })).status).toBe(200);
  });

  it("logs a send failure that is not an Error by its type", async () => {
    const { post, providers, events } = setup();
    providers.messaging.sendText = () => Promise.reject("busy");
    await post("/ops/login/code", { identifier: PHONE });
    await vi.waitFor(() =>
      expect(events.recent()).toContainEqual(
        expect.objectContaining({
          summary: "login code send failed",
          data: expect.objectContaining({ error: "string" }),
        }),
      ),
    );
  });

  it("drops a session whose allowlist entry is gone, or a break-glass session once the key is unset", async () => {
    const { fetch, signIn, allowlist } = setup();
    const cookie = await signIn(EMAIL);
    allowlist.splice(1, 1);
    expect((await fetch("/ops/feed", { headers: { cookie } })).status).toBe(401);

    const token = signToken("x".repeat(32), "ops:break-glass", new Date(Date.parse("2026-10-18T00:00:00Z")));
    const off = setup([PHONE], {});
    expect((await off.fetch("/ops/feed", { headers: { cookie: `__Host-eyes_ops=${token}` } })).status).toBe(
      401,
    );
  });
});
