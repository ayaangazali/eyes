import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";
import { createRpc } from "./rpc.ts";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("rpc args with NUL reach Postgres", () => {
  const rpc = createRpc({ kind: "postgres", url: url ?? "" });

  it("stores text and jsonb args with NUL stripped and the rest intact", async () => {
    await migrate(url ?? "");
    const now = new Date().toISOString();
    const phone = `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;
    const [w] = await rpc<{ id: string; name: string }>("eyes_join_worker", {
      p_name: "Nul\u0000 Worker",
      p_phone: phone,
      p_lat: 37.77,
      p_lng: -122.42,
      p_now: now,
    });
    expect(w?.name).toBe("Nul Worker");
    const id = w?.id as string;

    // The production failure: a worker reply with NUL appended to a ticket (none open here, so no row).
    expect(await rpc("eyes_append_ticket", { p_worker_id: id, p_message: "\ufffc\u0000" })).toEqual([]);

    const [ping] = await rpc<{ nonce: string }>("eyes_record_pings", {
      p_pings: [{ nonce: `n\u0000${phone}`, worker_id: id, task_id: null }],
      p_now: now,
    });
    expect(ping?.nonce).toBe(`n${phone}`);
  });
});
