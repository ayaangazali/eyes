import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { AppConfig, fakeProviders } from "@eyes/core";
import { createRpc, migrate } from "@eyes/db";
import { createEyesService } from "@eyes/engine";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toNodeListener } from "./http.ts";
import { createServer } from "./server.ts";

const url = process.env.DATABASE_URL;
const REDIRECT = "https://client.example/callback";
const VERIFIER = "v".repeat(43);

describe.skipIf(!url)("single-use OAuth codes over HTTP and PostgreSQL", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });
  const db = { kind: "postgres" as const, url: url ?? "" };
  const providers = fakeProviders();
  const config = AppConfig.parse({
    public_api_url: "http://api.eyes.test",
    worker_web_url: "http://worker.eyes.test",
    link_secret: "oauth-test-link-secret-0123456789",
  });
  const service = createEyesService({
    db,
    providers,
    config,
    assessTask: async () => ({ allowed: true, category: null, reason: null, fix: null, layer: null }),
    verifySubmission: async () => {
      throw new Error("No submissions in OAuth tests");
    },
  });
  const servers = Array.from({ length: 2 }, () => {
    const app = createServer({
      service,
      providers,
      config,
      env: { EYES_OAUTH_SECRET: "s".repeat(64) },
      rpc: createRpc(db),
    });
    return createHttpServer(toNodeListener((request) => app.fetch(request)));
  });
  const bases: string[] = [];
  let key: string;

  beforeAll(async () => {
    await migrate(url ?? "");
    key = (await service.signupAgent({ name: "OAuth replay test" })).api_key;
    for (const server of servers) {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      bases.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }
  });
  afterAll(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    await sql.end();
  });

  async function authorize() {
    const base = bases[0];
    const registration = await fetch(`${base}/oauth/register`, {
      method: "POST",
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    });
    const { client_id } = await registration.json();
    const params = {
      client_id,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    };
    const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams(params)}`);
    const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const response = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, csrf: cookie.split("=")[1] ?? "", action: "key", api_key: key }),
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const code = new URL(response.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const redeem = (host = bases[0], fields: Record<string, string> = {}) =>
      fetch(`${host}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id,
          redirect_uri: REDIRECT,
          code_verifier: VERIFIER,
          code,
          ...fields,
        }),
      });
    return { code, redeem };
  }

  it("rejects a second redemption on another server, including alternate base64 encoding", async () => {
    const { code, redeem } = await authorize();
    const first = await redeem();
    expect(first.status).toBe(200);
    const { access_token } = await first.json();
    expect(access_token).not.toBe(key);
    const initialized = await fetch(`${bases[1]}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin: "https://inspector.example",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "oauth-test", version: "1" },
        },
      }),
    });
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("access-control-allow-origin")).toBe("*");
    expect(await initialized.text()).toContain('"serverInfo"');
    const refused = await fetch(`${bases[0]}/v1/balance`, {
      headers: { authorization: `Bearer ${access_token}`, origin: "https://inspector.example" },
    });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(refused.headers.get("access-control-allow-origin")).toBe("*");
    for (const replay of [code, `${code}=`]) {
      const response = await redeem(bases[1], { code: replay });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    }
  });

  it("lets exactly one concurrent redemption win across servers", async () => {
    const { redeem } = await authorize();
    const responses = await Promise.all([redeem(bases[0]), redeem(bases[1])]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    for (const response of responses) {
      expect(await response.json()).toMatchObject(
        response.status === 200 ? { token_type: "Bearer" } : { error: "invalid_grant" },
      );
    }
  });

  it("does not consume a code when PKCE, client or redirect validation fails", async () => {
    const { redeem } = await authorize();
    const invalidRequests: Record<string, string>[] = [
      { code_verifier: "w".repeat(43) },
      { client_id: "wrong-client" },
      { redirect_uri: "https://other.example/callback" },
      { resource: "https://other.example/mcp" },
    ];
    for (const fields of invalidRequests) {
      const response = await redeem(bases[0], fields);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: fields.resource ? "invalid_target" : "invalid_grant",
      });
    }
    const response = await redeem();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token_type: "Bearer" });
  });

  it("returns no token when redemption storage fails and permits retry after recovery", async () => {
    const { redeem } = await authorize();
    await sql`alter table oauth_code_redemptions rename to unavailable_redemptions`;
    try {
      const response = await redeem();
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(key);
    } finally {
      await sql`alter table unavailable_redemptions rename to oauth_code_redemptions`;
    }
    expect(await (await redeem()).json()).toMatchObject({ token_type: "Bearer" });
  });

  it("denies an untrusted database role access to redemption records and the RPC", async () => {
    const rollback = new Error("rollback");
    await expect(
      sql.begin(async (tx) => {
        await tx`drop function eyes_redeem_oauth_code(text)`;
        await tx`drop table oauth_code_redemptions`;
        for (const role of ["anon", "authenticated"]) {
          await tx.unsafe(`do $$ begin
            if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if;
          end $$`);
        }
        await tx`alter default privileges in schema public grant all on tables to anon, authenticated`;
        await tx`alter default privileges in schema public grant execute on functions to anon, authenticated`;
        await tx.unsafe(
          readFileSync(
            new URL("../../../packages/db/migrations/039_oauth_code_redemptions.sql", import.meta.url),
            "utf8",
          ),
        );
        for (const role of ["anon", "authenticated"]) {
          expect(
            (
              await tx`select
            has_table_privilege(${role}, 'oauth_code_redemptions', 'select') as can_read,
            has_table_privilege(${role}, 'oauth_code_redemptions', 'insert') as can_insert,
            has_function_privilege(${role}, 'eyes_redeem_oauth_code(text)', 'execute') as can_redeem`
            )[0],
          ).toEqual({
            can_read: false,
            can_insert: false,
            can_redeem: false,
          });
        }
        await tx`select * from eyes_redeem_oauth_code('server-only')`;
        await tx`create role oauth_untrusted`;
        await tx`grant usage on schema public to oauth_untrusted`;
        await tx`grant select, insert on oauth_code_redemptions to oauth_untrusted`;
        await tx`set local role oauth_untrusted`;
        expect(await tx`select * from oauth_code_redemptions`).toEqual([]);
        expect(
          (
            await tx`select has_function_privilege(current_user, 'eyes_redeem_oauth_code(text)', 'execute') as allowed`
          )[0]?.allowed,
        ).toBe(false);
        await expect(tx`insert into oauth_code_redemptions values ('untrusted')`).rejects.toThrow(
          /row-level security/,
        );
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
