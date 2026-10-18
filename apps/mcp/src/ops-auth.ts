import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { type AppConfig, type Providers, signToken, verifyToken } from "@eyes/core";
import type { Rpc } from "@eyes/db";
import { PAGE_CSS, PAGE_HEADER } from "@eyes/ui/page";
import type { OpsEvent } from "@eyes/web-dashboard";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export type { OpsEvent };
export type Operator = { id: string; label: string };
export type OpsEnv = { Variables: { operator: Operator } };
type Entry = { id: string; kind: "phone" | "email"; value: string; added_by: string; added_at: string };
type Code = { identifier: string; code_hash: string; expires_at: string; attempts: number };
type Body = Record<string, unknown>;

const COOKIE = "__Host-eyes_ops";
const SESSION_S = 12 * 60 * 60;
const CODE_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const HOUR_MS = 60 * 60 * 1000;
const LOGIN_PER_HOUR = 10;
const LIMIT_MAX_KEYS = 10_000;
const BREAK_GLASS = "break-glass";
const SENT =
  "If that phone or email is on the ops list, a 6-digit code is on its way. It works for 10 minutes.";
const WRONG = "That code is wrong, used up or expired. Check it, or request a new one.";
// Referrer-Policy same-origin, not no-referrer: under no-referrer browsers send `Origin: null` on
// form posts, which sameOrigin rejects. No referrer leaves the site either way.
const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
const STYLE = `${PAGE_CSS}
body.ui { background: var(--eyes-surface-secondary); }
.wrap { padding: var(--eyes-space-8) var(--eyes-space-4) var(--eyes-space-10); }
main.ui-card { margin: 0 auto; }
.rows { display: grid; gap: var(--eyes-space-3); margin: 0; padding: 0; list-style: none; border-top: 0; }
.rows > li { display: flex; justify-content: space-between; align-items: center; gap: var(--eyes-space-3); }`;

const sha256 = (text: string) => createHash("sha256").update(text).digest();

function toE164(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  const e164 = input.trim().startsWith("+") ? `+${digits}` : `+1${digits.replace(/^1(?=\d{10}$)/, "")}`;
  return /^\+(1[2-9]\d\d[2-9]\d{6}|[2-9]\d{6,14})$/.test(e164) ? e164 : null;
}

function normalize(input: unknown): { kind: Entry["kind"]; value: string } | null {
  const text = typeof input === "string" ? input.trim() : "";
  if (text.includes("@")) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? { kind: "email", value: text.toLowerCase() } : null;
  }
  const value = toE164(text);
  return value ? { kind: "phone", value } : null;
}

/** Phone: last 4 only; email: ***@domain; anything else (seed, break-glass, a masked label) as is. */
const mask = (value: string) =>
  value.includes("@")
    ? `***@${value.split("@").at(-1)}`
    : value.startsWith("+")
      ? `***${value.slice(-4)}`
      : value;

const view = (e: Entry) => ({ ...e, value: mask(e.value), added_by: mask(e.added_by) });

async function readBody(c: Context): Promise<{ json: boolean; body: Body }> {
  const json = c.req.header("content-type")?.includes("application/json") ?? false;
  const body = await (json ? c.req.json() : c.req.parseBody()).catch(() => ({}));
  return { json, body: body && typeof body === "object" ? (body as Body) : {} };
}

const text = (value: unknown) => (typeof value === "string" ? value.trim().slice(0, 200) : "");
const wantsHtml = (c: Context) => c.req.header("accept")?.includes("text/html") ?? false;

const page = (title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) => html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="icon" href="data:,">
<style>${raw(STYLE)}</style>
</head>
<body class="ui">${raw(PAGE_HEADER)}<div class="wrap"><main class="ui-card">${body}</main></div></body>
</html>
`;

const alert = (error?: string) =>
  error ? html`<p class="ui-notice ui-notice--danger" role="alert">${error}</p>` : "";

const loginPage = (identifier?: string, error?: string) =>
  page(
    "Eyes ops sign-in",
    html`<h1 class="ui-h2">Eyes ops sign-in</h1>
${alert(error)}
${
  identifier === undefined
    ? html`<form class="ui-form" method="post" action="/ops/login/code">
<label class="ui-field"><span class="ui-field__label">Phone or email</span>
<input class="ui-input" name="identifier" autocomplete="username" required autofocus></label>
<button class="ui-button ui-button--primary ui-button--block">Send code</button>
</form>`
    : html`<p class="ui-field__hint">${SENT}</p>
<form class="ui-form" method="post" action="/ops/login/verify">
<input type="hidden" name="identifier" value="${identifier}">
<label class="ui-field"><span class="ui-field__label">6-digit code</span>
<input class="ui-input" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>
<button class="ui-button ui-button--primary ui-button--block">Sign in</button>
</form>
<p class="ui-field__hint"><a class="ui-link" href="/ops/login">Use another phone or email</a></p>`
}`,
  );

const allowlistPage = (entries: Entry[], op: Operator, error?: string) =>
  page(
    "Eyes ops allowlist",
    html`<h1 class="ui-h2">Who can sign in to ops</h1>
<p class="ui-field__hint">Signed in as ${op.label}. <a class="ui-link" href="/ops">Back to the dashboard</a></p>
${alert(error)}
<ul class="rows">
${entries.map(
  (e) => html`<li><span><strong>${mask(e.value)}</strong> <span class="ui-badge">${e.kind}</span><br>
<span class="ui-field__hint">added by ${mask(e.added_by)} on ${e.added_at.slice(0, 10)}</span></span>
<form method="post" action="/ops/allowlist/remove"><input type="hidden" name="id" value="${e.id}">
<button class="ui-button ui-button--sm ui-button--ghost"${e.id === op.id ? raw(" disabled") : ""}>Remove</button></form></li>`,
)}
</ul>
<form class="ui-form" method="post" action="/ops/allowlist">
<label class="ui-field"><span class="ui-field__label">Add a phone or email</span>
<input class="ui-input" name="identifier" required placeholder="+14155550123 or name@example.com"></label>
<button class="ui-button ui-button--primary">Add</button>
</form>
<form method="post" action="/ops/logout"><button class="ui-button ui-button--sm ui-button--ghost">Sign out</button></form>`,
  );

export function opsAuth(deps: {
  rpc: Rpc;
  providers: Providers;
  config: AppConfig;
  env: Record<string, string | undefined>;
  log: (e: OpsEvent) => void;
}) {
  const { rpc, providers, config, env, log } = deps;
  const origin = new URL(config.public_api_url).origin;
  const now = () => providers.clock.now().getTime();
  const allowlist = () => rpc<Entry>("eyes_ops_allowlist", {});
  const codeHash = (identifier: string, code: string) =>
    createHmac("sha256", config.link_secret).update(`ops-code:${identifier}:${code}`).digest("hex");
  const auth = (summary: string, data: Record<string, unknown>, level: OpsEvent["level"] = "info") =>
    log({ kind: "auth", level, summary, data });

  const startSession = (c: Context, identifier: string) =>
    setCookie(
      c,
      COOKIE,
      signToken(config.link_secret, `ops:${identifier}`, new Date(now() + SESSION_S * 1000)),
      {
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/",
        maxAge: SESSION_S,
      },
    );

  // ponytail: in-memory per-process limits, like server.ts throttle; a shared store if Eyes runs more than one process.
  const hits = new Map<string, number[]>();
  const retryAfter = (key: string) => {
    const at = now();
    for (const [k, times] of hits) {
      if ((times.at(-1) ?? 0) > at - HOUR_MS && hits.size < LIMIT_MAX_KEYS) break;
      hits.delete(k);
    }
    const recent = (hits.get(key) ?? []).filter((t) => t > at - HOUR_MS);
    if (recent.length >= LOGIN_PER_HOUR) return Math.ceil(((recent[0] ?? at) + HOUR_MS - at) / 1000);
    hits.delete(key);
    hits.set(key, [...recent, at]);
    return 0;
  };
  /** Seconds to wait, or 0. Client IP: the Cloudflare proxy's header, else the address http.ts put in x-forwarded-for. */
  const limited = (c: Context, identifier: string) => {
    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
    return retryAfter(`${c.req.path} ip ${ip ?? ""}`) || retryAfter(`${c.req.path} id ${identifier}`);
  };
  const tooMany = (c: Context, json: boolean, retry_after_s: number) => {
    const message = `Too many sign-in tries. Wait ${Math.ceil(retry_after_s / 60)} minutes and try again.`;
    return json
      ? c.json({ error: "rate_limited", message, retry_after_s }, 429, HEADERS)
      : c.html(loginPage(undefined, message), 429, HEADERS);
  };

  const sameOrigin: MiddlewareHandler = async (c, next) =>
    c.req.header("origin") === origin ? next() : c.json({ error: "forbidden" }, 403);

  const operator: MiddlewareHandler<OpsEnv> = async (c, next) => {
    const payload = verifyToken(config.link_secret, getCookie(c, COOKIE) ?? "", providers.clock.now());
    const who = payload?.startsWith("ops:") ? payload.slice(4) : null;
    let op: Operator | null = null;
    if (who === BREAK_GLASS) op = env.EYES_OPS_KEY ? { id: BREAK_GLASS, label: BREAK_GLASS } : null;
    else if (who) {
      const entry = (await allowlist()).find((e) => e.value === who);
      op = entry ? { id: entry.id, label: mask(entry.value) } : null;
    }
    if (!op) {
      return c.req.method === "GET" && wantsHtml(c)
        ? c.redirect("/ops/login", 303)
        : c.json({ error: "unauthorized" }, 401);
    }
    c.set("operator", op);
    await next();
  };

  const routes = new Hono<OpsEnv>();

  routes.get("/ops/login", (c) => c.html(loginPage(), 200, HEADERS));

  routes.post("/ops/login/code", sameOrigin, async (c) => {
    const { json, body } = await readBody(c);
    const typed = text(body.identifier);
    const who = normalize(typed);
    const wait = limited(c, who?.value ?? typed.toLowerCase());
    if (wait) return tooMany(c, json, wait);
    const entry = who && (await allowlist()).find((e) => e.value === who.value);
    auth("login code requested", { identifier: mask(who?.value ?? "invalid"), allowlisted: Boolean(entry) });
    if (entry) {
      const code = String(randomInt(1_000_000)).padStart(6, "0");
      await rpc("eyes_ops_code_put", {
        p_identifier: entry.value,
        p_code_hash: codeHash(entry.value, code),
        p_expires_at: new Date(now() + CODE_MS).toISOString(),
      });
      const message = `${code} is your Eyes ops sign-in code. It expires in 10 minutes. Did not ask for it? Ignore this.`;
      // Not awaited: a slow send would tell an attacker the identifier is allowlisted.
      void (
        entry.kind === "phone"
          ? providers.messaging.sendText(entry.value, message)
          : providers.email.send({ to: entry.value, subject: "Your Eyes ops sign-in code", text: message })
      ).catch((err: unknown) =>
        auth(
          "login code send failed",
          { identifier: mask(entry.value), error: err instanceof Error ? err.name : typeof err },
          "error",
        ),
      );
    }
    return json ? c.json({ ok: true, message: SENT }, 200, HEADERS) : c.html(loginPage(typed), 200, HEADERS);
  });

  routes.post("/ops/login/verify", sameOrigin, async (c) => {
    const { json, body } = await readBody(c);
    const typed = text(body.identifier);
    const who = normalize(typed);
    const wait = limited(c, who?.value ?? typed.toLowerCase());
    if (wait) return tooMany(c, json, wait);
    const [row] = who ? await rpc<Code>("eyes_ops_code_attempt", { p_identifier: who.value }) : [];
    const given = Buffer.from(codeHash(row?.identifier ?? "", text(body.code)));
    const outcome = !row
      ? "no_code"
      : Date.parse(row.expires_at) <= now()
        ? "expired"
        : row.attempts > MAX_ATTEMPTS
          ? "locked"
          : timingSafeEqual(Buffer.from(row.code_hash), given)
            ? "ok"
            : "fail";
    auth(
      `login ${outcome}`,
      { identifier: mask(who?.value ?? "invalid") },
      outcome === "ok" ? "info" : "warn",
    );
    if (outcome !== "ok" || !row) {
      return json
        ? c.json({ error: "invalid_code", message: WRONG }, 401, HEADERS)
        : c.html(loginPage(typed, WRONG), 401, HEADERS);
    }
    await rpc("eyes_ops_code_delete", { p_identifier: row.identifier });
    startSession(c, row.identifier);
    return json ? c.json({ ok: true, redirect: "/ops" }, 200, HEADERS) : c.redirect("/ops", 303);
  });

  routes.post("/ops/logout", sameOrigin, (c) => {
    deleteCookie(c, COOKIE, { path: "/", secure: true });
    return wantsHtml(c) ? c.redirect("/ops/login", 303) : c.json({ ok: true }, 200, HEADERS);
  });

  const allowlistError = async (c: Context<OpsEnv>, json: boolean, message: string) =>
    json
      ? c.json({ error: "invalid_input", message }, 400, HEADERS)
      : c.html(allowlistPage(await allowlist(), c.get("operator"), message), 400, HEADERS);

  routes.get("/ops/allowlist", operator, async (c) => {
    const entries = await allowlist();
    return wantsHtml(c)
      ? c.html(allowlistPage(entries, c.get("operator")), 200, HEADERS)
      : c.json({ entries: entries.map(view) }, 200, HEADERS);
  });

  routes.post("/ops/allowlist", operator, sameOrigin, async (c) => {
    const { json, body } = await readBody(c);
    const who = normalize(body.identifier);
    if (!who) {
      return allowlistError(
        c,
        json,
        "Enter a phone number with its country code, like +14155550123, or an email address.",
      );
    }
    const by = c.get("operator").label;
    const [entry] = await rpc<Entry>("eyes_ops_allowlist_add", {
      p_kind: who.kind,
      p_value: who.value,
      p_added_by: by,
    });
    auth("allowlist add", { entry: mask(who.value), by });
    if (!json) return c.redirect("/ops/allowlist", 303);
    return c.json({ entry: entry && view(entry) }, 200, HEADERS);
  });

  routes.post("/ops/allowlist/remove", operator, sameOrigin, async (c) => {
    const { json, body } = await readBody(c);
    const op = c.get("operator");
    const entries = await allowlist();
    const entry = entries.find((e) => e.id === body.id);
    // ponytail: check-then-delete; two operators removing each other at the same instant could empty
    // the list. Break-glass still gets in; a locking SQL function if that ever matters.
    const problem = !entry
      ? "No allowlist entry with this id. Reload the page."
      : entry.id === op.id
        ? "You cannot remove yourself. Ask another operator to do it."
        : entries.length <= 1
          ? "You cannot remove the last entry: nobody could sign in."
          : null;
    if (problem || !entry) return allowlistError(c, json, problem ?? "");
    await rpc("eyes_ops_allowlist_remove", { p_id: entry.id });
    auth("allowlist remove", { entry: mask(entry.value), by: op.label });
    return json ? c.json({ ok: true }, 200, HEADERS) : c.redirect("/ops/allowlist", 303);
  });

  // After the static /ops/* routes; 32+ chars so it never shadows /ops/live, /ops/feed and the like.
  routes.get("/ops/:key{[^/]{32,}}", (c) => {
    const key = env.EYES_OPS_KEY;
    if (!key || !timingSafeEqual(sha256(key), sha256(c.req.param("key")))) return c.notFound();
    auth("break-glass login", { identifier: BREAK_GLASS }, "warn");
    startSession(c, BREAK_GLASS);
    return c.redirect("/ops", 303);
  });

  return { routes, operator, sameOrigin };
}
