import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("migration v1 invariants", () => {
  const sql = postgres(url ?? "", { onnotice: () => {} });

  beforeAll(async () => {
    await migrate(url ?? "");
    expect(await migrate(url ?? "")).toEqual([]);
  });
  afterAll(() => sql.end());

  async function agentWithTask() {
    const [agent] = await sql`insert into agents (name, api_key_hash, balance_cents)
      values ('t', ${crypto.randomUUID()}, 1000) returning id`;
    const [task] =
      await sql`insert into tasks (agent_id, question, task_type, place_label, lat, lng, bounty_cents, fee_cents, deadline_at, idempotency_key)
      values (${agent?.id}, 'Is it open?', 'is_open', 'Ferry Building', 37.79, -122.39, 300, 50, now() + interval '30 minutes', 'k1')
      returning id`;
    return { agentId: agent?.id as string, taskId: task?.id as string };
  }

  it("rejects a reused idempotency_key for the same agent", async () => {
    const { agentId } = await agentWithTask();
    await expect(
      sql`insert into tasks (agent_id, question, task_type, place_label, lat, lng, bounty_cents, fee_cents, deadline_at, idempotency_key)
        values (${agentId}, 'again', 'is_open', 'x', 0, 0, 300, 50, now(), 'k1')`,
    ).rejects.toThrow(/duplicate key/);
  });

  it("allows each ledger type at most once per task, so escrow cannot double-release", async () => {
    const { agentId, taskId } = await agentWithTask();
    await sql`insert into ledger (agent_id, task_id, type, amount_cents) values (${agentId}, ${taskId}, 'release', 300)`;
    await expect(
      sql`insert into ledger (agent_id, task_id, type, amount_cents) values (${agentId}, ${taskId}, 'release', 300)`,
    ).rejects.toThrow(/duplicate key/);
  });

  it("never lets a balance go negative", async () => {
    const { agentId } = await agentWithTask();
    await expect(
      sql`update agents set balance_cents = balance_cents - 1001 where id = ${agentId}`,
    ).rejects.toThrow(/check constraint/);
  });

  it("lets exactly one of two concurrent conditional claims win", async () => {
    const { taskId } = await agentWithTask();
    const workers = await sql`insert into workers (phone, name, lat, lng) values
      (${`+1415${Date.now() % 10_000_000}`}, 'a', 0, 0), (${`+1416${Date.now() % 10_000_000}`}, 'b', 0, 0) returning id`;
    const other = postgres(url ?? "", { onnotice: () => {} });
    const claim = (db: typeof sql, workerId: string) =>
      db`update tasks set status = 'claimed', claimed_by = ${workerId}, claimed_at = now()
        where id = ${taskId} and status = 'dispatched' returning id`;
    const [a, b] = await Promise.all([claim(sql, workers[0]?.id), claim(other, workers[1]?.id)]);
    await other.end();
    expect(a.length + b.length).toBe(1);
  });

  it("keeps every table behind RLS and strips anon and authenticated grants", async () => {
    const tables = ["agents", "ledger", "offers", "schema_migrations", "submissions", "tasks", "workers"];
    expect(
      await sql`select relname, relrowsecurity from pg_class
        where relnamespace = 'public'::regnamespace and relname in ${sql(tables)} order by relname`,
    ).toEqual(tables.map((relname) => ({ relname, relrowsecurity: true })));

    const migration = readFileSync(new URL("../migrations/002_engine.sql", import.meta.url), "utf8");
    const revokeBlock = migration.match(/^do \$\$[\s\S]*?^end \$\$;/m)?.[0] ?? "";
    const rollback = new Error("rollback");
    await expect(
      sql.begin(async (tx) => {
        for (const role of ["anon", "authenticated"]) {
          await tx.unsafe(
            `do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role}; end if; end $$`,
          );
        }
        await tx.unsafe(`grant all on ${tables.join(", ")} to anon, authenticated`);
        await tx.unsafe(
          "grant execute on function eyes_credit_topup(uuid, bigint, text, timestamptz) to anon",
        );
        await tx.unsafe(revokeBlock);
        const [granted] = await tx`select
          has_table_privilege('anon', 'agents', 'select') as anon_agents,
          has_table_privilege('authenticated', 'ledger', 'insert') as authenticated_ledger,
          has_table_privilege('anon', 'schema_migrations', 'insert') as anon_migrations,
          has_function_privilege('anon', 'eyes_credit_topup(uuid,bigint,text,timestamptz)', 'execute') as anon_topup`;
        expect(granted).toEqual({
          anon_agents: false,
          authenticated_ledger: false,
          anon_migrations: false,
          anon_topup: false,
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});
