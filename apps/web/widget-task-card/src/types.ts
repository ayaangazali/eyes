import type { Answer, AskEyesInput, ToolOutput } from "@eyes/core";

export type Theme = "light" | "dark";
export type Check = "passed" | "pending" | "failed";
export type ToolCall = { name: string; args: Record<string, unknown> };
export type AskArgs = Omit<AskEyesInput, "idempotency_key">;

export type CardState =
  | "quote"
  | "cached"
  | "dispatched"
  | "claimed"
  | "verifying"
  | "answered"
  | "needs_review"
  | "expired_refunded"
  | "rejected_safety"
  | "error";

export type CardData = { as_of: string; sandbox: boolean } & (
  | { kind: "quote"; quote: ToolOutput<"quote_task">; ask: AskArgs; fee_usd: number }
  | { kind: "cached"; ask: AskArgs; fee_usd: number; checked_at: string; answer: Answer }
  | {
      kind: "task";
      task: ToolOutput<"get_task">;
      workers_notified?: number;
      worker?: { distance_m: number; eta_minutes: number };
    }
  | { kind: "rejected"; reason: string }
  | { kind: "error"; message: string; retry: ToolCall }
);
