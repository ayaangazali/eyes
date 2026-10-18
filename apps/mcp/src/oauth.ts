// OAuth 2.1 for ChatGPT and claude.ai connectors, in front of the existing API keys. Stateless: the
// DCR client_id and the authorization code are AES-GCM sealed blobs, so nothing is stored. The
// login page takes an existing Eyes key or creates one through the signup service, and the token
// endpoint hands that key back as the access token, so the /mcp bearer check stays unchanged.
// ponytail: the access token is the API key (no expiry, no refresh, revoke = rotate the key); an
// authorization code can be redeemed again within its 5 minutes by the same client with the same
// PKCE verifier. Short-lived tokens plus refresh need storage; add them if a host demands expiry.
// Clients that skip DCR can use an https URL as client_id (Client ID Metadata Documents, MCP
// 2025-11-25): the document is fetched, checked and cached for 10 minutes.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { Context, Env, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

const CODE_TTL_MS = 5 * 60 * 1000;
const CSRF_COOKIE = "eyes_oauth_csrf";

export interface OAuthDeps {
  /** Public origin, e.g. https://api.eyes.pictures; the issuer and the base of every endpoint. */
  base: string;
  /** EYES_OAUTH_SECRET, at least 32 characters. */
  secret: string;
  /** True when the key belongs to an agent. */
  validKey: (key: string) => Promise<boolean>;
  /** Creates an agent through the signup service (rate limit included). */
  signup: (c: Context, name: string) => Promise<{ api_key: string; balance_usd: number }>;
  layout: (title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) => unknown;
  /** Loads a Client ID Metadata Document; defaults to cimdLoader(). */
  cimd?: (clientId: string) => Promise<Client | { error: string }>;
}

export type Client = { t: "client"; r: string[]; n: string };
type Code = { t: "code"; k: string; c: string; r: string; ch: string; exp: number };

const b64url = (b: Buffer) => b.toString("base64url");

export function sealer(secret: string) {
  const key = createHash("sha256").update(`eyes-oauth:${secret}`).digest();
  return {
    seal(value: Client | Code): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      return b64url(Buffer.concat([iv, cipher.getAuthTag(), body]));
    },
    open<T extends Client | Code>(token: unknown, t: T["t"]): T | null {
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

// Private, loopback, link-local, CGNAT, multicast and reserved ranges: never fetched.
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(net, bits, "ipv4");
// BlockList already checks IPv4-mapped IPv6 (::ffff:a.b.c.d) against the IPv4 rules above.
for (const [net, bits] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, bits, "ipv6");
export const privateIp = (ip: string) => {
  const v = isIP(ip);
  return v === 0 || blocked.check(ip, v === 4 ? "ipv4" : "ipv6");
};

const MAX_DOC_BYTES = 5 * 1024;
const DOC_TTL_MS = 10 * 60 * 1000;

export const okClientIdUrl = (id: string) => {
  if (id.length > 2000) return false;
  try {
    const url = new URL(id);
    return (
      url.protocol === "https:" &&
      url.pathname !== "/" &&
      !url.hash &&
      !url.username &&
      !url.password &&
      url.href === id
    );
  } catch {
    return false;
  }
};

// ponytail: the DNS check and the connection resolve separately, so a rebinding host could still
// slip past; pin the connection to the checked address if this ever fetches anything but JSON.
export function cimdLoader({
  fetch = globalThis.fetch,
  lookup = (host: string) => dnsLookup(host, { all: true, verbatim: true }),
  timeoutMs = 5000,
  now = Date.now,
}: {
  fetch?: typeof globalThis.fetch;
  lookup?: (host: string) => Promise<{ address: string }[]>;
  timeoutMs?: number;
  now?: () => number;
} = {}) {
  const cache = new Map<string, { client: Client; exp: number }>();
  const get = async (start: string, signal: AbortSignal) => {
    let url = new URL(start);
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "https:") throw new Error("it redirects to a non-https address");
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const ips = isIP(host) ? [{ address: host }] : await lookup(host);
      if (ips.length === 0 || ips.some((a) => privateIp(a.address)))
        throw new Error("its host is a private address");
      const res = await fetch(url, { redirect: "manual", signal, headers: { accept: "application/json" } });
      const next = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && next && hop < 3) {
        url = new URL(next, url);
        continue;
      }
      if (res.status !== 200 || !res.body) throw new Error(`it answered HTTP ${res.status}`);
      if (Number(res.headers.get("content-length") ?? 0) > MAX_DOC_BYTES) throw new Error("it is over 5 KB");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > MAX_DOC_BYTES) throw new Error("it is over 5 KB");
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    }
  };
  return async (clientId: string): Promise<Client | { error: string }> => {
    const hit = cache.get(clientId);
    if (hit && hit.exp > now()) return hit.client;
    const fail = (why: string) => ({ error: `Eyes could not use this app's client metadata: ${why}.` });
    if (!okClientIdUrl(clientId)) return fail("the client_id is not a valid https URL with a path");
    let doc: Record<string, unknown>;
    try {
      doc = await get(clientId, AbortSignal.timeout(timeoutMs));
    } catch (err) {
      const e = err as Error;
      return fail(
        e.name === "TimeoutError"
          ? "it took longer than 5 seconds"
          : e instanceof SyntaxError
            ? "it is not JSON"
            : e.message,
      );
    }
    if (doc?.client_id !== clientId) return fail("its client_id does not match its URL");
    const uris = doc.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(okRedirect))
      return fail("redirect_uris must be 1 to 10 https (or loopback http) URLs");
    if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== "none")
      return fail("Eyes supports only token_endpoint_auth_method none");
    const host = new URL(clientId).host;
    const name =
      typeof doc.client_name === "string" && doc.client_name.trim()
        ? doc.client_name.trim().slice(0, 60)
        : "";
    const client: Client = { t: "client", r: uris, n: name ? `${name} (${host})` : host };
    if (cache.size >= 500) cache.clear();
    cache.set(clientId, { client, exp: now() + DOC_TTL_MS });
    return client;
  };
}

export function oauthRoutes<E extends Env>(app: Hono<E>, deps: OAuthDeps) {
  const { base, layout } = deps;
  const box = sealer(deps.secret);
  const cimd = deps.cimd ?? cimdLoader();
  const resource = `${base}/mcp`;
  const protectedResource = {
    resource,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    resource_name: "Eyes",
    resource_documentation: "https://eyes.pictures",
  };
  const metadata = {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])
    app.get(path, (c) => c.json(protectedResource));
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
  ])
    app.get(path, (c) => c.json(metadata));

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
  const check = async (q: Record<string, string | undefined>) => {
    let client: Client | null;
    if (q.client_id?.startsWith("https://")) {
      const doc = await cimd(q.client_id);
      if ("error" in doc) return doc;
      client = doc;
    } else client = box.open<Client>(q.client_id, "client");
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
    return { client, redirect: q.redirect_uri, challenge: q.code_challenge as string };
  };
  const finish = (q: Record<string, string | undefined>, key: string, challenge: string) => {
    const code = box.seal({
      t: "code",
      k: key,
      c: q.client_id as string,
      r: q.redirect_uri as string,
      ch: challenge,
      exp: Date.now() + CODE_TTL_MS,
    });
    const url = new URL(q.redirect_uri as string);
    url.searchParams.set("code", code);
    if (q.state) url.searchParams.set("state", q.state);
    url.searchParams.set("iss", base);
    return url.href;
  };
  const headers = (redirect?: string) => ({
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${redirect ? ` ${new URL(redirect).origin}` : ""}; base-uri 'none'; frame-ancestors 'none'`,
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
        secure: base.startsWith("https:"),
        sameSite: "Lax",
        maxAge: 3600,
      });
    }
    const hidden = html`${FIELDS.filter((f) => q[f]).map((f) => html`<input type="hidden" name="${f}" value="${q[f]}">`)}<input type="hidden" name="csrf" value="${csrf}">`;
    return c.html(
      layout(
        "Connect Eyes",
        html`<h1>Connect ${name} to Eyes</h1>
<p class="muted">${name} will ask nearby people to check places for you, paid from this key's balance. You can change limits or revoke the key at any time.</p>
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

  app.get("/oauth/authorize", async (c) => {
    const q = c.req.query();
    const ok = await check(q);
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
    const ok = await check(form);
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
      const next = finish(form, agent.api_key, ok.challenge);
      return c.html(
        layout(
          "Your Eyes key",
          html`<h1>Your new Eyes key</h1>
<p class="muted">Save it somewhere safe: it is shown only once. ${ok.client.n} uses it to pay for checks.</p>
<p class="key">${agent.api_key}</p>
<dl><dt>Balance</dt><dd>$${agent.balance_usd.toFixed(2)}</dd></dl>
<a class="button" href="${next}">Continue to ${ok.client.n}</a>`,
        ) as Promise<HtmlEscapedString>,
        200,
        headers(),
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
    return c.redirect(finish(form, key, ok.challenge), 302);
  });

  app.post("/oauth/token", async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string | undefined>;
    const fail = (error: string, description: string) =>
      c.json({ error, error_description: description }, 400, { "Cache-Control": "no-store" });
    if (form.grant_type !== "authorization_code")
      return fail("unsupported_grant_type", "Only authorization_code is supported.");
    const code = box.open<Code>(form.code, "code");
    if (!code || code.exp < Date.now()) return fail("invalid_grant", "The code is invalid or expired.");
    if (form.client_id !== code.c || form.redirect_uri !== code.r)
      return fail("invalid_grant", "client_id or redirect_uri does not match the authorization request.");
    const verifier = form.code_verifier ?? "";
    if (
      !/^[\w.~-]{43,128}$/.test(verifier) ||
      !same(b64url(createHash("sha256").update(verifier).digest()), code.ch)
    )
      return fail("invalid_grant", "code_verifier does not match the code_challenge.");
    return c.json({ access_token: code.k, token_type: "Bearer" }, 200, {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    });
  });
}
