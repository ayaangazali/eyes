import { readdirSync, readFileSync } from "node:fs";
import postgres from "postgres";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

export async function migrate(url: string): Promise<string[]> {
  const sql = postgres(url, { onnotice: () => {} });
  const applied: string[] = [];
  try {
    await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const done = new Set(
      (await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      await sql.begin(async (tx) => {
        await tx.unsafe(readFileSync(new URL(file, MIGRATIONS_DIR), "utf8"));
        await tx.unsafe("insert into schema_migrations (name) values ($1)", [file]);
      });
      applied.push(file);
    }
  } finally {
    await sql.end();
  }
  return applied;
}

export function databaseUrlFromEnv(env: Record<string, string | undefined> = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required, e.g. postgres://postgres:eyes@127.0.0.1:54329/eyes");
  return url;
}

/* v8 ignore start -- process entry: runs only when this file is executed directly, never on import */
if (import.meta.main) {
  console.log("applied:", await migrate(databaseUrlFromEnv()));
}
/* v8 ignore stop */
