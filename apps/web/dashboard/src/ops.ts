import { format } from "node:util";
import type { Rpc } from "@eyes/db";

const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW = ["needs_review", "disputed"];
export const STATUSES = [
  "dispatched",
  "claimed",
  "submitted",
  "verified",
  "paid",
  "needs_review",
  "disputed",
  "expired",
  "refunded",
] as const;

type Task = { id: string; status: string; created_at: string; [k: string]: unknown };
type LedgerRow = { type: string; amount_cents: number; created_at: string };
type Worker = { lat: number; lng: number; available: boolean; opted_in: boolean };
export type Feed = { tasks: Task[]; ledger: LedgerRow[]; workers: Worker[]; totals: Record<string, number> };

// ponytail: counts come from the newest `limit` rows of eyes_dashboard_feed; `partial` says when the
// 24h window is longer than that. A count-only SQL function is the upgrade if Eyes ever does 500 tasks a day.
export function summarize(feed: Feed, limit: number, now: Date) {
  const since = now.getTime() - DAY_MS;
  const recent = <T extends { created_at: string }>(rows: T[]) =>
    rows.filter((r) => Date.parse(r.created_at) >= since);
  const tasks24h = recent(feed.tasks);
  const ledger24h = recent(feed.ledger);
  const statuses = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<string, number>;
  for (const t of tasks24h) statuses[t.status] = (statuses[t.status] ?? 0) + 1;
  const money24h: Record<string, number> = { escrow: 0, release: 0, refund: 0, fee: 0, payout: 0, topup: 0 };
  for (const row of ledger24h) money24h[row.type] = (money24h[row.type] ?? 0) + row.amount_cents;
  return {
    since: new Date(since).toISOString(),
    partial: {
      tasks: feed.tasks.length >= limit && tasks24h.length === feed.tasks.length,
      ledger: feed.ledger.length >= limit && ledger24h.length === feed.ledger.length,
      workers: feed.workers.length >= limit,
    },
    statuses,
    money_24h: money24h,
    workers: {
      total: feed.workers.length,
      opted_in: feed.workers.filter((w) => w.opted_in).length,
      online: feed.workers.filter((w) => w.opted_in && w.available).length,
    },
    queue: feed.tasks
      .filter((t) => REVIEW.includes(t.status))
      .map((t) => ({
        ...t,
        commands: {
          refund: `pnpm resolve-task ${t.id} refund "<note>"`,
          release: `pnpm resolve-task ${t.id} release "<note>"`,
        },
      })),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ponytail: best-effort patterns, not a DLP engine. Over-redacting a log line is the cheap failure.
const REDACTIONS: [RegExp, string | ((m: string) => string)][] = [
  [/\/\/[^\s/@]+@/g, "//[redacted]@"],
  [/\b(bearer|basic)\s+[\w.~+/=-]+/gi, "$1 [redacted]"],
  [
    /\b([\w-]*(?:key|token|secret|password|authorization)[\w-]*)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    "$1$2[redacted]",
  ],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]"],
  [/\b(?:sk|rk|pk)_(?:live|test)_\w+|\bwhsec_\w+/g, "[secret]"],
  [/[\w-]{32,}/g, (m) => (UUID.test(m) ? m : "[secret]")],
  [/\+\d[\d ().-]{7,}\d|\(?\b\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, "[phone]"],
];

export function redact(text: string) {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement as string);
  return out;
}

export type OpsEvent = {
  kind: string;
  level?: "info" | "warn" | "error";
  task_id?: string | null;
  summary: string;
  data?: Record<string, unknown>;
};
export type LoggedEvent = Required<OpsEvent> & { at: string };
export interface EventLog {
  log(e: OpsEvent): void;
  /** Newest first. */
  recent(): LoggedEvent[];
  flush(): Promise<void>;
}

/**
 * Redacts every event, keeps the newest `ringSize` in memory (the fallback when the database is down)
 * and writes them to the events table in batches. A failed write drops that batch from the database
 * only; it stays in the ring. Each `sinks` entry (ClickHouse) also gets every redacted event.
 */
export function createEventLog(
  rpc?: Rpc,
  ringSize = 500,
  flushMs = 2000,
  sinks: ((e: LoggedEvent) => void)[] = [],
): EventLog {
  const ring: LoggedEvent[] = [];
  let pending: LoggedEvent[] = [];
  const flush = async () => {
    if (!rpc || pending.length === 0) return;
    const batch = pending;
    pending = [];
    await rpc("eyes_log_events", { p_events: batch }).catch((err: unknown) =>
      // Not console.error: that would log the failure as an event and loop.
      process.stderr.write(`event log write failed: ${redact(String(err))}\n`),
    );
  };
  if (rpc) setInterval(flush, flushMs).unref();
  return {
    log(e: OpsEvent) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(redact(JSON.stringify(e.data ?? {})));
      } catch {
        data = { redacted: true };
      }
      const event = {
        at: new Date().toISOString(),
        kind: e.kind,
        level: e.level ?? "info",
        task_id: e.task_id ?? null,
        summary: redact(e.summary).slice(0, 2000),
        data,
      };
      ring.push(event);
      if (ring.length > ringSize) ring.shift();
      if (rpc && pending.length < 5000) pending.push(event);
      for (const sink of sinks) sink(event);
    },
    /** Newest first. */
    recent: () => ring.toReversed(),
    flush,
  };
}

/** Sends every console.error/warn line to the event log as kind "log", redacted. */
export function captureConsole(log: EventLog["log"], target: Pick<Console, "error" | "warn"> = console) {
  for (const level of ["error", "warn"] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      original(...args);
      log({ kind: "log", level, summary: format(...args) });
    };
  }
}
