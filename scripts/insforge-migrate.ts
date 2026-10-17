import { readdirSync, readFileSync } from "node:fs";

const base = process.env.INSFORGE_BASE_URL;
const key = process.env.INSFORGE_API_KEY;
if (!base || !key) throw new Error("Set INSFORGE_BASE_URL and INSFORGE_API_KEY (admin ik_ key).");

const dir = new URL("../packages/db/migrations/", import.meta.url);
const files = readdirSync(dir)
  .filter((f) => /^\d{3}_.+\.sql$/.test(f))
  .sort();

for (const file of files) {
  const n = file.slice(0, 3);
  const body = {
    version: `20261017000${n}`,
    name: file.slice(4, -4).replaceAll("_", "-"),
    sql: readFileSync(new URL(file, dir), "utf8"),
  };
  const res = await fetch(`${base}/api/database/migrations`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`${file}: ${res.status} ${text.slice(0, 300)}`);
  if (!res.ok && res.status !== 409) process.exit(1);
}
