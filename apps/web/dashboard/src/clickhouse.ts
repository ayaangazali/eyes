import type { Rpc } from "@eyes/db";
import type { LoggedEvent } from "./ops.ts";

// Written by Postgres triggers (migration 015), so the app's event log never sees them.
const TRIGGER_KINDS: Record<string, true> = { task: true, ledger: true, ticket: true };

/**
 * Copies new task, ledger and ticket events from Postgres to `push` every `intervalMs`. Starts at
 * the newest row (no backfill: the cursor is not persisted, so a backfill would duplicate rows on
 * every restart). ponytail: reads the newest 500 events per tick; more than 500 in one tick loses
 * the oldest. A persisted cursor and an `id > cursor` SQL function if Eyes ever gets that busy.
 */
export function mirrorTriggerEvents(rpc: Rpc, push: (e: LoggedEvent) => void, intervalMs = 2000) {
  type Row = LoggedEvent & { id: number | string; at: string | Date };
  let cursor: number | null = null;
  const tick = async () => {
    try {
      const rows = await rpc<Row>("eyes_events", {
        p_limit: 500,
        p_kind: null,
        p_level: null,
        p_q: null,
        p_task_id: null,
        p_before: null,
      });
      const newest = Math.max(cursor ?? 0, ...rows.map((r) => Number(r.id)));
      if (cursor !== null) {
        for (const r of rows.toReversed()) {
          if (Number(r.id) <= cursor || !TRIGGER_KINDS[r.kind]) continue;
          const { id: _, at, ...e } = r;
          push({ ...e, at: new Date(at).toISOString(), data: e.data ?? {} });
        }
      }
      cursor = newest;
    } catch (err) {
      process.stderr.write(`clickhouse mirror read failed: ${err instanceof Error ? err.message : err}\n`);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

export type ClickHouseConfig = { url: string; user: string; password: string; database: string };
export type ClickHouseRow = {
  ts: string;
  kind: string;
  name: string;
  status: string;
  ms: number;
  task_id: string | null;
  agent_id: string | null;
  worker_id: string | null;
  detail: string;
};
export interface ClickHouseSink {
  push(e: LoggedEvent): void;
  flush(): Promise<void>;
  /** Rows dropped because the queue was full (ClickHouse down or slow). */
  dropped(): number;
  query<T>(sql: string): Promise<T[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (value: unknown) => (typeof value === "string" && UUID.test(value) ? value : null);

/** CLICKHOUSE_* from the environment, or null (the sink is off) when CLICKHOUSE_URL is unset. */
export function clickHouseConfig(env: Record<string, string | undefined>): ClickHouseConfig | null {
  if (!env.CLICKHOUSE_URL) return null;
  return {
    url: env.CLICKHOUSE_URL.replace(/\/+$/, ""),
    user: env.CLICKHOUSE_USER || "default",
    password: env.CLICKHOUSE_PASSWORD ?? "",
    database: env.CLICKHOUSE_DATABASE || "eyes",
  };
}

/**
 * One events row. `name` is the low-cardinality thing the dashboards group by (route, tool, ledger
 * type), `status` the outcome (HTTP status, ok or error code, the status a task moved into). The
 * event is already redacted by the event log.
 */
export function toRow(e: LoggedEvent): ClickHouseRow {
  const d = e.data;
  const pick = (...keys: string[]) =>
    keys.map((k) => d[k]).find((v) => v !== undefined && v !== null && v !== "");
  const failed = d.ok === false ? "failed" : d.ok === true ? "ok" : undefined;
  return {
    ts: e.at,
    kind: e.kind,
    name: String(pick("path", "method", "provider", "type", "layer") ?? e.summary).slice(0, 200),
    status: String(pick("status", "error", "to", "outcome") ?? failed ?? e.level),
    ms: typeof d.ms === "number" && d.ms >= 0 ? Math.round(d.ms) : 0,
    task_id: uuid(e.task_id),
    agent_id: uuid(d.agent_id),
    worker_id: uuid(d.worker_id),
    detail: JSON.stringify({ level: e.level, summary: e.summary, data: d }),
  };
}

/**
 * Batches events into ClickHouse over its HTTP interface (`INSERT ... FORMAT JSONEachRow`), every
 * `flushMs` or as soon as `batch` rows are waiting. Never throws and never blocks the caller: when
 * ClickHouse is down the queue keeps the newest `maxQueue` rows (counting the dropped ones) and
 * retries with backoff, doubling from `flushMs` to `maxBackoffMs`.
 */
export function createClickHouseSink(
  cfg: ClickHouseConfig,
  opts: {
    fetch?: typeof fetch;
    flushMs?: number;
    batch?: number;
    maxQueue?: number;
    maxBackoffMs?: number;
    now?: () => number;
  } = {},
): ClickHouseSink & { stop(): void } {
  const {
    fetch: send = fetch,
    flushMs = 2000,
    batch = 500,
    maxQueue = 10_000,
    maxBackoffMs = 60_000,
    now = Date.now,
  } = opts;
  const auth = `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64")}`;
  const endpoint = (params: Record<string, string>) =>
    `${cfg.url}/?${new URLSearchParams({ database: cfg.database, ...params })}`;
  let queue: ClickHouseRow[] = [];
  let dropped = 0;
  let failures = 0;
  let retryAt = 0;
  let flushing: Promise<void> | null = null;

  const post = async (url: string, body: string) => {
    const res = await send(url, {
      method: "POST",
      headers: { authorization: auth, "content-type": "text/plain" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.slice(0, 200)}`);
    return text;
  };

  const run = async () => {
    while (queue.length > 0 && now() >= retryAt) {
      const rows = queue.slice(0, batch);
      try {
        await post(
          endpoint({ query: "INSERT INTO events FORMAT JSONEachRow", date_time_input_format: "best_effort" }),
          rows.map((r) => JSON.stringify(r)).join("\n"),
        );
        queue = queue.slice(rows.length);
        failures = 0;
        retryAt = 0;
      } catch (err) {
        failures++;
        retryAt = now() + Math.min(flushMs * 2 ** failures, maxBackoffMs);
        // Not console.error: captureConsole would turn the failure into another event.
        process.stderr.write(
          `clickhouse insert failed (${failures}): ${err instanceof Error ? err.message : err}\n`,
        );
      }
    }
  };
  const flush = () => {
    flushing ??= run().finally(() => {
      flushing = null;
    });
    return flushing;
  };
  const timer = setInterval(flush, flushMs);
  timer.unref();

  return {
    push(e) {
      queue.push(toRow(e));
      if (queue.length > maxQueue) {
        dropped += queue.length - maxQueue;
        queue = queue.slice(-maxQueue);
      }
      if (queue.length >= batch) void flush();
    },
    flush,
    dropped: () => dropped,
    async query<T>(sql: string) {
      const text = await post(endpoint({ default_format: "JSONEachRow" }), sql);
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
    },
    stop: () => clearInterval(timer),
  };
}

type Rows = {
  requests: { minute: string; requests: number; errors: number }[];
  latency: { minute: string; p95: number }[];
  tasks: { hour: string; status: string; tasks: number }[];
  payouts: { hour: string; ok: number; failed: number }[];
};
export type Series = {
  source: "clickhouse" | "postgres";
  minutes: string[];
  requests: number[];
  errors: number[];
  p95_ms: number[];
  hours: string[];
  tasks: Record<string, number[]>;
  payouts: { ok: number[]; failed: number[] };
};
const MINUTES = 120;
const HOURS = 24;
/** "2026-10-17 20:01:00", the way ClickHouse prints a DateTime('UTC'). */
const bucket = (ms: number, size: number) =>
  new Date(Math.floor(ms / size) * size).toISOString().slice(0, 19).replace("T", " ");

/** The dashboard's time series straight from the materialized views in packages/db/clickhouse. */
export async function readClickHouseSeries(ch: Pick<ClickHouseSink, "query">): Promise<Rows> {
  const [requests, latency, tasks, payouts] = await Promise.all([
    // Inner aliases (m, r, l, t) so the output names never shadow the columns they aggregate.
    ch.query<Rows["requests"][number]>(
      `select toString(m) as minute, sum(r) as requests, sumIf(r, s >= 500) as errors
       from (select minute as m, requests as r, toUInt16OrZero(status) as s from requests_per_minute
             where m >= now() - interval ${MINUTES} minute)
       group by m`,
    ),
    ch.query<Rows["latency"][number]>(
      `select toString(m) as minute, round(quantilesMerge(0.5, 0.95)(l)[2]) as p95
       from (select minute as m, latency as l from latency_per_minute where m >= now() - interval ${MINUTES} minute)
       group by m`,
    ),
    ch.query<Rows["tasks"][number]>(
      `select toString(h) as hour, status, sum(t) as tasks
       from (select hour as h, status, tasks as t from tasks_per_hour where h >= now() - interval ${HOURS} hour)
       group by h, status`,
    ),
    ch.query<Rows["payouts"][number]>(
      `select toString(toStartOfHour(ts)) as hour, countIf(status = 'ok') as ok, countIf(status != 'ok') as failed
       from events where kind = 'payout' and ts >= now() - interval ${HOURS} hour group by hour`,
    ),
  ]);
  return { requests, latency, tasks, payouts };
}

/**
 * The same series without ClickHouse: requests and latency from the in-memory event ring (newest
 * 500 events only), tasks and payouts from the Postgres dashboard feed (tasks by creation hour and
 * current status, payout ledger rows).
 */
export function fallbackRows(
  recent: LoggedEvent[],
  feed: { tasks: { status: string; created_at: string }[]; ledger: { type: string; created_at: string }[] },
): Rows {
  const minute = 60_000;
  const hour = 60 * minute;
  const requests = new Map<string, { minute: string; requests: number; errors: number; ms: number[] }>();
  for (const e of recent) {
    if (e.kind !== "http" && e.kind !== "webhook") continue;
    const key = bucket(Date.parse(e.at), minute);
    const row = requests.get(key) ?? { minute: key, requests: 0, errors: 0, ms: [] };
    row.requests++;
    if (Number(e.data.status) >= 500) row.errors++;
    if (typeof e.data.ms === "number") row.ms.push(e.data.ms);
    requests.set(key, row);
  }
  const tasks = new Map<string, Rows["tasks"][number]>();
  for (const t of feed.tasks) {
    const key = `${bucket(Date.parse(t.created_at), hour)} ${t.status}`;
    const row = tasks.get(key) ?? {
      hour: bucket(Date.parse(t.created_at), hour),
      status: t.status,
      tasks: 0,
    };
    row.tasks++;
    tasks.set(key, row);
  }
  const payouts = new Map<string, Rows["payouts"][number]>();
  for (const l of feed.ledger) {
    if (l.type !== "payout") continue;
    const key = bucket(Date.parse(l.created_at), hour);
    const row = payouts.get(key) ?? { hour: key, ok: 0, failed: 0 };
    row.ok++;
    payouts.set(key, row);
  }
  const rows = [...requests.values()];
  return {
    requests: rows,
    latency: rows.map((r) => {
      const sorted = r.ms.toSorted((a, b) => a - b);
      return {
        minute: r.minute,
        p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
      };
    }),
    tasks: [...tasks.values()],
    payouts: [...payouts.values()],
  };
}

/** Fills every minute of the last 2 h and every hour of the last 24 h, zero where nothing happened. */
export function buildSeries(rows: Rows, now: Date, source: Series["source"]): Series {
  const minute = 60_000;
  const hour = 60 * minute;
  const minutes = Array.from({ length: MINUTES }, (_, i) =>
    bucket(now.getTime() - (MINUTES - 1 - i) * minute, minute),
  );
  const hours = Array.from({ length: HOURS }, (_, i) => bucket(now.getTime() - (HOURS - 1 - i) * hour, hour));
  const fill = <T extends Record<string, unknown>>(
    keys: string[],
    list: T[],
    by: keyof T,
    value: keyof T,
  ) => {
    const map = new Map(list.map((r) => [String(r[by]), Number(r[value]) || 0]));
    return keys.map((k) => map.get(k) ?? 0);
  };
  const statuses = [...new Set(rows.tasks.map((t) => t.status))].sort();
  return {
    source,
    minutes,
    requests: fill(minutes, rows.requests, "minute", "requests"),
    errors: fill(minutes, rows.requests, "minute", "errors"),
    p95_ms: fill(minutes, rows.latency, "minute", "p95"),
    hours,
    tasks: Object.fromEntries(
      statuses.map((s) => [
        s,
        fill(
          hours,
          rows.tasks.filter((t) => t.status === s),
          "hour",
          "tasks",
        ),
      ]),
    ),
    payouts: {
      ok: fill(hours, rows.payouts, "hour", "ok"),
      failed: fill(hours, rows.payouts, "hour", "failed"),
    },
  };
}
