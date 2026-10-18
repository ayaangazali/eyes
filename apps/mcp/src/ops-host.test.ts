import { AppConfig, type EyesService, fakeProviders } from "@eyes/core";
import type { Rpc } from "@eyes/db";
import { describe, expect, it } from "vitest";
import { opsOriginFor } from "./ops-host.ts";
import { createServer } from "./server.ts";

const OPS_KEY = "ops-5f2c9a1e7b3d4c8a9e0f1a2b3c4d5e6f";
const API = "https://api.eyes.test";
const OPS = "https://internal.eyes.test";

function setup(env: Record<string, string> = { EYES_OPS_KEY: OPS_KEY }, publicApiUrl = API) {
  const rpc = (async (fn: string) => {
    if (fn === "eyes_ops_allowlist") return [];
    if (fn === "eyes_dashboard_feed") return [{ tasks: [], ledger: [], workers: [], totals: {} }];
    throw new Error(`unexpected rpc ${fn}`);
  }) as Rpc;
  const server = createServer({
    service: {} as EyesService,
    providers: fakeProviders(),
    config: AppConfig.parse({
      public_api_url: publicApiUrl,
      worker_web_url: "https://app.eyes.test",
      link_secret: "x".repeat(32),
    }),
    env,
    rpc,
  });
  // As in production: http.ts rewrites the URL to localhost; the edge Worker sets x-forwarded-host.
  return (host: string, path: string, init: RequestInit = {}) =>
    server.fetch(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { "x-forwarded-host": host, ...(init.headers as Record<string, string>) },
      }),
    );
}

describe("opsOriginFor", () => {
  it("swaps api. for internal., honours EYES_OPS_URL, and keeps ops on hosts without api.", () => {
    expect(opsOriginFor("https://api.eyes.pictures")).toBe("https://internal.eyes.pictures");
    expect(opsOriginFor("http://api.eyes.test:3000/v1")).toBe("http://internal.eyes.test:3000");
    expect(opsOriginFor("https://api.eyes.pictures", "https://ops.example.com/x")).toBe(
      "https://ops.example.com",
    );
    expect(opsOriginFor("http://127.0.0.1:3000")).toBeNull();
  });
});

describe("ops host routing", () => {
  it("serves the dashboard at the root of the ops host, with sign-in links and cookies on that host", async () => {
    const fetch = setup();
    const login = await fetch("internal.eyes.test", "/login");
    expect(login.status).toBe(200);
    const body = await login.text();
    expect(body).toContain('action="/login/code"');
    expect(body).not.toContain("/ops");

    const home = await fetch("internal.eyes.test", "/", { headers: { accept: "text/html" } });
    expect([home.status, home.headers.get("location")]).toEqual([303, "/login"]);
    expect((await fetch("internal.eyes.test", "/feed")).status).toBe(401);

    const glass = await fetch("internal.eyes.test", `/${OPS_KEY}`);
    expect([glass.status, glass.headers.get("location")]).toEqual([303, "/"]);
    const cookie = glass.headers.get("set-cookie") ?? "";
    // __Host-: Secure, Path=/ and no Domain, so the browser keeps it to internal.eyes.test only.
    expect(cookie).toMatch(
      /^__Host-eyes_ops=[^;]+; Max-Age=43200; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
    );
    expect(cookie).not.toMatch(/domain=/i);
    const session = { cookie: cookie.split(";")[0] ?? "" };

    const page = await fetch("internal.eyes.test", "/", { headers: session });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toMatch(/script-src https:\/\/unpkg\.com 'sha256-/);
    expect((await fetch("internal.eyes.test", "/live", { headers: session })).status).toBe(200);
    expect((await fetch("internal.eyes.test", "/feed", { headers: session })).status).toBe(200);
    const allowlist = await fetch("internal.eyes.test", "/allowlist", {
      headers: { ...session, accept: "text/html" },
    });
    expect(await allowlist.text()).toContain('href="/">Back to the dashboard');
  });

  it("checks posts against the ops origin there", async () => {
    const fetch = setup();
    const post = (origin: string) =>
      fetch("internal.eyes.test", "/login/code", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ identifier: "+15555550100" }),
      });
    expect((await post(OPS)).status).toBe(200);
    expect((await post(API)).status).toBe(403);
    expect(
      (await fetch("internal.eyes.test", "/logout", { method: "POST", headers: { origin: OPS } })).status,
    ).toBe(200);
  });

  it("answers nothing else of the API on the ops host", async () => {
    const fetch = setup();
    for (const path of ["/healthz", "/v1/balance", "/llms.txt", "/mcp"]) {
      expect((await fetch("internal.eyes.test", path)).status, path).toBe(404);
    }
  });

  it("redirects /ops paths to the ops host for good, keeping the rest of the path and the query", async () => {
    const fetch = setup();
    const cases = [
      ["api.eyes.test", "/ops", `${OPS}/`],
      ["api.eyes.test", "/ops/login?next=1", `${OPS}/login?next=1`],
      ["eyes-api.example.workers.dev", "/ops/live", `${OPS}/live`],
      ["internal.eyes.test", "/ops/allowlist", "/allowlist"],
    ];
    for (const [host, path, location] of cases) {
      const res = await fetch(host ?? "", path ?? "");
      expect([res.status, res.headers.get("location")], `${host}${path}`).toEqual([301, location]);
    }
    expect((await fetch("api.eyes.test", "/opsx")).status).toBe(404);
    expect((await fetch("api.eyes.test", "/healthz")).status).toBe(200);
  });

  it("keeps /ops on loopback and, with no ops host, on the API host", async () => {
    const fetch = setup();
    expect((await fetch("127.0.0.1:3000", "/ops/login")).status).toBe(200);
    const local = setup({}, "http://127.0.0.1:3000");
    const login = await local("127.0.0.1:3000", "/ops/login");
    expect(await login.text()).toContain('action="/ops/login/code"');
    expect((await local("eyes.example", "/ops/login")).status).toBe(200);
  });

  it("does not let a client send the internal hop header", async () => {
    const fetch = setup();
    const res = await fetch("api.eyes.test", "/ops/login", { headers: { "x-eyes-ops-hop": "guess" } });
    expect(res.status).toBe(301);
  });
});
