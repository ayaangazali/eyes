// Store only redeemed code hashes.
// ponytail: OAuth tokens have no expiry or refresh; revoke by rotating the key. Add expiry if a host requires it.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Rpc } from "@eyes/db";
import type { Context, Env, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

const CODE_TTL_MS = 5 * 60 * 1000;
const CSRF_COOKIE = "eyes_oauth_csrf";

// Static script: the key stays in the escaped page text, never in JavaScript or a URL.
const COPY_KEY_SCRIPT = `const button = document.getElementById("copy-key");
const key = document.getElementById("new-key");
const status = document.getElementById("copy-status");
button.addEventListener("click", async () => {
  button.disabled = true;
  button.textContent = "Copy";
  status.textContent = "";
  try {
    await navigator.clipboard.writeText(key.textContent);
    button.textContent = "Copied";
    status.textContent = "Copied to clipboard.";
  } catch {
    status.textContent = "Could not copy. Select the key above and copy it manually.";
  } finally {
    button.disabled = false;
  }
});`;
const COPY_KEY_HASH = createHash("sha256").update(COPY_KEY_SCRIPT).digest("base64");

export interface OAuthDeps {
  /** Public issuer for this connector; the API host remains valid during staging. */
  base: string | ((c: Context) => string);
  /** EYES_OAUTH_SECRET, at least 32 characters. */
  secret: string;
  rpc: Rpc;
  /** True when the key belongs to an agent. */
  validKey: (key: string) => Promise<boolean>;
  /** Creates an agent through the signup service (rate limit included). */
  signup: (c: Context, name: string) => Promise<{ api_key: string; balance_usd: number }>;
  layout: (title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) => unknown;
}

type Client = { t: "client"; r: string[]; n: string };
type Code = { t: "code"; k: string; c: string; r: string; ch: string; resource: string; exp: number };
type Sealed = Client | Code | { t: "access"; k: string; resource: string };

const b64url = (b: Buffer) => b.toString("base64url");

export function sealer(secret: string) {
  const key = createHash("sha256").update(`eyes-oauth:${secret}`).digest();
  return {
    seal(value: Sealed): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      return b64url(Buffer.concat([iv, cipher.getAuthTag(), body]));
    },
    open<T extends Sealed["t"]>(token: unknown, t: T): Extract<Sealed, { t: T }> | null {
      if (typeof token !== "string" || token.length > 4096) return null;
      try {
        const raw = Buffer.from(token, "base64url");
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        const value = JSON.parse(
          Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"),
        );
        return value?.t === t ? value : null;
      } catch {
        return null;
      }
    },
  };
}

const okRedirect = (uri: unknown): uri is string => {
  if (typeof uri !== "string" || uri.length > 2000) return false;
  try {
    const url = new URL(uri);
    const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || loopback) && !url.hash;
  } catch {
    return false;
  }
};

const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function oauthRoutes<E extends Env>(app: Hono<E>, deps: OAuthDeps) {
  const { layout } = deps;
  const baseFor = (c: Context) => (typeof deps.base === "string" ? deps.base : deps.base(c));
  const box = sealer(deps.secret);
  const protectedResource = (base: string) => ({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    resource_name: "Eyes",
    resource_documentation: "https://eyes.pictures",
  });
  const metadata = (base: string) => ({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  });
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])
    app.get(path, (c) => c.json(protectedResource(baseFor(c))));
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
  ])
    app.get(path, (c) => c.json(metadata(baseFor(c))));

  app.post("/oauth/register", async (c) => {
    const body = await c.req.json().catch(() => null);
    const uris: unknown = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(okRedirect))
      return c.json(
        {
          error: "invalid_redirect_uri",
          error_description: "redirect_uris: 1 to 10 https (or loopback http) URLs.",
        },
        400,
      );
    const name = typeof body.client_name === "string" ? body.client_name.slice(0, 80) : "MCP client";
    const client_id = box.seal({ t: "client", r: uris, n: name });
    return c.json(
      {
        client_id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: uris,
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    );
  });

  // Validates the authorize parameters; returns an error message for a page, never a redirect,
  // because an unverified redirect_uri must not receive anything.
  const check = (q: Record<string, string | undefined>, base: string) => {
    const client = box.open(q.client_id, "client");
    if (!client)
      return { error: "This app is not registered with Eyes. Remove the connector and add it again." };
    if (!q.redirect_uri || !client.r.includes(q.redirect_uri))
      return { error: "The app sent a return address it did not register." };
    if (
      q.response_type !== "code" ||
      q.code_challenge_method !== "S256" ||
      !/^[\w-]{43,128}$/.test(q.code_challenge ?? "")
    )
      return { error: "The app must use the authorization code flow with PKCE (S256)." };
    if (q.resource !== undefined && q.resource !== `${base}/mcp`)
      return { error: "The requested resource is not this Eyes connector." };
    return { client, redirect: q.redirect_uri, challenge: q.code_challenge as string };
  };
  const finish = (c: Context, q: Record<string, string | undefined>, key: string, challenge: string) => {
    const code = box.seal({
      t: "code",
      k: key,
      c: q.client_id as string,
      r: q.redirect_uri as string,
      ch: challenge,
      resource: q.resource ?? `${baseFor(c)}/mcp`,
      exp: Date.now() + CODE_TTL_MS,
    });
    const url = new URL(q.redirect_uri as string);
    url.searchParams.set("code", code);
    if (q.state) url.searchParams.set("state", q.state);
    url.searchParams.set("iss", baseFor(c));
    return url.href;
  };
  const headers = (redirect?: string, copyKey = false) => ({
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store, no-transform",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; font-src 'self';${copyKey ? ` script-src 'sha256-${COPY_KEY_HASH}';` : ""} form-action 'self'${redirect ? ` ${new URL(redirect).origin}` : ""}; base-uri 'none'; frame-ancestors 'none'`,
  });
  const FIELDS = [
    "response_type",
    "client_id",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "state",
    "scope",
    "resource",
  ];
  const page = (
    c: Context,
    q: Record<string, string | undefined>,
    name: string,
    redirect: string,
    error?: string,
  ) => {
    let csrf = getCookie(c, CSRF_COOKIE);
    if (!csrf || !/^[\w-]{32}$/.test(csrf)) {
      csrf = b64url(randomBytes(24));
      setCookie(c, CSRF_COOKIE, csrf, {
        path: "/oauth",
        httpOnly: true,
        secure: baseFor(c).startsWith("https:"),
        sameSite: "Lax",
        maxAge: 3600,
      });
    }
    const hidden = html`${FIELDS.filter((f) => q[f]).map((f) => html`<input type="hidden" name="${f}" value="${q[f]}">`)}<input type="hidden" name="csrf" value="${csrf}">`;
    return c.html(
      layout(
        "Connect Eyes",
        html`<h1>Connect ${name} to Eyes</h1>
<p class="muted">${name} will ask nearby people to check places for you, paid from this key's balance.</p>
${error ? html`<p class="note error" role="alert">${error}</p>` : ""}
<form method="post" action="/oauth/authorize" class="box">
<h2>Use your Eyes API key</h2>
${hidden}<input type="hidden" name="action" value="key">
<label for="k">API key</label>
<input id="k" class="ui-input" name="api_key" autocomplete="off" spellcheck="false" placeholder="eyes_test_…" required style="width:100%;margin-top:.375rem">
<button type="submit">Connect</button>
</form>
<form method="post" action="/oauth/authorize" class="box">
<h2>No key yet?</h2>
<p class="muted">Create one now. Test keys start with a $20 balance.</p>
${hidden}<input type="hidden" name="action" value="create">
<button type="submit" class="button--quiet">Create a key</button>
</form>`,
      ) as Promise<HtmlEscapedString>,
      error ? 400 : 200,
      headers(redirect),
    );
  };

  app.get("/oauth/authorize", (c) => {
    const q = c.req.query();
    const ok = check(q, baseFor(c));
    if ("error" in ok)
      return c.html(
        layout(
          "Connect Eyes",
          html`<h1>Can't connect</h1><p class="note error">${ok.error}</p>`,
        ) as Promise<HtmlEscapedString>,
        400,
        headers(),
      );
    return page(c, q, ok.client.n, ok.redirect);
  });

  app.post("/oauth/authorize", async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string | undefined>;
    const ok = check(form, baseFor(c));
    if ("error" in ok)
      return c.html(
        layout(
          "Connect Eyes",
          html`<h1>Can't connect</h1><p class="note error">${ok.error}</p>`,
        ) as Promise<HtmlEscapedString>,
        400,
        headers(),
      );
    const csrf = getCookie(c, CSRF_COOKIE);
    if (!csrf || typeof form.csrf !== "string" || !same(csrf, form.csrf))
      return page(c, form, ok.client.n, ok.redirect, "This form expired. Try again.");
    if (form.action === "create") {
      const agent = await deps
        .signup(c, ok.client.n)
        .catch((err: { toBody?: () => { message?: string; fix?: string } }) => {
          const body = err.toBody?.();
          return { error: body?.fix ?? body?.message ?? "Could not create a key. Try again later." };
        });
      if ("error" in agent) return page(c, form, ok.client.n, ok.redirect, agent.error);
      const next = finish(c, form, agent.api_key, ok.challenge);
      return c.html(
        layout(
          "Your Eyes key",
          html`<h1>Your new Eyes key</h1>
<p class="muted">Save this key if you want direct API access. Otherwise, click Continue to ${ok.client.n}. Your app receives a token for this connector. The key is shown only once.</p>
<div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
<p id="new-key" class="key" style="flex:1;min-width:0;margin:0;white-space:pre-wrap;user-select:all;-webkit-user-select:all">${agent.api_key}</p>
<button id="copy-key" type="button" class="button--quiet" aria-describedby="copy-status" style="margin:0">Copy</button>
</div>
<p id="copy-status" class="hint" role="status" aria-live="polite"></p>
<dl><dt>Balance</dt><dd>$${agent.balance_usd.toFixed(2)}</dd></dl>
<a class="button" href="${next}">Continue to ${ok.client.n}</a>
<script>${raw(COPY_KEY_SCRIPT)}</script>`,
        ) as Promise<HtmlEscapedString>,
        200,
        headers(undefined, true),
      );
    }
    const key = (form.api_key ?? "").trim();
    if (!key || !(await deps.validKey(key)))
      return page(
        c,
        form,
        ok.client.n,
        ok.redirect,
        "That key is not valid. Check it, or create a new one below.",
      );
    return c.redirect(finish(c, form, key, ok.challenge), 302);
  });

  app.post("/oauth/token", async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string | undefined>;
    const fail = (error: string, description: string) =>
      c.json({ error, error_description: description }, 400, { "Cache-Control": "no-store" });
    if (form.grant_type !== "authorization_code")
      return fail("unsupported_grant_type", "Only authorization_code is supported.");
    const code = box.open(form.code, "code");
    if (!code || code.exp < Date.now() || !code.resource)
      return fail("invalid_grant", "The code is invalid or expired.");
    if (
      code.resource !== `${baseFor(c)}/mcp` ||
      (form.resource !== undefined && form.resource !== code.resource)
    )
      return fail("invalid_target", "The resource must match the authorized Eyes connector.");
    if (form.client_id !== code.c || form.redirect_uri !== code.r)
      return fail("invalid_grant", "client_id or redirect_uri does not match the authorization request.");
    const verifier = form.code_verifier ?? "";
    if (
      !/^[\w.~-]{43,128}$/.test(verifier) ||
      !same(b64url(createHash("sha256").update(verifier).digest()), code.ch)
    )
      return fail("invalid_grant", "code_verifier does not match the code_challenge.");
    const hash = createHash("sha256")
      .update(Buffer.from(form.code as string, "base64url"))
      .digest("hex");
    if (!(await deps.rpc("eyes_redeem_oauth_code", { p_code_hash: hash })).length)
      return fail("invalid_grant", "The code has already been redeemed.");
    return c.json(
      { access_token: box.seal({ t: "access", k: code.k, resource: code.resource }), token_type: "Bearer" },
      200,
      { "Cache-Control": "no-store", Pragma: "no-cache" },
    );
  });
}
