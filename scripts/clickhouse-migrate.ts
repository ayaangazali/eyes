// Applies packages/db/clickhouse/*.sql to ClickHouse over HTTP. Every statement is IF NOT EXISTS,
// so re-running is safe. Usage: node --env-file=.env scripts/clickhouse-migrate.ts
import { readdirSync, readFileSync } from "node:fs";
import { clickHouseConfig } from "../apps/web/dashboard/src/clickhouse.ts";

const cfg = clickHouseConfig(process.env);
if (!cfg)
  throw new Error("Set CLICKHOUSE_URL (and CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DATABASE).");
const auth = `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64")}`;

async function run(sql: string, database?: string) {
  const res = await fetch(`${cfg?.url}/${database ? `?database=${encodeURIComponent(database)}` : ""}`, {
    method: "POST",
    headers: { authorization: auth },
    body: sql,
  });
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${(await res.text()).slice(0, 500)}\n${sql}`);
}

if (!/^\w+$/.test(cfg.database))
  throw new Error(`CLICKHOUSE_DATABASE must be a plain name, got ${cfg.database}`);
await run(`create database if not exists ${cfg.database}`);
const dir = new URL("../packages/db/clickhouse/", import.meta.url);
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()) {
  const statements = readFileSync(new URL(file, dir), "utf8")
    .replace(/--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) await run(sql, cfg.database);
  console.log(`${file}: ${statements.length} statements`);
}
