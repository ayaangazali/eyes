import { createHash } from "node:crypto";
import { distanceMeters } from "@eyes/core";
import type { Rpc } from "@eyes/db";
import type { EventLog, LoggedEvent } from "@eyes/web-dashboard";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { OpsEnv } from "./ops-auth.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADERS = { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
const BAD_CURSOR = {
  error: "invalid_cursor",
  message: "This page cursor is malformed or belongs to other filters. Reload the list from its first page.",
};

type Filters = Record<string, string | null>;
type Cursor = { at: string; id: string };

const filterKey = (filters: Filters) =>
  createHash("sha256")
    .update(JSON.stringify(Object.entries(filters).sort()))
    .digest("base64url")
    .slice(0, 12);

/** Opaque cursor: base64url of [created_at, id, filter key]. A cursor only works with the filters it came from. */
export function encodeCursor(at: string, id: string | number, filters: Filters) {
  return Buffer.from(JSON.stringify([at, String(id), filterKey(filters)])).toString("base64url");
}

/** null: no cursor given. "bad": malformed, or made under other filters. */
export function decodeCursor(text: string | undefined, filters: Filters): Cursor | null | "bad" {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 3) return "bad";
    const [at, id, key] = parsed;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at)) || typeof id !== "string") return "bad";
    return key === filterKey(filters) ? { at, id } : "bad";
  } catch {
    return "bad";
  }
}

const limitOf = (text: string | undefined, fallback: number, max: number) => {
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
};
const oneOf = (text: string | undefined, allowed: string[]) => (text && allowed.includes(text) ? text : null);
const search = (text: string | undefined) => text?.trim().slice(0, 200) || null;
/** The browser's IANA time zone, so dates match as it shows them; anything else falls back to UTC. */
const zoneOf = (text: string | undefined) => {
  if (!text || text.length > 64) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: text }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
};
const instant = (text: string | undefined) =>
  text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : null;
/** Search and date window params shared by the dated lists: `tz`, `from`, `to` (ISO, `to` exclusive). */
const dated = (q: Record<string, string>) => ({ tz: zoneOf(q.tz), from: instant(q.from), to: instant(q.to) });
const datedArgs = (f: { tz: string | null; from: string | null; to: string | null }) => ({
  p_tz: f.tz,
  p_from: f.from,
  p_to: f.to,
});
/** A date as the ops page's `stamp()` shows it in that zone: "Oct 17, 08:13:45 PM". */
export const shownAt = (iso: string, tz: string | null) =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: tz ?? "UTC",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
/** Uptime checks: tagged by the request log, or a /healthz row logged before the tag existed. */
const isMonitor = (e: { data?: Record<string, unknown> }) =>
  e.data?.monitor === true || e.data?.path === "/healthz";

type Row = Record<string, unknown> & { total?: number | string };
/** Drops the window-function columns and the cursor of the last row when the page is full. */
function page<T extends Row>(rows: T[], limit: number, filters: Filters, at: keyof T, id: keyof T) {
  const last = rows.at(-1);
  return {
    rows: rows.map(({ total: _, total_cents: __, ...rest }) => rest),
    total: Number(rows[0]?.total ?? 0),
    next_cursor:
      last && rows.length === limit ? encodeCursor(String(last[at]), String(last[id]), filters) : null,
  };
}

/** Distance from the place to where the answer was taken, without exposing either point. */
function withDistance<T extends Row>(row: T) {
  const { submission_lat, submission_lng, worker_id: _, ...rest } = row;
  const place = { lat: Number(row.lat), lng: Number(row.lng) };
  return {
    ...rest,
    distance_m:
      submission_lat == null || submission_lng == null
        ? null
        : Math.round(distanceMeters(place, { lat: Number(submission_lat), lng: Number(submission_lng) })),
  };
}

/**
 * The ops lists, one page at a time, newest first: GET /ops/events, /ops/tickets, /ops/tasks and
 * /ops/ledger with `limit` and an opaque `cursor`, plus filters and `q` search applied in Postgres.
 * /ops/events also takes `since` (a cursor) and returns only newer rows, for live polling.
 */
export function opsLists(deps: { rpc: Rpc; events?: EventLog; operator: MiddlewareHandler<OpsEnv> }) {
  const { rpc, operator } = deps;
  const routes = new Hono<OpsEnv>();
  const bad = (c: Context) => c.json(BAD_CURSOR, 400, HEADERS);

  routes.get("/ops/events", operator, async (c) => {
    const q = c.req.query();
    const filters = {
      kind: q.kind || null,
      level: oneOf(q.level, ["info", "warn", "error"]),
      q: search(q.q),
      task_id: q.task_id && UUID.test(q.task_id) ? q.task_id : null,
      ...dated(q),
    };
    const limit = limitOf(q.limit, 100, 200);
    const monitors = q.monitors === "1";
    const before = decodeCursor(q.cursor, filters);
    const after = decodeCursor(q.since, filters);
    if (before === "bad" || after === "bad") return bad(c);
    try {
      const rows = await rpc<LoggedEvent & { id: number }>("eyes_events_page", {
        p_limit: limit,
        p_kind: filters.kind,
        p_level: filters.level,
        p_q: filters.q,
        p_task_id: filters.task_id,
        p_before_at: before?.at ?? null,
        p_before_id: before ? Number(before.id) : null,
        p_after_at: after?.at ?? null,
        p_after_id: after ? Number(after.id) : null,
        ...datedArgs(filters),
      });
      // Cursors come from the unfiltered rows, so hiding monitors only makes a page shorter.
      const { rows: all, next_cursor } = page(rows, limit, filters, "at", "id");
      const events = monitors ? all : all.filter((e) => !isMonitor(e));
      const first = rows[0];
      return c.json(
        {
          source: "database",
          events,
          // Live polling is newest-first and capped, so a burst bigger than one page also pages back.
          next_cursor: after ? null : next_cursor,
          newest_cursor: first ? encodeCursor(String(first.at), first.id, filters) : (q.since ?? null),
        },
        200,
        HEADERS,
      );
    } catch (err) {
      console.error("ops events: database read failed:", err instanceof Error ? err.message : err);
      const needle = filters.q?.toLowerCase();
      const events = (deps.events?.recent() ?? []).filter(
        (e) =>
          (!filters.kind || e.kind === filters.kind) &&
          (!filters.level || e.level === filters.level) &&
          (!filters.task_id || e.task_id === filters.task_id) &&
          (monitors || !isMonitor(e)) &&
          (!filters.from || e.at >= filters.from) &&
          (!filters.to || e.at < filters.to) &&
          // What the row shows: the date, the level and source, the summary.
          (!needle ||
            `${shownAt(e.at, filters.tz)} ${e.level} ${e.kind} ${e.summary}`.toLowerCase().includes(needle)),
      );
      return c.json(
        {
          source: "memory",
          events: after ? [] : events.slice(0, limit),
          next_cursor: null,
          newest_cursor: null,
        },
        200,
        HEADERS,
      );
    }
  });

  routes.get("/ops/tickets", operator, async (c) => {
    const q = c.req.query();
    const filters = {
      q: search(q.q),
      state: oneOf(q.state, ["open", "resolved"]),
      kind: oneOf(q.kind, ["manual_review", "dispute"]),
    };
    const limit = limitOf(q.limit, 50, 200);
    const before = decodeCursor(q.cursor, filters);
    if (before === "bad") return bad(c);
    const rows = await rpc<Row>("eyes_tickets_page", {
      p_limit: limit,
      p_q: filters.q,
      p_state: filters.state,
      p_kind: filters.kind,
      p_before_at: before?.at ?? null,
      p_before_id: before ? Number(before.id) : null,
    });
    const { rows: tickets, total, next_cursor } = page(rows, limit, filters, "created_at", "id");
    return c.json({ tickets: tickets.map(withDistance), total, next_cursor }, 200, HEADERS);
  });

  routes.get("/ops/tasks", operator, async (c) => {
    const q = c.req.query();
    const filters = { q: search(q.q), status: q.status || null, ...dated(q) };
    const limit = limitOf(q.limit, 50, 200);
    const before = decodeCursor(q.cursor, filters);
    if (before === "bad" || (before && !UUID.test(before.id))) return bad(c);
    const rows = await rpc<Row>("eyes_tasks_page", {
      p_limit: limit,
      p_q: filters.q,
      p_status: filters.status,
      p_before_at: before?.at ?? null,
      p_before_id: before?.id ?? null,
      ...datedArgs(filters),
    });
    const { rows: tasks, total, next_cursor } = page(rows, limit, filters, "created_at", "id");
    return c.json({ tasks: tasks.map(withDistance), total, next_cursor }, 200, HEADERS);
  });

  routes.get("/ops/ledger", operator, async (c) => {
    const q = c.req.query();
    const filters = { q: search(q.q), type: q.type || null, ...dated(q) };
    const limit = limitOf(q.limit, 50, 200);
    const before = decodeCursor(q.cursor, filters);
    if (before === "bad" || (before && !UUID.test(before.id))) return bad(c);
    const rows = await rpc<Row>("eyes_ledger_page", {
      p_limit: limit,
      p_q: filters.q,
      p_type: filters.type,
      p_before_at: before?.at ?? null,
      p_before_id: before?.id ?? null,
      ...datedArgs(filters),
    });
    const { rows: ledger, total, next_cursor } = page(rows, limit, filters, "created_at", "id");
    return c.json(
      { ledger, total, total_cents: Number(rows[0]?.total_cents ?? 0), next_cursor },
      200,
      HEADERS,
    );
  });

  return routes;
}
