// Pure helpers for the /ops page. server.ts inlines this file (types stripped) into ops.html.
export const POLL_MS = 10000;
export const STATUS_TONE: Record<string, string> = {
  dispatched: "accent",
  claimed: "accent",
  submitted: "accent",
  verified: "success",
  paid: "success",
  needs_review: "danger",
  disputed: "danger",
  expired: "",
  refunded: "",
};
export const LIVE = ["dispatched", "claimed", "submitted"];
export const LEDGER_LABEL: Record<string, string> = {
  topup: "Top-up",
  escrow: "Escrow",
  release: "Release",
  refund: "Refund",
  payout: "Payout",
  fee: "Fee",
};
export const TABS = ["overview", "review", "support", "tasks", "workers", "money", "logs"];

export const usd = (cents: number | null | undefined) => `$${((cents || 0) / 100).toFixed(2)}`;
export const time = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
export const stamp = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "";
export const after = (from: string, to: string) => {
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  return s < 90 ? `+${s}s` : `+${Math.round(s / 60)}m`;
};
export const cut = (text: string | null | undefined, n: number) =>
  text && text.length > n ? `${text.slice(0, n - 1)}…` : text || "";
// Coordinates as a place label: rounded like the worker pages (about 100 m), never full precision.
const COORDS = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
export const nearLabel = (label: string | null | undefined) => {
  const m = COORDS.exec(label || "");
  return m ? `Near ${Number(m[1]).toFixed(3)}, ${Number(m[2]).toFixed(3)}` : label || "";
};
// Before T6.19 the photo check judged the answer; those old reasons are not moderation verdicts.
export const checkReason = (r: string) => (/answers? the question/i.test(r) ? `Old check: ${r}` : r);
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function uptime(s: number) {
  if (s < 3600) return `up ${Math.floor(s / 60)}m`;
  if (s < 86400) return `up ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `up ${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

// Tabs: the URL hash picks one (#review, #support, ...) so reloads and links keep it.
export const tabFor = (hash: string) => (TABS.includes(hash.slice(1)) ? hash.slice(1) : "overview");
// Arrow keys, Home and End move between tabs; null when the key or focus is not a tab move.
export function nextTab(focusedId: string, key: string) {
  const i = TABS.indexOf(focusedId.replace("tab-", ""));
  const next = (
    { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 } as Record<string, number>
  )[key];
  if (i < 0 || next === undefined) return null;
  return TABS[(next + TABS.length) % TABS.length] as string;
}

// Ticket search: open/resolved filter, then a case-insensitive match on id, question, message, task, place.
export type TicketFields = {
  id: number;
  kind?: string;
  status?: string;
  dispute_status?: string | null;
  question?: string | null;
  message?: string | null;
  task_id?: string | null;
  place_label?: string | null;
};
export const ticketOpen = (t: TicketFields) =>
  t.kind === "dispute" ? t.dispute_status === "open" : t.status === "open";
export function filterTickets<T extends TicketFields>(tickets: T[], query: string, status: string) {
  const q = query.trim().toLowerCase();
  return tickets.filter(
    (t) =>
      (!status || (status === "open") === ticketOpen(t)) &&
      (!q ||
        [t.id, t.question, t.message, t.task_id, t.place_label].some((v) =>
          String(v ?? "")
            .toLowerCase()
            .includes(q),
        )),
  );
}

// Event log filters as query params; `before` pages back from the oldest row shown.
export function eventQuery(fields: Record<string, string>, before: number | null) {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    const v = value.trim();
    if (v) p.set(key, v);
  }
  if (before) p.set("before", String(before));
  return p;
}
