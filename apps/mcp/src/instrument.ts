import { type AssessTask, EyesError, type EyesService, type Providers } from "@eyes/core";
import type { OpsEvent } from "@eyes/web-dashboard";

type Log = (e: OpsEvent) => void;
const errorName = (err: unknown) => (err instanceof Error ? err.name : typeof err);

/**
 * Logs every outbound text, email, payout and vision verdict to the ops event log. Only ids, kinds
 * and outcomes go in: never a phone number, an email address or a message body.
 */
export function instrumentProviders(p: Providers, log: Log): Providers {
  async function logged<T>(kind: string, what: string, task_id: string | null, call: () => Promise<T>) {
    try {
      const out = await call();
      log({ kind, task_id, summary: `${what} sent` });
      return out;
    } catch (err) {
      log({ kind, level: "error", task_id, summary: `${what} failed: ${errorName(err)}` });
      throw err;
    }
  }
  const m = p.messaging;
  return {
    ...p,
    messaging: {
      sendOffer: (to, o) => logged("text", "offer", o.task_id, () => m.sendOffer(to, o)),
      sendCaptureLink: (to, o) => logged("text", "capture link", o.task_id, () => m.sendCaptureLink(to, o)),
      sendAlreadyClaimed: (to, o) =>
        logged("text", "already claimed", null, () => m.sendAlreadyClaimed(to, o)),
      sendPaid: (to, o) => logged("text", "paid", o.task_id, () => m.sendPaid(to, o)),
      sendText: (to, body) => logged("text", "text", null, () => m.sendText(to, body)),
    },
    email: { send: (msg) => logged("email", "email", null, () => p.email.send(msg)) },
    payments: {
      ...p.payments,
      payoutWorker: async (i) => {
        try {
          const out = await p.payments.payoutWorker(i);
          log({
            kind: "payout",
            task_id: i.task_id,
            summary: `payout ${i.amount_cents}c ok`,
            data: { ok: true },
          });
          return out;
        } catch (err) {
          log({
            kind: "payout",
            level: "error",
            task_id: i.task_id,
            summary: `payout ${i.amount_cents}c failed: ${errorName(err)}`,
            data: { ok: false },
          });
          throw err;
        }
      },
    },
    vision: {
      judge: async (i) => {
        const v = await p.vision.judge(i);
        log({
          kind: "vision",
          level: v.answers_question ? "info" : "warn",
          summary: `${v.answers_question ? "answers" : "does not answer"} the question (${Math.round(v.confidence * 100)}%): ${v.reason}`,
          data: {
            answers_question: v.answers_question,
            confidence: v.confidence,
            prominent_faces: v.prominent_faces,
          },
        });
        return v;
      },
    },
  };
}

export function instrumentAssess(assess: AssessTask, log: Log): AssessTask {
  return async (input) => {
    const v = await assess(input);
    log({
      kind: "safety",
      level: v.allowed ? "info" : "warn",
      summary: `${v.allowed ? "allowed" : `refused (${v.category})`} by ${v.layer ?? "none"}`,
      data: { allowed: v.allowed, layer: v.layer, category: v.category, task_type: input.task_type },
    });
    return v;
  };
}

// Background sweeps run every 30 s; only log them when they did something.
const QUIET: Record<string, true> = { expireOverdue: true, retryPayouts: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const field = (value: unknown, key: string): unknown =>
  value && typeof value === "object" ? Reflect.get(value, key) : undefined;
const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/**
 * Logs every service call (MCP tools and their REST mirrors, worker replies, ops resolutions) with
 * the agent id, task id, intent or decision, and the outcome or EyesError code. Never arguments.
 */
export function instrumentService(service: EyesService, log: Log): EyesService {
  const wrapped = { ...service };
  for (const [name, fn] of Object.entries(service)) {
    if (typeof fn !== "function" || name === "authenticate") continue;
    const method = name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const call = async (...args: unknown[]) => {
      const [first, second] = args;
      const agentId = field(first, "allowed_task_types") !== undefined ? text(field(first, "id")) : undefined;
      const input = agentId ? second : first;
      const firstId = text(first);
      const taskId = text(field(input, "task_id")) ?? (firstId && UUID.test(firstId) ? firstId : undefined);
      const details = {
        ...(agentId && { agent_id: agentId }),
        ...(text(field(input, "intent")) && { intent: field(input, "intent") }),
        ...(name === "resolveTask" && { decision: text(second) }),
        // Location calls log the source only, never coordinates.
        ...(name === "updateWorkerLocation" && { source: text(field(second, "source")) }),
      };
      try {
        const out: unknown = await fn.apply(service, args);
        const counts = out && typeof out === "object" ? Object.values(out) : [];
        if (!QUIET[name] || counts.some((n) => typeof n === "number" && n > 0)) {
          log({
            kind: "call",
            task_id: taskId ?? text(field(out, "task_id")) ?? null,
            summary: `${method} ok`,
            data: { method, ok: true, ...details },
          });
        }
        return out;
      } catch (err) {
        const code = err instanceof EyesError ? err.code : errorName(err);
        log({
          kind: "call",
          level: err instanceof EyesError && err.status < 500 ? "warn" : "error",
          task_id: taskId ?? null,
          summary: `${method} ${code}`,
          data: { method, ok: false, error: code, ...details },
        });
        throw err;
      }
    };
    Object.assign(wrapped, { [name]: call });
  }
  return wrapped;
}
