import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { cimdLoader, oauthRoutes, okClientIdUrl, privateIp } from "./oauth.ts";

const ID = "https://app.instinct.com/oauth/client.json";
const REDIRECT = "https://app.instinct.com/connect/done";
const DOC = {
  client_id: ID,
  client_name: "Instinct",
  redirect_uris: [REDIRECT],
  token_endpoint_auth_method: "none",
};
const PUBLIC = async () => [{ address: "104.18.1.1" }];
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);

describe("privateIp", () => {
  it("refuses private, loopback, link-local and mapped addresses", () => {
    for (const ip of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "172.16.0.1",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "not-an-ip",
    ])
      expect(privateIp(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "104.18.1.1", "2606:4700::1111", "::ffff:8.8.8.8"])
      expect(privateIp(ip), ip).toBe(false);
  });
});

describe("okClientIdUrl", () => {
  it("needs a normalized https URL with a path and no fragment or credentials", () => {
    expect(okClientIdUrl(ID)).toBe(true);
    for (const id of [
      "http://a.com/c",
      "https://a.com/",
      "https://a.com/c#x",
      "https://u:p@a.com/c",
      "https://A.com/c",
      "https://a.com/../c",
      "nope",
      `https://a.com/${"x".repeat(2000)}`,
    ])
      expect(okClientIdUrl(id), id).toBe(false);
  });
});

describe("cimdLoader", () => {
  it("loads a document, names the client with its host, and caches it for 10 minutes", async () => {
    let t = 0;
    const fetch = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => json(DOC));
    const load = cimdLoader({ fetch, lookup: PUBLIC, now: () => t });
    expect(await load(ID)).toEqual({ t: "client", r: [REDIRECT], n: "Instinct (app.instinct.com)" });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    await load(ID);
    expect(fetch).toHaveBeenCalledTimes(1);
    t = 10 * 60 * 1000 + 1;
    await load(ID);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses the host when client_name is missing or blank", async () => {
    for (const client_name of [undefined, "  "]) {
      const load = cimdLoader({ fetch: async () => json({ ...DOC, client_name }), lookup: PUBLIC });
      expect(await load(ID)).toMatchObject({ n: "app.instinct.com" });
    }
  });

  it("rejects a document whose client_id differs from its URL", async () => {
    const load = cimdLoader({
      fetch: async () => json({ ...DOC, client_id: "https://evil.example/c" }),
      lookup: PUBLIC,
    });
    expect(await load(ID)).toEqual({ error: expect.stringContaining("does not match its URL") });
  });

  it("rejects bad redirect_uris and confidential auth methods", async () => {
    for (const redirect_uris of [undefined, [], ["http://evil.example/cb"]]) {
      const load = cimdLoader({ fetch: async () => json({ ...DOC, redirect_uris }), lookup: PUBLIC });
      expect(await load(ID)).toEqual({ error: expect.stringContaining("redirect_uris") });
    }
    const load = cimdLoader({
      fetch: async () => json({ ...DOC, token_endpoint_auth_method: "private_key_jwt" }),
      lookup: PUBLIC,
    });
    expect(await load(ID)).toEqual({ error: expect.stringContaining("none") });
  });

  it("refuses documents over 5 KB, by header or by stream", async () => {
    const big = JSON.stringify({ ...DOC, pad: "x".repeat(6000) });
    const byHeader = cimdLoader({
      fetch: async () => new Response("{}", { headers: { "content-length": "9999" } }),
      lookup: PUBLIC,
    });
    expect(await byHeader(ID)).toEqual({ error: expect.stringContaining("over 5 KB") });
    const stream = new ReadableStream({
      start(ctl) {
        ctl.enqueue(new TextEncoder().encode(big));
        ctl.close();
      },
    });
    const byStream = cimdLoader({ fetch: async () => new Response(stream), lookup: PUBLIC });
    expect(await byStream(ID)).toEqual({ error: expect.stringContaining("over 5 KB") });
  });

  it("gives up after the timeout", async () => {
    const fetch = (_: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    const load = cimdLoader({ fetch: fetch as typeof globalThis.fetch, lookup: PUBLIC, timeoutMs: 10 });
    expect(await load(ID)).toEqual({ error: expect.stringContaining("longer than 5 seconds") });
  });

  it("never fetches private addresses, by DNS, by literal IP, or after a redirect", async () => {
    const fetch = vi.fn(async () => json(DOC));
    expect(await cimdLoader({ fetch, lookup: async () => [{ address: "10.1.2.3" }] })(ID)).toEqual({
      error: expect.stringContaining("private address"),
    });
    expect(await cimdLoader({ fetch, lookup: async () => [] })(ID)).toEqual({
      error: expect.stringContaining("private address"),
    });
    expect(await cimdLoader({ fetch })("https://127.0.0.1/c")).toEqual({
      error: expect.stringContaining("private address"),
    });
    expect(await cimdLoader({ fetch })("https://[::1]/c")).toEqual({
      error: expect.stringContaining("private address"),
    });
    // Default DNS lookup: localhost resolves to loopback.
    expect(await cimdLoader({ fetch })("https://localhost/c")).toEqual({
      error: expect.stringContaining("private address"),
    });
    const hop = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://internal.example/c" } }),
    );
    const lookup = async (host: string) => [
      { address: host === "internal.example" ? "192.168.0.5" : "104.18.1.1" },
    ];
    expect(await cimdLoader({ fetch: hop, lookup })(ID)).toEqual({
      error: expect.stringContaining("private address"),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(hop).toHaveBeenCalledTimes(1);
  });

  it("follows https redirects, refuses http ones, and stops after 3 hops", async () => {
    const to = (location: string) => new Response(null, { status: 301, headers: { location } });
    const ok = vi.fn().mockResolvedValueOnce(to("/moved")).mockResolvedValueOnce(json(DOC));
    expect(await cimdLoader({ fetch: ok, lookup: PUBLIC })(ID)).toMatchObject({
      n: "Instinct (app.instinct.com)",
    });
    expect(String(ok.mock.calls[1]?.[0])).toBe("https://app.instinct.com/moved");
    expect(
      await cimdLoader({ fetch: async () => to("http://app.instinct.com/c"), lookup: PUBLIC })(ID),
    ).toEqual({
      error: expect.stringContaining("non-https"),
    });
    expect(await cimdLoader({ fetch: async () => to("/again"), lookup: PUBLIC })(ID)).toEqual({
      error: expect.stringContaining("HTTP 301"),
    });
  });

  it("reports bad status, empty body, non-JSON and invalid client_id", async () => {
    expect(await cimdLoader({ fetch: async () => json(DOC, { status: 404 }), lookup: PUBLIC })(ID)).toEqual({
      error: expect.stringContaining("HTTP 404"),
    });
    expect(await cimdLoader({ fetch: async () => new Response(null), lookup: PUBLIC })(ID)).toEqual({
      error: expect.stringContaining("HTTP 200"),
    });
    expect(await cimdLoader({ fetch: async () => new Response("<html>"), lookup: PUBLIC })(ID)).toEqual({
      error: expect.stringContaining("not JSON"),
    });
    expect(await cimdLoader({ fetch: async () => new Response("null"), lookup: PUBLIC })(ID)).toEqual({
      error: expect.stringContaining("does not match"),
    });
    expect(await cimdLoader()("https://a.com/")).toEqual({
      error: expect.stringContaining("valid https URL"),
    });
  });

  it("keeps the cache bounded", async () => {
    const fetch = vi.fn(async (url: URL | RequestInfo) => json({ ...DOC, client_id: String(url) }));
    const load = cimdLoader({ fetch, lookup: PUBLIC });
    for (let i = 0; i <= 500; i++) await load(`https://app.instinct.com/c/${i}`);
    await load("https://app.instinct.com/c/0");
    expect(fetch).toHaveBeenCalledTimes(502);
  });
});

describe("oauthRoutes with a client ID metadata document", () => {
  const app = new Hono();
  oauthRoutes(app, {
    base: "https://api.eyes.test",
    secret: "s".repeat(32),
    validKey: async (key) => key === "eyes_test_ok",
    signup: async () => ({ api_key: "eyes_test_new", balance_usd: 20 }),
    layout: (_title, body) => body,
    cimd: cimdLoader({ fetch: async () => json(DOC), lookup: PUBLIC }),
  });
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const q = {
    response_type: "code",
    client_id: ID,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st",
  };

  it("advertises CIMD support", async () => {
    const meta = await (await app.request("/.well-known/oauth-authorization-server")).json();
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.registration_endpoint).toBe("https://api.eyes.test/oauth/register");
  });

  it("shows the document's name, signs in, and swaps the code for the key", async () => {
    const page = await app.request(`/oauth/authorize?${new URLSearchParams(q)}`);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("Connect Instinct (app.instinct.com) to Eyes");
    const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const csrf = /name="csrf" value="([^"]+)"/.exec(body)?.[1] as string;
    const post = await app.request("/oauth/authorize", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...q, csrf, action: "key", api_key: "eyes_test_ok" }),
    });
    expect(post.status).toBe(302);
    const back = new URL(post.headers.get("location") as string);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    const token = await app.request("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: back.searchParams.get("code") as string,
        client_id: ID,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
    });
    expect(await token.json()).toEqual({ access_token: "eyes_test_ok", token_type: "Bearer" });
  });

  it("refuses a redirect_uri the document does not list", async () => {
    const res = await app.request(
      `/oauth/authorize?${new URLSearchParams({ ...q, redirect_uri: "https://evil.example/cb" })}`,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("did not register");
  });

  it("shows the loader's error and never redirects", async () => {
    const res = await app.request(
      `/oauth/authorize?${new URLSearchParams({ ...q, client_id: "https://app.instinct.com/" })}`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("valid https URL");
  });
});
