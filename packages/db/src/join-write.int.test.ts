import { randomInt } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";
import { createRpc } from "./rpc.ts";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("eyes_join_worker does the same write for new and known phones", () => {
  const rpc = createRpc({ kind: "postgres", url: url ?? "" });
  const sql = postgres(url ?? "", { onnotice: () => {} });
  beforeAll(() => migrate(url ?? ""));
  afterAll(() => sql.end());

  it("writes a new row version on a repeat join without changing any column", async () => {
    const phone = `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;
    const join = (name: string, lat: number) =>
      rpc("eyes_join_worker", {
        p_name: name,
        p_phone: phone,
        p_lat: lat,
        p_lng: -122,
        p_now: new Date().toISOString(),
      });
    const row = async () =>
      (
        await sql`select xmin::text as version, to_jsonb(workers) as data from workers where phone = ${phone}`
      )[0];

    await join("First", 37);
    const before = await row();
    const [again] = await rpc<{ name: string }>("eyes_join_worker", {
      p_name: "Other",
      p_phone: phone,
      p_lat: 10,
      p_lng: 10,
      p_now: new Date().toISOString(),
    });
    const after = await row();

    expect(after?.version).not.toBe(before?.version);
    expect(after?.data).toEqual(before?.data);
    expect(again?.name).toBe("First");
  });
});
