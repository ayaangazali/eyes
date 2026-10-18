// The Logs tab: icons for level and source, compact rows with details, and merging pages and live
// events without duplicates. server.ts inlines this file (types stripped) into ops.html.
import { icon } from "./overview.ts";

export type LogEvent = {
  id?: number;
  at: string;
  kind: string;
  level: string;
  summary: string;
  task_id?: string | null;
  data?: Record<string, unknown>;
};

/** Event kinds as people say them, with their outline icon. */
export const SOURCES: Record<string, [string, string]> = {
  http: ["Web request", "i-globe"],
  mcp: ["MCP", "i-plug"],
  call: ["Agent call", "i-plug"],
  task: ["Task", "i-pin"],
  ledger: ["Money", "i-cash"],
  payout: ["Payout", "i-cash"],
  text: ["Texting", "i-message"],
  reply: ["Text reply", "i-message"],
  email: ["Email", "i-mail"],
  webhook: ["Webhook", "i-plug"],
  safety: ["Safety check", "i-shield"],
  vision: ["Photo check", "i-camera"],
  ticket: ["Support", "i-message"],
  ops: ["Operator", "i-eye"],
  auth: ["Sign-in", "i-shield"],
  log: ["Server log", "i-info"],
};
export const LEVELS: Record<string, [string, string]> = {
  info: ["Info", "i-info"],
  warn: ["Warning", "i-alert"],
  error: ["Error", "i-error"],
};
export const sourceOf = (kind: string): [string, string] => SOURCES[kind] ?? [kind, "i-info"];
export const levelOf = (level: string): [string, string] => LEVELS[level] ?? [level, "i-info"];

/** Labelled icon in a span that carries the tone. */
export function badgeIcon(doc: Document, [label, id]: [string, string], cls: string) {
  const span = doc.createElement("span");
  span.className = cls;
  span.append(icon(doc, id, label));
  return span;
}

export const eventKey = (e: LogEvent) => (e.id == null ? `${e.at} ${e.kind} ${e.summary}` : String(e.id));

/** `head` then `tail`, newest first, each event once (by id). */
export function mergeEvents(head: LogEvent[], tail: LogEvent[]) {
  const seen = new Set<string>();
  return [...head, ...tail].filter((e) => {
    const key = eventKey(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The expanded part of a row: full summary, the task to filter by, and the redacted data. */
export function eventDetail(doc: Document, e: LogEvent, filterTask: (id: string) => void) {
  const box = doc.createElement("div");
  box.className = "ev-detail";
  const summary = doc.createElement("p");
  summary.className = "ev-detail__summary";
  summary.textContent = e.summary;
  box.append(summary);
  if (e.task_id) {
    const task = e.task_id;
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "ui-button ui-button--ghost ui-button--sm";
    button.textContent = `Only task ${task.slice(0, 8)}`;
    button.addEventListener("click", (ev) => {
      ev.stopPropagation();
      filterTask(task);
    });
    box.append(button);
  }
  if (e.data && Object.keys(e.data).length) {
    const pre = doc.createElement("pre");
    pre.className = "ev-detail__data";
    pre.textContent = JSON.stringify(e.data, null, 2);
    box.append(pre);
  }
  return box;
}
