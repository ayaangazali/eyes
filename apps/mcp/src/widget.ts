// One MCP Apps widget for ChatGPT and Claude: an HTML resource (text/html;profile=mcp-app) with the
// Eyes design system inlined and a small vanilla script. It speaks the MCP Apps postMessage bridge
// (ui/initialize, ui/notifications/tool-result), which both hosts implement, and falls back to
// window.openai.toolOutput. It renders by result shape: quote/draft, task (confirm_ask, get_task,
// await_answer) or balance. Card buttons call tools through call(): window.openai.callTool in
// ChatGPT, the MCP Apps tools/call request elsewhere, and render the result into the same card.
// No React, no bundler: the markup reuses the classes in packages/ui.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// State-v2 scene cards use a new canonical URI so hosts cannot reuse the old global-task script.
export const WIDGET_URI = "ui://eyes/scene-card-v2.html";
export const WIDGET_MIME = "text/html;profile=mcp-app";

/** Photos load from InsForge storage; signed URLs redirect to the CDN. */
/** Tools the card's buttons call; tools/list marks them callable from the widget in both hosts. */
export const WIDGET_CALLABLE = [
  "quote_task",
  "confirm_ask",
  "get_task",
  "list_tasks",
  "await_answer",
  "cancel_task",
  "accept_answer",
  "dispute_answer",
  "get_balance",
  "report_classifier",
  "get_classifier_report",
];

export const WIDGET_CSP = {
  connectDomains: [],
  resourceDomains: ["https://pagp38bu.us-west.insforge.app", "https://cdn.insforge.dev"],
};

/** Tool-level `_meta` for the widget. server.ts adds `ui.resourceUri` on tools/list (mcp-use strips it here). */
export function widgetToolMeta(invoking: string, invoked: string) {
  return {
    "openai/outputTemplate": WIDGET_URI,
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

/**
 * Resource-level `_meta` for both hosts. `base` is the public origin (https://api.eyes.pictures).
 * Claude checks `ui.domain` against the connector URL and refuses to render on a mismatch, so the
 * domain goes out only to Claude: the first 32 hex characters of SHA-256 of `${base}/mcp`, plus
 * `.claudemcpcontent.com`. Other hosts get no `ui.domain` (spec default: a per-conversation
 * sandbox); ChatGPT reads `openai/widgetDomain`.
 */
export function widgetResourceMeta(base: string, claude: boolean) {
  const domain = `${createHash("sha256").update(`${base}/mcp`).digest("hex").slice(0, 32)}.claudemcpcontent.com`;
  return {
    ui: { csp: WIDGET_CSP, prefersBorder: false, ...(claude ? { domain } : {}) },
    "openai/widgetCSP": { connect_domains: [], resource_domains: WIDGET_CSP.resourceDomains },
    "openai/widgetDomain": base,
    "openai/widgetPrefersBorder": false,
    "openai/widgetDescription":
      "An Eyes card: a quote, a live task with its photo and checks, or your balance.",
  };
}

const file = (name: string) => readFileSync(new URL(import.meta.resolve(`@eyes/ui/${name}`)), "utf8");

const CSS = `
html,body{margin:0;background:transparent}
body.ui{background:transparent}
.w{padding:2px}
.w .ui-card{max-width:40rem}
.w .ui-steps{margin:0}
.w .ui-notice{margin:0}
.w .ui-viewfinder img{display:block}
.w .big{font-size:2rem;font-weight:600;letter-spacing:-.02em;line-height:1.1}
.w .ui-card__actions:has([data-field="reason"]){grid-auto-flow:row;grid-template-columns:repeat(2,minmax(0,1fr))}
.w .ui-card__actions [data-field="reason"]{grid-column:1/-1;grid-row:1;min-width:0}
.w .ui-card__actions:has([data-act="accept"],[data-accepted]) [data-act="refresh"]{grid-column:1/-1}
.w .ui-card__actions[data-retry]{grid-auto-flow:row;grid-template-columns:minmax(0,1fr)}
.w .ui-card__actions[data-retry] .ui-input{min-width:0}
.w .row{display:flex;flex-wrap:wrap;gap:.25rem 1rem;align-items:baseline}
.w .scene-actions{display:flex;flex-wrap:wrap;gap:var(--eyes-space-2);border-top:1px solid var(--eyes-border-subtle);padding-top:var(--eyes-space-4)}
.w [data-history] summary{cursor:pointer;min-height:var(--eyes-tap);padding-block:var(--eyes-space-3)}
.w [data-record]{justify-content:flex-start;text-align:left;white-space:normal;margin-bottom:var(--eyes-space-2)}
.w [data-identity]{overflow-wrap:anywhere}
`;

export const WIDGET_SCRIPT = String.raw`
const root = document.getElementById("root");
let seq = 0, contextCapability = null, contextRevision = 0;
let readFlight = null, refreshTimer = null, tornDown = false;
let bridgeReady = Boolean(window.openai?.callTool), hostTarget = null, hostTargetTask = null, hostTargetKey = null, hostTargetInitial = false;
const records = new Map(), RECENT_LIMIT = 20;
const UNRESOLVED_CONFIRMATION = "The earlier confirmation may already be active. Current availability does not prove that nothing was charged. Retry the same confirmation to resolve it.";
function uuidV7() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = Date.now();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6] & 15) | 112;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}
function makeState(key = null, taskId = null) {
  return { id: key ? "intent:" + key : taskId ? "task:" + taskId : "unscoped", askKey: key,
    input: {}, last: null, submitted: null, completed: null, retry: null, uncertain: false, edited: {},
    refusal: null, askPending: false, acceptancePending: false, actionsPending: 0, version: 0,
    previousQuestion: "", isNew: false, error: null, separate: false };
}
let state = makeState();
let saved;
try { saved = window.openai?.widgetState?.privateContent ?? window.openai?.widgetState; } catch {}
if (!saved && /^eyes\.(intent|task)\./.test(window.name)) {
  try {
    const local = JSON.parse(window.sessionStorage.getItem("eyes.card." + window.name));
    const active = local?.version === 2 && Array.isArray(local.records)
      ? local.records.slice(0, RECENT_LIMIT).find(r => r?.id === local.active) : local;
    if (active?.askKey && window.name === "eyes.intent." + active.askKey ||
        active?.completed?.task_id && window.name === "eyes.task." + active.completed.task_id) saved = local;
  } catch {}
}
if (saved) {
  const entries = saved.version === 2 && Array.isArray(saved.records) ? saved.records.slice(0, RECENT_LIMIT) : [saved];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const initial = makeState(typeof entry.askKey === "string" ? entry.askKey : null, entry.completed?.task_id);
    const record = Object.assign(initial, entry,
      { id: initial.id, askPending: false, acceptancePending: false, actionsPending: 0, version: 0, refusal: null, unvalidated: Boolean(entry.completed) });
    if (record.id !== "unscoped") records.set(record.id, record);
  }
  state = records.get(saved.active) ?? records.get(saved.askKey ? "intent:" + saved.askKey : "task:" + saved.completed?.task_id) ?? state;
}
const pending = new Map();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (n) => '<svg class="ui-icon" aria-hidden="true"><use href="#i-' + n + '"></use></svg>';
const usd = (n) => "$" + Number(n ?? 0).toFixed(2);
const time = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
const label = (s) => esc(String(s).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));
const TYPES = { is_open: "Open now?", line_length: "Line length", in_stock: "In stock?", photo_of_place: "Photo of place", price_check: "Price check", crowd_level: "Crowd level", other_public: "Look at a public place" };
function recordData(record) {
  const { id, input, last, askKey, retry, submitted, completed, uncertain, edited, previousQuestion, isNew } = record;
  return { id, input, last, askKey, retry, submitted, completed, uncertain, edited, previousQuestion, isNew };
}
function remember(record) {
  if (record.id === "unscoped") return true;
  if (!records.has(record.id) && records.size >= RECENT_LIMIT) {
    const removable = [...records.values()].find(r => r !== state && !r.uncertain && !r.askPending && !r.actionsPending);
    if (!removable) return false;
    records.delete(removable.id);
  }
  records.set(record.id, record);
  return true;
}
function saveDraft() {
  if (state.id !== "unscoped") remember(state);
  const envelope = { version: 2, active: state.id, records: [...records.values()].map(recordData) };
  let durable = false;
  try {
    if (window.openai?.setWidgetState) {
      const context = taskContext();
      window.openai.setWidgetState({ ...(context && { modelContent: context }), privateContent: envelope });
      durable = true;
    }
  } catch {}
  const name = state.askKey ? "eyes.intent." + state.askKey : state.completed?.task_id ? "eyes.task." + state.completed.task_id : null;
  if (name) {
    window.name = name;
    try { window.sessionStorage.setItem("eyes.card." + name, JSON.stringify(envelope)); durable = true; } catch {}
  }
  return durable;
}
function captureDraft() {
  if (state.submitted || state.retry) return;
  for (const name of ["question", "location", "bounty_usd"]) {
    const el = root.querySelector('[data-field="' + name + '"]');
    if (!el || el.value === el.defaultValue) continue;
    state.input[name] = name === "bounty_usd" ? Number(el.value) : el.value;
    state.edited[name] = true;
  }
  const ask = root.querySelector('[data-act="ask"]');
  if (ask && state.input.bounty_usd !== undefined) ask.textContent = "Ask for " + usd(state.input.bounty_usd);
}
function current(owner, version) { return owner === state && owner.version === version && !tornDown && root.isConnected; }
function activate(record) {
  if (record === state) return true;
  captureDraft();
  if (!saveDraft() && (state.uncertain || state.askPending)) {
    state.error = "This confirmation may already have been sent. Storage is unavailable; resolve it here before changing checks.";
    paint();
    return false;
  }
  if (!remember(record)) {
    state.error = "Recent checks are full of unresolved requests. Resolve a pending confirmation before starting another.";
    paint();
    return false;
  }
  state.version++;
  state = record;
  state.version++;
  contextRevision++;
  state.contextSent = null;
  root.innerHTML = "";
  scheduleRefresh();
  return true;
}
function prefill(args, fresh = false) {
  captureDraft();
  hostTargetTask = typeof args.task_id === "string" ? args.task_id : null;
  hostTargetInitial = !state.last && !state.completed && !state.isNew && !Object.keys(args).length;
  const key = typeof args.idempotency_key === "string" && args.idempotency_key ? args.idempotency_key : null;
  hostTargetKey = key;
  let record;
  if (key) {
    const known = records.get("intent:" + key);
    record = known ?? makeState(key);
    if ((fresh || !known || record === state) && !activate(record)) return;
  } else if (args.task_id) {
    const known = [...records.values()].find(r => r.completed?.task_id === args.task_id);
    record = known ?? makeState(null, args.task_id);
    if ((fresh || !known || record === state) && !activate(record)) return;
  } else {
    record = !state.completed && !state.submitted ? state : makeState(uuidV7());
  }
  hostTarget = record;
  if (args.task_id && !key) { remember(record); saveDraft(); return; }
  if (!key && !Object.keys(args).length && record.id === "unscoped") return;
  if (record.completed || record.submitted || record.retry) return;
  if (!record.askKey) {
    record.askKey = uuidV7();
    record.id = "intent:" + record.askKey;
  }
  for (const name of ["question", "location", "task_type", "bounty_usd", "deadline_minutes", "require_photo", "classifier_report_id"]) {
    if (args[name] !== undefined && !record.edited[name]) record.input[name] = args[name];
  }
  remember(record);
  saveDraft();
}
function taskContext() {
  const task = state.completed;
  if ((!state.askKey && !task) || state.last && "balance_usd" in state.last) return null;
  if (state.loading || state.unavailable || state.unvalidated)
    return { intent_id: state.askKey, task_id: null, status: state.loading ? "restoring" : "unavailable" };
  return task ? { intent_id: state.askKey, task_id: task.task_id, status: task.status, idempotency_key: state.askKey,
    requested_at: task.created_at, captured_at: task.answer?.captured_at,
    next_step: ["dispatched", "claimed", "submitted"].includes(task.status) ? "await_answer" : "get_task" }
    : { intent_id: state.askKey, idempotency_key: state.askKey, status: "confirmation_required", task_id: null };
}
function publishTask() {
  if (!contextCapability) return;
  const owner = state, revision = contextRevision;
  const context = taskContext();
  if (!context) return;
  const key = JSON.stringify(context);
  if (owner.contextSent === key) return;
  const params = contextCapability.structuredContent ? { structuredContent: context }
    : contextCapability.text ? { content: [{ type: "text", text: key }] } : null;
  if (!params) return;
  owner.contextSent = key;
  request("ui/update-model-context", params).catch(() => {
    if (owner === state && revision === contextRevision) owner.contextSent = null;
  });
}
function releaseDraft(owner = state) {
  owner.input = { ...(owner.submitted ?? owner.retry?.args ?? owner.input) };
  delete owner.input.idempotency_key;
  owner.submitted = null;
  owner.retry = null;
  owner.uncertain = false;
}
async function confirmAsk(args, owner = state) {
  owner.submitted = structuredClone(args);
  const retryingUnknown = owner.uncertain;
  owner.uncertain = true;
  saveDraft();
  setAskBusy(true, owner);
  try {
    const out = await call("confirm_ask", args);
    if (!out?.task_id && out?.status !== "not_sent")
      throw new Error("The request was not confirmed. Retry with the same request; no new intent will be created.");
    if (retryingUnknown && out?.status === "not_sent") throw new Error(UNRESOLVED_CONFIRMATION);
    owner.uncertain = false;
    return out;
  } catch (err) {
    const code = errorDetail(err).error;
    if (!retryingUnknown && ["invalid_input", "unsafe_task", "insufficient_balance", "bounty_exceeds_max",
      "daily_cap_exceeded", "task_type_not_allowed", "location_not_found", "no_workers_nearby"].includes(code))
      releaseDraft(owner);
    else owner.uncertain = true;
    throw err;
  }
}

function post(msg) { window.parent.postMessage({ jsonrpc: "2.0", ...msg }, "*"); }
function request(method, params) {
  const id = ++seq, { promise, resolve, reject } = Promise.withResolvers();
  pending.set(id, { resolve, reject });
  post({ id, method, params });
  return promise;
}
function openLink(url) {
  if (window.openai?.openExternal) window.openai.openExternal({ href: url });
  else request("ui/open-link", { url });
}
function errorDetail(value) {
  let detail = value;
  for (let depth = 0; depth < 8; depth++) {
    if (detail && typeof detail === "object") {
      if (typeof detail.error === "string" || (typeof detail.message === "string" && detail.fix !== undefined))
        return detail;
      detail = detail.detail ?? detail.message;
      continue;
    }
    if (typeof detail !== "string" || !detail) break;
    try { detail = JSON.parse(detail); continue; } catch {}
    if (detail.includes("TextContent(")) {
      const json = detail.slice(detail.indexOf("{"), detail.lastIndexOf("}") + 1);
      try { detail = JSON.parse(json); continue; } catch {}
      const quote = detail.match(/\btext=(['"])/)?.[1];
      try {
        detail = JSON.parse(json.replace(/\\([\\'"])/g, (match, char) => char === "\\" || char === quote ? char : match));
        continue;
      } catch {}
      break;
    }
    if (/^\s*[\[{]/.test(detail)) break;
    return { message: detail };
  }
  return { message: "The tool failed. Retry the request." };
}
function errorText(value) {
  const detail = errorDetail(value);
  return [detail.message, detail.fix].filter((v) => typeof v === "string" && v.trim()).join(" ") || "The tool failed. Retry the request.";
}
async function callHost(name, args) {
  const r = window.openai?.callTool ? await window.openai.callTool(name, args) : await request("tools/call", { name, arguments: args });
  const text = r?.content?.find?.((c) => c.type === "text")?.text;
  if (r?.isError) throw errorDetail(r.structuredContent ?? text);
  return r?.structuredContent ?? JSON.parse(text ?? r?.result ?? "null");
}
async function call(name, args) {
  if (name !== "get_task" && name !== "await_answer") return callHost(name, args);
  if (readFlight) {
    if (readFlight.name === name && readFlight.taskId === args.task_id) return readFlight.promise;
    await readFlight.promise.catch(() => {});
    return call(name, args);
  }
  const promise = callHost(name, args);
  readFlight = { name, taskId: args.task_id, promise };
  try { return await promise; }
  finally { if (readFlight?.promise === promise) readFlight = null; }
}
function canRefresh() {
  return !tornDown && root.isConnected && !document.hidden && bridgeReady && !state.actionsPending &&
    !state.refreshFailed && !state.askPending && !state.acceptancePending && !state.retry && state.last?.task_id &&
    ["dispatched", "claimed", "submitted"].includes(state.last.status);
}
function scheduleRefresh() {
  window.clearTimeout(refreshTimer);
  refreshTimer = null;
  if (!canRefresh() || readFlight) return;
  const owner = state, version = state.version, taskId = state.last.task_id;
  refreshTimer = window.setTimeout(async () => {
    refreshTimer = null;
    if (!canRefresh() || !current(owner, version)) return;
    let failed = false;
    try {
      const out = await call("get_task", { task_id: taskId });
      if (out?.task_id !== taskId || typeof out.status !== "string")
        throw new Error("Task refresh was incomplete.");
      if (!current(owner, version)) return;
      const next = { ...owner.last, ...out };
      if (JSON.stringify(next) !== JSON.stringify(owner.last)) render(next, owner);
    } catch (err) {
      failed = true;
      if (current(owner, version)) {
        owner.refreshFailed = true;
        owner.error = errorText(err) + " Automatic refresh paused. Use Refresh status to try again.";
        paint();
      }
    } finally {
      if (!failed || state !== owner) scheduleRefresh();
    }
  }, 5000);
}
function stopRefresh() {
  tornDown = true;
  state.version++;
  scheduleRefresh();
}
function theme(t) { if (t === "dark" || t === "light") document.documentElement.dataset.theme = t; }

const BADGE = {
  dispatched: ["", "pending", "Finding a worker"], claimed: ["accent", "locate", "Worker on the way"],
  submitted: ["accent", "camera", "Checking the photo"], verified: ["success", "check", "Verified"],
  paid: ["success", "check", "Verified"], needs_review: ["warning", "alert", "Needs review"],
  disputed: ["warning", "alert", "Disputed"], expired: ["danger", "clock", "Expired"], refunded: ["", "cash", "Refunded"],
};
function badge(status) {
  const [tone, ic, text] = BADGE[status] ?? ["", "info", label(status)];
  return '<span class="ui-badge' + (tone ? " ui-badge--" + tone : "") + '">' + icon(ic) + text + "</span>";
}
const STEPS = ["dispatched", "claimed", "submitted", "verified"];
function steps(status) {
  const at = STEPS.indexOf(status === "paid" ? "verified" : status);
  if (at < 0) return "";
  const names = ["Workers texted", "Worker on the way", "Photo in, checking", "Verified"];
  return '<ol class="ui-steps">' + names.map((n, i) =>
    "<li" + (i < at || (i === at && at === 3) ? " data-done" : i === at ? ' aria-current="step"' : "") + ">" + n + "</li>").join("") + "</ol>";
}
function check(ok, text, detail) {
  return '<li class="ui-check ui-check--' + (ok ? "pass" : "fail") + '"><span class="ui-check__mark">' + icon(ok ? "check" : "x") +
    "</span><span>" + text + '</span><span class="ui-check__detail">' + esc(detail) + "</span></li>";
}
function answerBlock(a, status) {
  const v = a.verification, photo = /^https:\/\//.test(a.photo_url ?? "");
  const bool = typeof a.answer_bool === "boolean" ? (a.answer_bool ? "Yes" : "No") : "";
  const verdict = bool ? '<span class="ui-badge">' + bool + "</span> " : "";
  const text = bool && String(a.answer_text ?? "").trim().replace(/[.!]+$/, "").toLowerCase() === bool.toLowerCase() ? "" : a.answer_text;
  const capturedAt = a.captured_at ? new Date(a.captured_at).toLocaleString() : "time unavailable";
  return (photo ? '<figure class="ui-viewfinder ui-viewfinder--compact"><img src="' + esc(a.photo_url) + '" alt="Photo the worker captured at ' + esc(capturedAt) + '" loading="lazy"></figure>' : "") +
    '<p class="ui-card__answer">' + verdict + esc(text) + "</p>" +
    '<ul class="ui-checks">' +
    check(v.gps_ok, "On site", Math.round(a.worker_distance_m) + " m away") +
    check(v.fresh_ok, "Fresh when submitted", "Captured " + capturedAt) +
    check(v.vision_ok, "Photo is safe to share", v.vision_ok ? "" : v.vision_reason) +
    "</ul>" +
    (status === "needs_review" ? '<div class="ui-notice ui-notice--warning">' + icon("alert") + "<span>A check failed. A person reviews it before the worker is paid; your escrow stays held.</span></div>" : "") +
    '<dl class="ui-kv"><dt>' + icon("cash") + "Cost</dt><dd>" + usd(a.cost_usd) + "</dd></dl>";
}

function retryContext(t) {
  const c = t.retry_context, l = c?.location;
  return c && typeof c.question === "string" && c.question.trim() && Object.hasOwn(TYPES, c.task_type) &&
    typeof l?.label === "string" && l.label.trim() && Number.isFinite(l.lat) && Number.isFinite(l.lng) &&
    Number.isFinite(c.bounty_usd) && c.bounty_usd > 0
    ? { question: c.question, location: l, task_type: c.task_type, bounty_usd: c.bounty_usd,
        ...(c.deadline_minutes !== undefined && { deadline_minutes: c.deadline_minutes }),
        ...(c.require_photo !== undefined && { require_photo: c.require_photo }) } : null;
}
function draftFields(context, place, price, locked = "") {
  return '<input class="ui-input" data-field="question" aria-label="Your question" placeholder="Your question" value="' + esc(context.question) + '"' + locked + '>' +
    '<input class="ui-input" data-field="location" aria-label="Public place" value="' + esc(place) + '"' + locked + '>' +
    '<input class="ui-input" data-field="bounty_usd" aria-label="Bounty in USD" type="number" min="1" step="0.01" value="' + esc(price) + '"' + locked + '>';
}

function quote(q) {
  const context = state.retry?.args ?? state.input;
  const type = TYPES[context.task_type] ?? "";
  const nobody = q.allowed && q.workers_nearby === 0;
  const head = '<header class="ui-card__header"><h3 class="ui-card__title">' + esc(q.resolved_location.label) + "</h3>" +
    (state.uncertain ? '<span class="ui-badge ui-badge--warning">Confirmation unresolved</span>'
      : q.quote_pending ? '<span class="ui-badge">New check · Not sent</span>'
      : !q.allowed ? '<span class="ui-badge ui-badge--danger">' + icon("x") + "Can't ask</span>"
      : nobody ? '<span class="ui-badge ui-badge--warning">' + icon("pending") + "No one nearby</span>"
      : '<span class="ui-badge ui-badge--success">' + icon("check") + "Can ask</span>") + "</header>";
  const meta = '<ul class="ui-meta">' +
    (!q.quote_pending ? "<li>" + icon("eye") + "<strong>" + q.workers_nearby + "</strong> worker" + (q.workers_nearby === 1 ? "" : "s") + " nearby</li>" : "") +
    (q.est_minutes_to_answer ? "<li>" + icon("clock") + "about <strong>" + Math.round(q.est_minutes_to_answer) + " min</strong></li>" : "") +
    (q.allowed ? "<li>" + icon("cash") + (state.retry ? "Suggested bounty " : "") + "<strong>" + usd(q.suggested_bounty_usd) + "</strong> + $0.50 fee</li>" : "") + "</ul>";
  const why = state.uncertain ? "" : q.quote_pending ? '<div class="ui-notice">Checking availability. No request sent; $0 charged.</div>'
    : q.allowed ? (nobody ? '<div class="ui-notice">' + icon("info") + "<span>Nobody is nearby right now. Try a busier place or ask later.</span></div>" : "")
    : '<div class="ui-notice ui-notice--danger">' + icon("alert") + "<span>" + esc(q.reason_if_not) + "</span></div>";
  const canAsk = Boolean(state.uncertain && state.submitted) || q.allowed && q.workers_nearby > 0;
  const price = state.retry ? state.retry.args.bounty_usd : state.input.bounty_usd ?? q.suggested_bounty_usd;
  const place = typeof context.location === "string" ? context.location : context.location?.label ?? q.resolved_location.label;
  const locked = state.retry || state.submitted ? " readonly" : "";
  const note = state.uncertain ? '<div class="ui-notice">' + esc(UNRESOLVED_CONFIRMATION) + "</div>"
    : state.retry ? '<div class="ui-notice">' + icon("info") + "<span>New request with the original bounty: " + usd(price) +
    " + $0.50 fee. The quote is free. Only Ask sends the request and charges your balance.</span></div>"
    : '<div class="ui-notice">' + icon("info") + "<span>Not sent. Review your question, public place and bounty, then press Ask to confirm. Only confirmation sends the request and holds the bounty plus $0.50 fee.</span></div>";
  const act = canAsk || state.retry || state.isNew || state.submitted
    ? '<footer class="ui-card__actions" data-retry>' + draftFields(context, place, price, locked) +
      (state.isNew && !state.submitted && !state.retry ? '<button class="ui-button" data-act="repeat">Repeat previous question</button>' : "") +
      (canAsk ? '<button class="ui-button ui-button--primary" data-act="ask">' + (state.uncertain ? "Retry this confirmation" : "Ask for " + usd(price) + (state.retry ? " + $0.50 fee" : "")) + "</button>" : "") +
      (state.retry || state.isNew ? '<button class="ui-button" data-act="requote">Check availability</button>' : "") + "</footer>" : "";
  return '<article class="ui-card">' + head + (type ? '<p class="ui-text-sm ui-text-secondary" style="margin:0">' + type + "</p>" : "") + meta + why + note + act + "</article>";
}

function task(t) {
  const a = t.answer ?? null, status = t.status;
  const title = t.question ?? state.input.question ?? (a ? "Eyes answer" : "Eyes task");
  const place = t.place_label ?? (typeof state.input.location === "string" ? state.input.location : "");
  const open = ["dispatched", "claimed", "submitted"].includes(status);
  const deadline = t.deadline_at ? new Date(t.deadline_at) : null;
  const held = t.escrowed_usd ?? (t.bounty_usd != null ? t.bounty_usd + t.fee_usd : null);
  const meta = '<ul class="ui-meta">' +
    (open && held != null ? "<li>" + icon("cash") + "<strong>" + usd(held) + "</strong> held</li>" : "") +
    (open && t.workers_notified != null ? "<li>" + icon("message") + "<strong>" + t.workers_notified + "</strong> texted</li>" : "") +
    (open && deadline ? "<li>" + icon("clock") + "until <strong>" + time(deadline) + "</strong></li>" : "") + "</ul>";
  const end = status === "expired" ? '<div class="ui-notice">' + icon("clock") + "<span>Nobody answered in time. Your escrow was refunded.</span></div>"
    : status === "refunded" ? '<div class="ui-notice">' + icon("cash") + "<span>Cancelled. Your escrow was refunded.</span></div>"
    : status === "disputed" ? '<div class="ui-notice ui-notice--warning">' + icon("alert") + "<span>Dispute submitted. A person reviews this answer. No new request has been sent.</span></div>" : "";
  const context = status === "disputed" ? retryContext(t) : null;
  const unavailable = status === "disputed" && !context
    ? '<div class="ui-notice">' + icon("info") + "<span>Ask again is unavailable because the original request details are missing. Refresh to check again.</span></div>" : "";
  return '<article class="ui-card"><header class="ui-card__header"><h3 class="ui-card__title">' + esc(title) + "</h3>" + badge(status) + "</header>" +
    (place ? '<p class="ui-place">' + icon("pin") + '<span class="ui-place__name">' + esc(place) + "</span></p>" : "") +
    (a ? answerBlock(a, status) : (open ? steps(status) : "") + meta) + end + unavailable + taskActions(a, status, open, t.accepted_at, context) + "</article>";
}
function taskActions(a, status, open, acceptedAt, context) {
  const disputable = a && ["verified", "paid", "needs_review"].includes(status);
  const acceptable = a && ["verified", "paid"].includes(status);
  return '<footer class="ui-card__actions">' +
    (open ? '<button class="ui-button ui-button--primary" data-act="wait">Wait for answer</button>' : "") +
    (context ? '<button class="ui-button ui-button--primary" data-act="again">Ask again</button>' : "") +
    (!acceptable ? '<button class="ui-button" data-act="refresh">Refresh status</button>' : "") +
    (status === "dispatched" ? '<button class="ui-button" data-act="cancel">Cancel</button>' : "") +
    (disputable ? '<input class="ui-input" data-field="reason" aria-label="What is wrong" placeholder="What is wrong with the answer?">' : "") +
    (acceptable ? (acceptedAt
      ? '<button class="ui-button" data-accepted disabled>' + icon("check") + 'Accepted</button>'
      : '<button class="ui-button ui-button--primary" data-act="accept">Looks good</button>') : "") +
    (disputable ? '<button class="ui-button" data-act="dispute">Dispute</button>' : "") +
    (acceptable ? '<button class="ui-button" data-act="refresh">Refresh status</button>' : "") + "</footer>";
}

function balance(b) {
  return '<article class="ui-card"><header class="ui-card__header"><span class="ui-text-sm ui-text-secondary">Eyes balance</span></header>' +
    '<div class="row"><span class="big ui-num">' + usd(b.balance_usd) + "</span>" +
    (b.escrowed_usd > 0 ? '<span class="ui-text-sm ui-text-secondary">' + usd(b.escrowed_usd) + " held in open tasks</span>" : "") + "</div>" +
    (b.balance_usd < 1.5 ? '<div class="ui-notice ui-notice--warning">' + icon("alert") + "<span>Too low for a task. The smallest costs $1.50 with the fee.</span></div>" : "") +
    '<footer class="ui-card__actions"><button class="ui-button" data-act="balance">Refresh</button>' +
    (b.top_up_url ? '<button class="ui-button' + (b.balance_usd < 1.5 ? " ui-button--primary" : "") + '" data-act="topup">Top up</button>' : "") + "</footer></article>";
}

function notSent(n) {
  const context = state.retry?.args ?? state.input;
  const title = context.question ?? "Your question";
  const place = typeof context.location === "string" ? context.location : context.location?.label ?? "";
  return '<article class="ui-card"><header class="ui-card__header"><h3 class="ui-card__title">' + esc(title) + "</h3>" +
    '<span class="ui-badge ui-badge--warning">' + icon("pending") + "Not sent</span></header>" +
    (place ? '<p class="ui-place">' + icon("pin") + '<span class="ui-place__name">' + esc(place) + "</span></p>" : "") +
    '<div class="ui-notice">' + icon("info") + "<span>Not sent: no one nearby. Nothing was charged. Try a busier place or ask later.</span></div>" +
    '<dl class="ui-kv"><dt>' + icon("cash") + "Charged</dt><dd>" + usd(n.charged_usd) + "</dd></dl>" +
    '<footer class="ui-card__actions" data-retry>' + draftFields(context, place, context.bounty_usd) +
    '<button class="ui-button" data-act="requote">Check availability</button></footer></article>';
}

function render(out, owner = state, display = true) {
  if (!out || typeof out !== "object" || !("workers_nearby" in out || "balance_usd" in out || out.status === "not_sent" || "task_id" in out)) return;
  if (out.status === "not_sent" && owner.completed) return;
  if (out.status === "not_sent" && owner.uncertain) {
    owner.error = UNRESOLVED_CONFIRMATION;
    if (owner === state && display) paint();
    saveDraft();
    return;
  }
  const authorizedTask = Boolean(out.task_id);
  if (owner === state) captureDraft();
  if (out.status === "not_sent") releaseDraft(owner);
  if (owner.completed && "workers_nearby" in out) out = owner.completed;
  if (owner.retry && owner.retry.fromTask === out.task_id) return;
  if (out.status === "accepted") {
    if (owner.completed?.task_id !== out.task_id || !out.accepted_at) return;
    out = { ...owner.completed, accepted_at: out.accepted_at };
  }
  if (out.task_id) {
    if (owner.completed && owner.completed.task_id !== out.task_id) return;
    if (authorizedTask) {
      owner.unvalidated = false;
      owner.loading = false;
      owner.unavailable = false;
    }
    out = { ...owner.completed, ...out };
    owner.retry = null;
    owner.completed = out;
    owner.refusal = null;
    if (owner.id === "unscoped") owner.id = "task:" + out.task_id;
  }
  owner.last = out;
  remember(owner);
  if (owner === state && display) {
    if (authorizedTask && !owner.askPending) owner.version++;
    paint();
  } else saveDraft();
}
function paint() {
  const out = state.last ?? state.completed;
  if (!out) return;
  if (state.loading || state.unavailable || state.unvalidated) {
    root.innerHTML = '<article class="ui-card"><div class="ui-notice" role="status">' +
      (state.loading ? "Restoring this check under the current account…" : "This check could not be loaded. No cached evidence is shown.") +
      '</div><button class="ui-button" data-restore' + (state.loading ? " disabled" : "") + '>Retry loading check</button></article>';
    root.querySelector("[data-restore]").onclick = () => selectRecord(state);
    publishTask();
    saveDraft();
    size();
    return;
  }
  const active = document.activeElement;
  const focused = root.contains(active) && active.dataset.field ? {
    field: active.dataset.field, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection
  } : null;
  root.innerHTML = "workers_nearby" in out ? quote(out) : "balance_usd" in out ? balance(out)
    : out.status === "not_sent" ? notSent(out) : "task_id" in out ? task(out) : "";
  const card = root.firstElementChild;
  if (!card) return;
  if (!("balance_usd" in out)) {
    const taskId = state.completed?.task_id;
    const stamp = taskId ? "Check " + taskId.slice(0, 8) + (out.created_at ? " · Requested " + new Date(out.created_at).toLocaleString() : "")
      : "Intent …" + String(state.askKey ?? "").slice(-8) + (state.uncertain ? " · Confirmation unresolved" : " · Not sent");
    card.insertAdjacentHTML("afterbegin", '<div class="ui-text-sm ui-text-secondary" data-identity>' + esc(stamp) + "</div>");
    card.insertAdjacentHTML("beforeend", '<div class="scene-actions">' +
      '<button class="ui-button" data-act="new">New check here</button>' +
      '<button class="ui-button" data-act="resume">Resume pending</button>' +
      '<button class="ui-button" data-act="previous">View previous</button></div>' +
      (state.separate ? '<div class="ui-notice">The earlier confirmation may already be active and charge separately. Retry that intent to resolve it, or deliberately start a separate check.</div><button class="ui-button" data-act="separate">Start a separate check</button>' : "") +
      '<details data-history' + (state.showRecent ? " open" : "") + '><summary>Recent checks · up to 20, not full history</summary>' +
      [...records.values()].reverse().map(r => '<button class="ui-button ui-button--block" data-record="' + esc(r.id) + '">' +
        (r.unvalidated ? "Saved check · authorization required" :
          esc(r.completed?.question ?? r.input.question ?? "Unsent draft") + " · " + esc(r.completed?.status ?? (r.uncertain ? "confirmation unresolved" : "not sent")) +
          " · " + esc(r.completed?.task_id?.slice(0, 8) ?? (r.askKey ? "…" + r.askKey.slice(-8) : "")) +
          (r.completed?.created_at ? " · " + esc(new Date(r.completed.created_at).toLocaleString()) : "")) + "</button>").join("") +
      '<button class="ui-button" data-act="history">Load recent checks</button></details>');
  }
  if (state.error) card.insertAdjacentHTML("beforeend", '<div class="ui-notice ui-notice--danger" data-error role="alert">' + esc(state.error) + "</div>");
  for (const b of root.querySelectorAll("[data-act]")) b.onclick = () => act(b);
  for (const b of root.querySelectorAll("[data-record]")) b.onclick = () => selectRecord(records.get(b.dataset.record));
  for (const el of root.querySelectorAll("[data-field]")) el.addEventListener("input", () => {
    captureDraft();
    saveDraft();
    if (state.refusal) renderReport();
  });
  if (state.refusal && "workers_nearby" in out) {
    card.insertAdjacentHTML("beforeend", '<div data-report></div>');
    renderReport();
  }
  publishTask();
  saveDraft();
  if (state.askPending) setAskBusy(true);
  if (state.acceptancePending) setAcceptanceBusy(true);
  const restore = focused && root.querySelector('[data-field="' + focused.field + '"]');
  if (restore && !restore.disabled) {
    restore.focus({ preventScroll: true });
    if (focused.start != null) restore.setSelectionRange(focused.start, focused.end, focused.direction);
  }
  size();
  scheduleRefresh();
}
const field = (name) => name === "question" && state.retry ? state.retry.args.question : root.querySelector('[data-field="' + name + '"]')?.value.trim() ?? "";
function draftQuote() {
  const location = state.input.location;
  return { quote_pending: true, workers_nearby: 0, allowed: false, suggested_bounty_usd: state.input.bounty_usd ?? 3,
    resolved_location: { label: typeof location === "string" ? location : location?.label ?? "Public place" } };
}
async function newCheck(separate = false, again = false) {
  if ((state.uncertain || state.askPending) && !separate) {
    state.separate = true;
    paint();
    return;
  }
  hostInputSeen = true;
  hostTarget = null;
  captureDraft();
  const source = state.retry?.args ?? retryContext(state.completed ?? {}) ?? state.input;
  const task = state.completed ?? {};
  const previousQuestion = source.question ?? task.question ?? "";
  const next = makeState(uuidV7());
  next.isNew = true;
  next.previousQuestion = previousQuestion;
  next.input = {
    location: source.location ?? task.place_label,
    task_type: source.task_type ?? task.task_type ?? "other_public",
    bounty_usd: source.bounty_usd ?? task.bounty_usd ?? 3,
    question: again ? previousQuestion : "",
    ...(source.deadline_minutes !== undefined && { deadline_minutes: source.deadline_minutes }),
    ...(source.require_photo !== undefined && { require_photo: source.require_photo })
  };
  if (again) next.retry = { args: structuredClone(next.input), fromTask: task.task_id };
  if (!activate(next)) return;
  next.last = draftQuote();
  paint();
  root.querySelector('[data-field="question"]')?.focus();
  await quoteFor(next);
}
async function quoteFor(owner) {
  const version = ++owner.version;
  try {
    const out = await call("quote_task", { location: owner.input.location, task_type: owner.input.task_type });
    if (!out || typeof out.allowed !== "boolean" || !Number.isFinite(out.workers_nearby) ||
        !Number.isFinite(out.suggested_bounty_usd) || !out.resolved_location)
      throw new Error("The quote was incomplete. Check availability again; nothing was charged.");
    if (current(owner, version)) render(out, owner);
  } catch (err) {
    if (current(owner, version)) {
      owner.error = errorText(err);
      paint();
    }
  } finally {
    saveDraft();
  }
}
async function selectRecord(owner) {
  if (!owner || !activate(owner)) return;
  if (!owner.completed?.task_id) { paint(); return; }
  owner.loading = true;
  owner.unavailable = false;
  paint();
  const version = ++owner.version;
  try {
    const out = await call("get_task", { task_id: owner.completed.task_id });
    if (out?.task_id !== owner.completed.task_id) throw new Error("Task refresh was incomplete.");
    if (current(owner, version)) {
      owner.loading = false;
      owner.error = null;
      render(out, owner);
    }
  } catch (err) {
    if (current(owner, version)) {
      owner.loading = false;
      owner.unavailable = true;
      owner.error = errorText(err);
      paint();
    }
  }
}
const ACTS = {
  ask: (q) => {
    captureDraft();
    if (!state.submitted) {
      state.askKey ??= uuidV7();
      state.id = "intent:" + state.askKey;
      state.submitted = { ...(state.retry?.args ?? state.input), question: field("question"),
        location: state.retry?.args.location ?? state.input.location ?? q.resolved_location.label,
        task_type: state.retry?.args.task_type ?? state.input.task_type ?? "other_public",
        bounty_usd: state.retry?.args.bounty_usd ?? state.input.bounty_usd ?? q.suggested_bounty_usd,
        idempotency_key: state.askKey };
      saveDraft();
    }
    return ["confirm_ask", { ...state.submitted }];
  },
  refresh: (t) => ["get_task", { task_id: t.task_id }, true],
  wait: (t) => ["await_answer", { task_id: t.task_id }, true],
  cancel: (t) => ["cancel_task", { task_id: t.task_id }, true],
  accept: (t) => ["accept_answer", { task_id: t.task_id }],
  dispute: (t) => ["dispute_answer", { task_id: t.task_id, reason: field("reason") }, true],
  balance: () => ["get_balance", {}],
};
function renderReport() {
  const box = root.querySelector("[data-report]");
  const refusal = state.refusal;
  if (!box || !refusal) return;
  const t = refusal.ticket, edited = field("question") !== refusal.args.question;
  const status = !t ? "" : t.status === "open" ? "Awaiting manual review."
    : t.status === "approved" ? (edited ? "Approved. Restore the original question to retry." : "Approved. You can retry the original request; normal charges apply.")
    : t.status === "rejected" ? "Report rejected. The request was not sent."
    : t.status === "consumed" ? "This request was already sent." : "Approval expired. The request was not sent.";
  box.innerHTML = (t ? "<p>Ticket " + esc(t.ticket_id) + ": " + status + (t.reason ? " " + esc(t.reason) : "") + "</p>" : "") +
    (!t ? '<button class="ui-button" data-report-act="submit">Report incorrect block</button>'
      : t.status === "open" ? '<button class="ui-button" data-report-act="check">Check review status</button>'
      : t.status === "approved" ? '<button class="ui-button" data-report-act="retry"' + (edited ? " disabled" : "") + '>Retry original request</button>'
      : t.status === "consumed" && t.task_id ? '<button class="ui-button" data-report-act="view">View existing task</button>' : "") +
    (refusal.busy ? "<p>Working…</p>" : "") +
    (refusal.failure ? '<p role="alert">' + esc(refusal.failure) + "</p>" : "");
  for (const b of box.querySelectorAll("[data-report-act]")) {
    b.disabled ||= refusal.busy;
    b.onclick = () => reportAction(b.dataset.reportAct);
  }
  const ask = root.querySelector('[data-act="ask"]');
  if (ask) ask.disabled = refusal.busy || state.askPending;
  size();
}
async function reportAction(action) {
  const owner = state, report = owner.refusal, version = owner.version;
  if (!report || report.busy || owner.askPending) return;
  if (action === "submit" && report.ticket) return;
  if (action === "retry" && (report.ticket?.status !== "approved" || field("question") !== report.args.question)) return;
  report.busy = true;
  report.failure = null;
  renderReport();
  try {
    if (action === "view") {
      const out = await call("get_task", { task_id: report.ticket.task_id });
      if (current(owner, version)) render(out, owner);
    } else if (action === "retry") {
      setAskBusy(true, owner);
      const out = await confirmAsk({ ...report.args, classifier_report_id: report.ticket.ticket_id }, owner);
      render(out, owner, current(owner, version));
    } else {
      const a = report.args;
      const ticket = action === "submit"
        ? await call("report_classifier", { ...a, classifier_error: report.error, ask_idempotency_key: a.idempotency_key, idempotency_key: report.key })
        : await call("get_classifier_report", { ticket_id: report.ticket.ticket_id });
      if (!ticket?.ticket_id || !["open", "approved", "rejected", "expired", "consumed"].includes(ticket.status))
        throw new Error("The report response was incomplete. Check again.");
      report.ticket = ticket;
    }
  } catch (err) {
    report.failure = errorText(err);
  } finally {
    if (action === "retry") setAskBusy(false, owner);
    report.busy = false;
    if (current(owner, version) && owner.refusal === report) renderReport();
    saveDraft();
  }
}
function setAcceptanceBusy(busy, owner = state) {
  owner.acceptancePending = busy;
  if (owner !== state) return;
  for (const button of root.querySelectorAll("[data-act]"))
    if (!["new", "resume", "previous", "history", "separate"].includes(button.dataset.act)) button.disabled = busy;
  root.querySelector('[data-act="accept"]')?.setAttribute("aria-busy", String(busy));
}
function setAskBusy(busy, owner = state) {
  owner.askPending = busy;
  if (owner !== state) return;
  for (const el of root.querySelectorAll("[data-act], [data-field]"))
    if (!["new", "resume", "previous", "history", "separate"].includes(el.dataset.act)) el.disabled = busy;
  for (const el of root.querySelectorAll("[data-field]")) el.readOnly = Boolean(owner.retry || owner.submitted);
  root.querySelector('[data-act="ask"]')?.setAttribute("aria-busy", String(busy));
}
async function act(b) {
  if (b.disabled) return;
  const action = b.dataset.act;
  if (action === "new" || action === "separate" || action === "again") return newCheck(action === "separate", action === "again");
  if (action === "previous" || action === "resume") {
    state.showRecent = true;
    const pending = [...records.values()].filter(r => r.uncertain || r.askPending || ["dispatched", "claimed", "submitted"].includes(r.completed?.status));
    if (action === "resume" && pending.length === 1) return selectRecord(pending[0]);
    if (action === "resume" && !pending.length) state.error = "No pending checks in this recent list. Load recent checks or start New check here.";
    paint();
    if (action === "resume") {
      const target = pending.length
        ? [...root.querySelectorAll("[data-record]")].find(el => el.dataset.record === pending[0].id)
        : root.querySelector('[data-act="new"]');
      target?.focus();
    }
    return;
  }
  if (state.acceptancePending || state.askPending) return;
  if (action === "repeat") {
    state.input.question = state.previousQuestion;
    state.edited.question = true;
    paint();
    return;
  }
  if (action === "requote") { captureDraft(); return quoteFor(state); }
  if (action === "topup") return openLink(state.last.top_up_url);
  if (!ACTS[action] && action !== "history") return;
  const owner = state;
  owner.refreshFailed = false;
  const [name, args, merge] = action === "history" ? ["list_tasks", { limit: RECENT_LIMIT }] : ACTS[action](owner.last);
  const original = owner.last;
  const submittedArgs = name === "confirm_ask" ? structuredClone(args) : args;
  const reading = name === "get_task" || name === "await_answer", version = ++owner.version;
  owner.actionsPending++;
  owner.error = null;
  scheduleRefresh();
  const card = root.firstElementChild;
  card.querySelector("[data-error]")?.remove();
  card.querySelector("[data-report]")?.remove();
  b.disabled = true;
  if (name === "accept_answer") setAcceptanceBusy(true, owner);
  if (name === "confirm_ask") setAskBusy(true, owner);
  try {
    const out = name === "confirm_ask" ? await confirmAsk(args, owner) : await call(name, args);
    if (reading && !current(owner, version)) return;
    if (name === "list_tasks") {
      if (!Array.isArray(out?.tasks)) throw new Error("Recent checks could not be loaded. Retry.");
      for (const task of out.tasks.slice(0, RECENT_LIMIT)) {
        if (!task.task_id) continue;
        const record = [...records.values()].find(r => r.completed?.task_id === task.task_id) ?? makeState(null, task.task_id);
        if (!record.completed) record.last = record.completed = task;
        record.unvalidated = false;
        remember(record);
      }
      owner.showRecent = true;
      if (current(owner, version)) paint();
    } else {
      if (name === "accept_answer" && (out?.status !== "accepted" || out.task_id !== args.task_id || !out.accepted_at))
        throw new Error("Acceptance was not confirmed. Refresh the task or try again.");
      if (name === "dispute_answer" && (out?.status !== "disputed" || out.task_id !== args.task_id))
        throw new Error("Dispute was not confirmed. Refresh the task before trying again.");
      render(merge ? { ...original, ...out } : out, owner, current(owner, version));
    }
  } catch (err) {
    if (reading && !current(owner, version)) return;
    if (name === "confirm_ask" && owner.completed) return;
    const detail = errorDetail(err);
    owner.error = errorText(detail);
    if (name === "confirm_ask" && !owner.uncertain && detail.error === "unsafe_task" && detail.layer !== "rules") {
      if (!owner.refusal || JSON.stringify(owner.refusal.args) !== JSON.stringify(submittedArgs))
        owner.refusal = { args: submittedArgs, error: detail, key: uuidV7(), ticket: null, busy: false, failure: null };
    } else owner.refusal = null;
    if (current(owner, version)) paint();
  } finally {
    if (name === "confirm_ask") setAskBusy(false, owner);
    if (name === "accept_answer") setAcceptanceBusy(false, owner);
    if (owner === state && b.isConnected) b.disabled = false;
    saveDraft();
    owner.actionsPending--;
    scheduleRefresh();
  }
}
function size() {
  post({ method: "ui/notifications/size-changed", params: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } });
}

let hostInputSeen = false;
function receive(out, fresh = false) {
  if (!out || typeof out !== "object") return;
  let owner = hostTarget;
  const requestedTask = hostTargetTask, requestedKey = hostTargetKey, initial = hostTargetInitial, selected = owner === state;
  hostTarget = null;
  hostTargetTask = null;
  hostTargetKey = null;
  hostTargetInitial = false;
  if (out.idempotency_key) {
    prefill(out, fresh);
    owner = hostTarget;
    hostTarget = null;
  }
  if (out.task_id) {
    const known = [...records.values()].find(r => r.completed?.task_id === out.task_id);
    if (known) owner = known;
    else if (!owner || !(owner.submitted || requestedTask === out.task_id || requestedKey === owner.askKey || initial || fresh))
      owner = makeState(null, out.task_id);
    if ((fresh || initial || requestedTask === out.task_id && selected || state.id === "unscoped") && !activate(owner)) return;
  }
  if (!owner) {
    if ("balance_usd" in out) owner = state;
    else if (!state.last) owner = state;
    else owner = makeState(uuidV7());
  }
  if (owner.completed && ["verified", "paid", "needs_review", "disputed", "expired", "refunded"].includes(owner.completed.status) &&
      out.task_id === owner.completed.task_id && ["dispatched", "claimed", "submitted"].includes(out.status)) return;
  render(out, owner);
}
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.method === "ui/resource-teardown") {
    stopRefresh();
    if (m.id != null) post({ id: m.id, result: {} });
    return;
  }
  if (m.id != null && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    return m.error ? p.reject(new Error(m.error.message ?? "The host refused the request.")) : p.resolve(m.result);
  }
  if (m.method === "ui/notifications/tool-input") {
    const args = m.params?.arguments ?? {};
    if (args.classifier_error || args.ticket_id) return;
    prefill(args, !hostInputSeen);
    hostInputSeen = true;
    if (hostTarget === state) {
      if (!state.last) state.last = draftQuote();
      paint();
    }
  }
  if (m.method === "ui/notifications/tool-result") receive(m.params?.structuredContent, !hostInputSeen);
  if (m.method === "ui/notifications/host-context-changed") theme(m.params?.theme);
});
new ResizeObserver(size).observe(document.body);
document.addEventListener("visibilitychange", () => { state.version++; scheduleRefresh(); });
window.addEventListener("pagehide", stopRefresh);
window.addEventListener("pageshow", () => { tornDown = false; scheduleRefresh(); });

if (window.openai) {
  theme(window.openai.theme);
  prefill(window.openai.toolInput ?? {}, true);
  hostInputSeen = true;
  if (window.openai.toolOutput) receive(window.openai.toolOutput, true);
  else if (state.completed) { void selectRecord(state); }
  else if (state.last) paint();
  window.addEventListener("openai:set_globals", (e) => {
    const g = e.detail?.globals ?? {};
    if (g.theme) theme(g.theme);
    const report = g.toolInput?.classifier_error || g.toolInput?.ticket_id || g.toolOutput?.ticket_id;
    if (g.toolInput && !report) prefill(g.toolInput);
    if (g.toolOutput && !report) receive(g.toolOutput);
  });
}
const restoreOwner = !window.openai && state.completed ? state : null;
if (restoreOwner) { state.loading = true; paint(); }
else if (!window.openai && state.last) paint();
request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "eyes", version: "1" }, appCapabilities: {} }).then((r) => {
  theme(r?.hostContext?.theme);
  post({ method: "ui/notifications/initialized" });
  contextCapability = r?.hostCapabilities?.updateModelContext ?? null;
  publishTask();
  bridgeReady = true;
  if (restoreOwner === state && state.loading) void selectRecord(state);
  scheduleRefresh();
});
`;

export const WIDGET_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${file("tokens.css")}${file("components.css")}${CSS}</style></head>
<body class="ui">${file("icons.svg")}<main class="w" id="root" aria-live="polite"></main>
<script type="module">${WIDGET_SCRIPT}</script></body></html>`;
