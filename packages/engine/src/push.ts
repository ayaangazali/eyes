import type { createRpc } from "@eyes/db";

type Rpc = ReturnType<typeof createRpc>;
export type PushMessage = { title: string; body: string; data?: Record<string, string> };
export type PushTarget = { workerIds?: string[]; agentId?: string };

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const BATCH = 100; // Expo accepts at most 100 messages per request.

// Push is extra (ADR-053): every failure is logged by name and swallowed, so a text or API call never fails on it.
export function createPusher(rpc: Rpc, send: typeof fetch = fetch) {
  return async (target: PushTarget, msg: PushMessage): Promise<void> => {
    try {
      const rows = await rpc<{ token: string }>("eyes_push_tokens", {
        p_worker_ids: target.workerIds ?? [],
        p_agent_id: target.agentId ?? null,
      });
      const tokens = rows.map((r) => r.token);
      const dead: string[] = [];
      for (let i = 0; i < tokens.length; i += BATCH) {
        const batch = tokens.slice(i, i + BATCH);
        const res = await send(EXPO_PUSH_URL, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(batch.map((to) => ({ to, sound: "default", ...msg }))),
        });
        if (!res.ok) throw new Error(`expo status ${res.status}`);
        const { data } = (await res.json()) as {
          data?: { status: string; details?: { error?: string } }[];
        };
        data?.forEach((t, j) => {
          const token = batch[j];
          if (token && t.status === "error" && t.details?.error === "DeviceNotRegistered") dead.push(token);
        });
      }
      if (dead.length) await rpc("eyes_remove_push_tokens", { p_tokens: dead });
    } catch (err) {
      console.error(`push failed: ${err instanceof Error ? err.name : "unknown"}`);
    }
  };
}
