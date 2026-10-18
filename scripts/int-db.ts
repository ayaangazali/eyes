// Integration setup file: each test file gets its own database on the DATABASE_URL server, dropped afterwards.
// A shared database collects workers from every past run (the fake clock keeps their locations fresh, so they
// take offers), and a parallel run's global retryPayouts pays this run's tasks.
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll } from "vitest";

const base = process.env.DATABASE_URL;
if (base) {
  const name = `eyes_it_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const on = (db: string) => {
    const u = new URL(base);
    u.pathname = `/${db}`;
    return u.toString();
  };
  const admin = postgres(on("postgres"), { onnotice: () => {}, max: 1 });
  await admin.unsafe(`create database ${name}`);
  process.env.DATABASE_URL = on(name);
  afterAll(async () => {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.end();
  });
}
