import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";

const url = process.env.DATABASE_URL;
const MIGRATIONS = readdirSync(new URL("../migrations/", import.meta.url))
  .filter((f) => f.endsWith(".sql"))
  .sort();

// Same server, different database name. Each run gets its own, so nothing here touches the shared eyes database.
function otherDatabase(base: string, name: string): string {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const names = { ok: `eyes_mig_ok_${suffix}`, bad: `eyes_mig_bad_${suffix}` };

describe.skipIf(!url)("migrate() against throwaway databases", () => {
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(otherDatabase(url ?? "", "postgres"), { onnotice: () => {} });
    await admin.unsafe(`create database ${names.ok}`);
    await admin.unsafe(`create database ${names.bad}`);
  });

  afterAll(async () => {
    for (const name of Object.values(names)) {
      await admin.unsafe(`drop database if exists ${name} with (force)`);
    }
    await admin.end();
  });

  it("applies every migration file in order and records each one", async () => {
    const dbUrl = otherDatabase(url ?? "", names.ok);
    expect(await migrate(dbUrl)).toEqual(MIGRATIONS);

    const sql = postgres(dbUrl, { onnotice: () => {} });
    try {
      const rows = await sql<{ name: string }[]>`select name from schema_migrations order by name`;
      expect(rows.map((r) => r.name)).toEqual(MIGRATIONS);
      const [agents] = await sql<{ t: string | null }[]>`select to_regclass('public.agents') as t`;
      expect(agents?.t).toBe("agents");
    } finally {
      await sql.end();
    }
  });

  it("applies nothing on a second run", async () => {
    expect(await migrate(otherDatabase(url ?? "", names.ok))).toEqual([]);
  });

  it("rolls back the failing migration, leaves no record of it, and rejects", async () => {
    const badUrl = otherDatabase(url ?? "", names.bad);
    // 001_init creates `agents` without `if not exists`, so a pre-existing table makes it fail partway.
    const sql = postgres(badUrl, { onnotice: () => {} });
    try {
      await sql.unsafe("create table agents (marker int)");
    } finally {
      await sql.end();
    }

    await expect(migrate(badUrl)).rejects.toThrow(/already exists/);

    const check = postgres(badUrl, { onnotice: () => {} });
    try {
      const [workers] = await check<{ t: string | null }[]>`select to_regclass('public.workers') as t`;
      expect(workers?.t).toBeNull();
      const [recorded] = await check<{ n: number }[]>`select count(*)::int as n from schema_migrations`;
      expect(recorded?.n).toBe(0);
      const [agents] = await check<{ t: string | null }[]>`select to_regclass('public.agents') as t`;
      expect(agents?.t).toBe("agents");
    } finally {
      await check.end();
    }
  });
});
