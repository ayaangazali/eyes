// One MCP Apps widget for ChatGPT and Claude: an HTML resource (text/html;profile=mcp-app) with the
// Eyes design system inlined and a small vanilla script. It speaks the MCP Apps postMessage bridge
// (ui/initialize, ui/notifications/tool-result), which both hosts implement, and falls back to
// window.openai.toolOutput. It renders by result shape: quote/draft, task (confirm_ask, get_task,
// await_answer) or balance. Card buttons call tools through call(): window.openai.callTool in
// ChatGPT, the MCP Apps tools/call request elsewhere, and render the result into the same card.
// No React, no bundler: the markup reuses the classes in packages/ui.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// This resource revision changes the paid-call contract; cached pre-confirmation cards stay obsolete.
export const WIDGET_URI = "ui://eyes/confirmation-card.html";
export const WIDGET_MIME = "text/html;profile=mcp-app";

/** Photos load from InsForge storage; signed URLs redirect to the CDN. */
/** Tools the card's buttons call; tools/list marks them callable from the widget in both hosts. */
export const WIDGET_CALLABLE = [
  "quote_task",
  "confirm_ask",
  "get_task",
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
`;

export const WIDGET_SCRIPT = String.raw`
const root = document.getElementById("root");
let input = {}, last = null, seq = 0, askKey = null, refusal = null, acceptancePending = false, retry = null;
let submitted = null, completed = null, askPending = false, uncertain = false, edited = {}, contextCapability = null, contextSent = null;
let saved;
try { saved = window.openai?.widgetState?.privateContent ?? window.openai?.widgetState; } catch {}
if (!saved && window.name.startsWith("eyes.intent.")) {
  try {
    const local = JSON.parse(window.sessionStorage.getItem("eyes.card." + window.name));
    if (local?.askKey && window.name === "eyes.intent." + local.askKey) saved = local;
  } catch {}
}
if (saved) ({ input = {}, last = null, askKey = null, retry = null, submitted = null, completed = null, uncertain = false, edited = {} } = saved);
const pending = new Map();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (n) => '<svg class="ui-icon" aria-hidden="true"><use href="#i-' + n + '"></use></svg>';
const usd = (n) => "$" + Number(n ?? 0).toFixed(2);
const time = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
const label = (s) => esc(String(s).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));
const TYPES = { is_open: "Open now?", line_length: "Line length", in_stock: "In stock?", photo_of_place: "Photo of place", price_check: "Price check", crowd_level: "Crowd level", other_public: "Look at a public place" };
function saveDraft() {
  const state = { input, last, askKey, retry, submitted, completed, uncertain, edited };
  try {
    window.openai?.setWidgetState?.({
      ...(completed ? { modelContent: taskContext() }
        : askKey ? { modelContent: { status: "confirmation_required", idempotency_key: askKey } } : {}),
      privateContent: state,
    });
  } catch {}
  if (askKey) {
    window.name = "eyes.intent." + askKey;
    try { window.sessionStorage.setItem("eyes.card." + window.name, JSON.stringify(state)); } catch {}
  }
}
function captureDraft() {
  if (submitted || retry) return;
  for (const name of ["question", "location", "bounty_usd"]) {
    const el = root.querySelector('[data-field="' + name + '"]');
    if (!el || el.value === el.defaultValue) continue;
    input[name] = name === "bounty_usd" ? Number(el.value) : el.value;
    edited[name] = true;
  }
  const ask = root.querySelector('[data-act="ask"]');
  if (ask && input.bounty_usd !== undefined) ask.textContent = "Ask for " + usd(input.bounty_usd);
}
function prefill(args) {
  captureDraft();
  if (submitted || completed || retry) return;
  for (const name of ["question", "location", "task_type", "bounty_usd", "deadline_minutes", "require_photo", "classifier_report_id"]) {
    if (args[name] !== undefined && !edited[name]) input[name] = args[name];
  }
  askKey ??= args.idempotency_key ?? null;
  saveDraft();
}
function taskContext() {
  return { task_id: completed.task_id, status: completed.status, idempotency_key: askKey,
    next_step: ["dispatched", "claimed", "submitted"].includes(completed.status) ? "await_answer" : "get_task" };
}
function publishTask() {
  if (!completed || !contextCapability) return;
  const context = taskContext(), key = JSON.stringify(context);
  if (contextSent === key) return;
  const params = contextCapability.structuredContent ? { structuredContent: context }
    : contextCapability.text ? { content: [{ type: "text", text: key }] } : null;
  if (!params) return;
  contextSent = key;
  request("ui/update-model-context", params).catch(() => { contextSent = null; });
}
function releaseDraft() {
  input = { ...(submitted ?? retry?.args ?? input) };
  delete input.idempotency_key;
  submitted = null;
  retry = null;
  uncertain = false;
}
async function confirmAsk(args) {
  submitted = structuredClone(args);
  const retryingUnknown = uncertain;
  uncertain = true;
  saveDraft();
  setAskBusy(true);
  try {
    const out = await call("confirm_ask", args);
    if (!out?.task_id && out?.status !== "not_sent")
      throw new Error("The request was not confirmed. Retry with the same request; no new intent will be created.");
    uncertain = false;
    return out;
  } catch (err) {
    const code = errorDetail(err).error;
    if (!retryingUnknown && ["invalid_input", "unsafe_task", "insufficient_balance", "bounty_exceeds_max",
      "daily_cap_exceeded", "task_type_not_allowed", "location_not_found", "no_workers_nearby"].includes(code))
      releaseDraft();
    else uncertain = true;
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
async function call(name, args) {
  const r = window.openai?.callTool ? await window.openai.callTool(name, args) : await request("tools/call", { name, arguments: args });
  const text = r?.content?.find?.((c) => c.type === "text")?.text;
  if (r?.isError) throw errorDetail(r.structuredContent ?? text);
  return r?.structuredContent ?? JSON.parse(text ?? r?.result ?? "null");
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
  return (photo ? '<figure class="ui-viewfinder ui-viewfinder--compact"><img src="' + esc(a.photo_url) + '" alt="Photo the worker took on site" loading="lazy"></figure>' : "") +
    '<p class="ui-card__answer">' + verdict + esc(text) + "</p>" +
    '<ul class="ui-checks">' +
    check(v.gps_ok, "On site", Math.round(a.worker_distance_m) + " m away") +
    check(v.fresh_ok, "Fresh photo", "taken " + time(a.captured_at)) +
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
  const context = retry?.args ?? input;
  const type = TYPES[context.task_type] ?? "";
  const nobody = q.allowed && q.workers_nearby === 0;
  const head = '<header class="ui-card__header"><h3 class="ui-card__title">' + esc(q.resolved_location.label) + "</h3>" +
    (!q.allowed ? '<span class="ui-badge ui-badge--danger">' + icon("x") + "Can't ask</span>"
      : nobody ? '<span class="ui-badge ui-badge--warning">' + icon("pending") + "No one nearby</span>"
      : '<span class="ui-badge ui-badge--success">' + icon("check") + "Can ask</span>") + "</header>";
  const meta = '<ul class="ui-meta">' +
    "<li>" + icon("eye") + "<strong>" + q.workers_nearby + "</strong> worker" + (q.workers_nearby === 1 ? "" : "s") + " nearby</li>" +
    (q.est_minutes_to_answer ? "<li>" + icon("clock") + "about <strong>" + Math.round(q.est_minutes_to_answer) + " min</strong></li>" : "") +
    (q.allowed ? "<li>" + icon("cash") + (retry ? "Suggested bounty " : "") + "<strong>" + usd(q.suggested_bounty_usd) + "</strong> + $0.50 fee</li>" : "") + "</ul>";
  const why = q.allowed ? (nobody ? '<div class="ui-notice">' + icon("info") + "<span>Nobody is nearby right now. Try a busier place or ask later.</span></div>" : "")
    : '<div class="ui-notice ui-notice--danger">' + icon("alert") + "<span>" + esc(q.reason_if_not) + "</span></div>";
  const canAsk = q.allowed && q.workers_nearby > 0;
  const price = retry ? retry.args.bounty_usd : input.bounty_usd ?? q.suggested_bounty_usd;
  const place = typeof context.location === "string" ? context.location : context.location?.label ?? q.resolved_location.label;
  const locked = retry || submitted ? " readonly" : "";
  const note = retry ? '<div class="ui-notice">' + icon("info") + "<span>New request with the original bounty: " + usd(price) +
    " + $0.50 fee. The quote is free. Only Ask sends the request and charges your balance.</span></div>"
    : '<div class="ui-notice">' + icon("info") + "<span>Not sent. Review your question, public place and bounty, then press Ask to confirm. Only confirmation sends the request and holds the bounty plus $0.50 fee.</span></div>";
  const act = canAsk || retry
    ? '<footer class="ui-card__actions" data-retry>' + draftFields(context, place, price, locked) +
      (canAsk ? '<button class="ui-button ui-button--primary" data-act="ask">Ask for ' + usd(price) + (retry ? " + $0.50 fee" : "") + "</button>" : "") +
      (retry ? '<button class="ui-button" data-act="requote">Check availability</button>' : "") + "</footer>" : "";
  return '<article class="ui-card">' + head + (type ? '<p class="ui-text-sm ui-text-secondary" style="margin:0">' + type + "</p>" : "") + meta + why + note + act + "</article>";
}

function task(t) {
  const a = t.answer ?? null, status = t.status;
  const title = t.question ?? input.question ?? (a ? "Eyes answer" : "Eyes task");
  const place = t.place_label ?? (typeof input.location === "string" ? input.location : "");
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
    (!acceptable ? '<button class="ui-button" data-act="refresh">Refresh</button>' : "") +
    (status === "dispatched" ? '<button class="ui-button" data-act="cancel">Cancel</button>' : "") +
    (disputable ? '<input class="ui-input" data-field="reason" aria-label="What is wrong" placeholder="What is wrong with the answer?">' : "") +
    (acceptable ? (acceptedAt
      ? '<button class="ui-button" data-accepted disabled>' + icon("check") + 'Accepted</button>'
      : '<button class="ui-button ui-button--primary" data-act="accept">Looks good</button>') : "") +
    (disputable ? '<button class="ui-button" data-act="dispute">Dispute</button>' : "") +
    (acceptable ? '<button class="ui-button" data-act="refresh">Refresh</button>' : "") + "</footer>";
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
  const context = retry?.args ?? input;
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

function render(out) {
  if (!out || typeof out !== "object" || !("workers_nearby" in out || "balance_usd" in out || out.status === "not_sent" || "task_id" in out)) return;
  captureDraft();
  if (out.status === "not_sent") releaseDraft();
  const active = document.activeElement;
  const focused = root.contains(active) && active.dataset.field ? {
    field: active.dataset.field, start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection
  } : null;
  if (out.status === "confirmation_required") prefill(out);
  if (completed && "workers_nearby" in out) out = completed;
  if (retry && retry.fromTask === out.task_id) return;
  if (out.status === "accepted") {
    if (last?.task_id !== out.task_id || !out.accepted_at) return;
    out = { ...last, accepted_at: out.accepted_at };
  }
  if ("task_id" in out) {
    retry = null;
    completed = out;
    refusal = null;
  }
  last = out;
  root.innerHTML = "workers_nearby" in out ? quote(out) : "balance_usd" in out ? balance(out)
    : out.status === "not_sent" ? notSent(out) : "task_id" in out ? task(out) : "";
  for (const b of root.querySelectorAll("[data-act]")) b.onclick = () => act(b);
  for (const el of root.querySelectorAll("[data-field]")) el.addEventListener("input", () => { captureDraft(); saveDraft(); });
  if (refusal && "workers_nearby" in out) {
    root.firstElementChild.insertAdjacentHTML("beforeend", '<div data-report></div>');
    renderReport();
  }
  publishTask();
  saveDraft();
  if (askPending) setAskBusy(true);
  size();
  if (acceptancePending) setAcceptanceBusy(true);
  const restore = focused && root.querySelector('[data-field="' + focused.field + '"]');
  if (restore && !restore.disabled) {
    restore.focus({ preventScroll: true });
    if (focused.start != null) restore.setSelectionRange(focused.start, focused.end, focused.direction);
  }
}
const field = (name) => name === "question" && retry ? retry.args.question : root.querySelector('[data-field="' + name + '"]')?.value.trim() ?? "";
const ACTS = {
  ask: (q) => {
    captureDraft();
    if (!submitted) {
      askKey ??= crypto.randomUUID();
      submitted = { ...(retry?.args ?? input), question: field("question"),
        location: retry?.args.location ?? input.location ?? q.resolved_location.label,
        task_type: retry?.args.task_type ?? input.task_type ?? "other_public",
        bounty_usd: retry?.args.bounty_usd ?? input.bounty_usd ?? q.suggested_bounty_usd,
        idempotency_key: askKey };
      saveDraft();
    }
    return ["confirm_ask", { ...submitted }];
  },
  refresh: (t) => ["get_task", { task_id: t.task_id }, true],
  wait: (t) => ["await_answer", { task_id: t.task_id }, true],
  cancel: (t) => ["cancel_task", { task_id: t.task_id }, true],
  accept: (t) => ["accept_answer", { task_id: t.task_id }],
  again: (t) => ["quote_task", { location: retryContext(t).location, task_type: retryContext(t).task_type }],
  requote: () => {
    captureDraft();
    const context = retry?.args ?? input;
    return ["quote_task", { location: context.location, task_type: context.task_type }];
  },
  dispute: (t) => ["dispute_answer", { task_id: t.task_id, reason: field("reason") }, true],
  balance: () => ["get_balance", {}],
};
function renderReport() {
  const box = root.querySelector("[data-report]");
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
  if (ask) ask.disabled = refusal.busy || askPending;
  size();
}
async function reportAction(action) {
  const current = refusal;
  if (!current || current.busy) return;
  if (action === "submit" && current.ticket) return;
  if (action === "retry" && (current.ticket?.status !== "approved" || field("question") !== current.args.question)) return;
  if (askPending) return;
  current.busy = true;
  current.failure = null;
  renderReport();
  try {
    if (action === "view") {
      render(await call("get_task", { task_id: current.ticket.task_id }));
    } else if (action === "retry") {
      setAskBusy(true);
      render(await confirmAsk({ ...current.args, classifier_report_id: current.ticket.ticket_id }));
    } else {
      const a = current.args;
      const ticket = action === "submit"
        ? await call("report_classifier", { ...a, classifier_error: current.error, ask_idempotency_key: a.idempotency_key, idempotency_key: current.key })
        : await call("get_classifier_report", { ticket_id: current.ticket.ticket_id });
      if (!ticket?.ticket_id || !["open", "approved", "rejected", "expired", "consumed"].includes(ticket.status))
        throw new Error("The report response was incomplete. Check again.");
      current.ticket = ticket;
    }
  } catch (err) {
    current.failure = errorText(err);
  } finally {
    if (action === "retry") setAskBusy(false);
    current.busy = false;
    if (refusal === current) renderReport();
    saveDraft();
  }
}
function setAcceptanceBusy(busy) {
  acceptancePending = busy;
  for (const button of root.querySelectorAll("[data-act]")) button.disabled = busy;
  root.querySelector('[data-act="accept"]')?.setAttribute("aria-busy", String(busy));
}
function setAskBusy(busy) {
  askPending = busy;
  for (const el of root.querySelectorAll("[data-act], [data-field]")) el.disabled = busy;
  for (const el of root.querySelectorAll("[data-field]")) el.readOnly = Boolean(retry || submitted);
  root.querySelector('[data-act="ask"]')?.setAttribute("aria-busy", String(busy));
}
async function act(b) {
  if (acceptancePending || askPending || b.disabled) return;
  if (b.dataset.act === "topup") return openLink(last.top_up_url);
  const [name, args, merge] = ACTS[b.dataset.act](last);
  const original = last;
  const submittedArgs = name === "confirm_ask" ? structuredClone(args) : args;
  const card = root.firstElementChild;
  card.querySelector("[data-error]")?.remove();
  card.querySelector("[data-report]")?.remove();
  b.disabled = true;
  if (name === "accept_answer") setAcceptanceBusy(true);
  if (name === "confirm_ask") setAskBusy(true);
  try {
    const out = name === "confirm_ask" ? await confirmAsk(args) : await call(name, args);
    if (name === "accept_answer") {
      if (out?.status !== "accepted" || out.task_id !== args.task_id || !out.accepted_at)
        throw new Error("Acceptance was not confirmed. Refresh the task or try again.");
      setAcceptanceBusy(false);
      if (last?.task_id === args.task_id) render(out);
    } else if (name === "quote_task") {
      if (!out || typeof out.allowed !== "boolean" || !Number.isFinite(out.workers_nearby) ||
          !Number.isFinite(out.suggested_bounty_usd) || !out.resolved_location)
        throw new Error("The quote was incomplete. Check availability again; nothing was charged.");
      if (b.dataset.act === "again") {
        retry = { args: structuredClone(retryContext(original)), fromTask: original.task_id };
        askKey = crypto.randomUUID();
        submitted = null;
        completed = null;
        edited = {};
        uncertain = false;
      }
      render(out);
    } else {
      if (name === "dispute_answer" && (out?.status !== "disputed" || out.task_id !== args.task_id))
        throw new Error("Dispute was not confirmed. Refresh the task before trying again.");
      render(merge ? { ...original, ...out } : out);
    }
  } catch (err) {
    if (name === "accept_answer") setAcceptanceBusy(false);
    if (name === "confirm_ask" && completed) return;
    const card = root.firstElementChild;
    b.disabled = false;
    const detail = errorDetail(err);
    card.insertAdjacentHTML("beforeend", '<div class="ui-notice ui-notice--danger" data-error role="alert">' + icon("alert") + "<span>" + esc(errorText(detail)) + "</span></div>");
    if (name === "confirm_ask" && !uncertain && detail.error === "unsafe_task" && detail.layer !== "rules") {
      if (!refusal || JSON.stringify(refusal.args) !== JSON.stringify(submittedArgs))
        refusal = { args: submittedArgs, error: detail, key: crypto.randomUUID(), ticket: null, busy: false, failure: null };
      card.insertAdjacentHTML("beforeend", '<div data-report></div>');
      root.querySelector('[data-field="question"]')?.addEventListener("input", renderReport);
      renderReport();
    } else {
      refusal = null;
      card.querySelector("[data-report]")?.remove();
    }
    size();
  } finally {
    if (name === "confirm_ask") setAskBusy(false);
    saveDraft();
  }
}
function size() {
  post({ method: "ui/notifications/size-changed", params: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } });
}

window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.id != null && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    return m.error ? p.reject(new Error(m.error.message ?? "The host refused the request.")) : p.resolve(m.result);
  }
  if (m.method === "ui/notifications/tool-input") {
    const args = m.params?.arguments ?? {};
    if (args.classifier_error || args.ticket_id) return;
    prefill(args);
    if (last) render(last);
  }
  if (m.method === "ui/notifications/tool-result") render(m.params?.structuredContent);
  if (m.method === "ui/notifications/host-context-changed") theme(m.params?.theme);
});
new ResizeObserver(size).observe(document.body);

if (window.openai) {
  theme(window.openai.theme);
  prefill(window.openai.toolInput ?? {});
  render(completed ?? window.openai.toolOutput ?? last);
  window.addEventListener("openai:set_globals", (e) => {
    const g = e.detail?.globals ?? {};
    if (g.theme) theme(g.theme);
    const report = g.toolInput?.classifier_error || g.toolInput?.ticket_id || g.toolOutput?.ticket_id;
    if (g.toolInput && !report) prefill(g.toolInput);
    if (g.toolOutput && !report) render(g.toolOutput);
  });
}
if (!window.openai && last) render(last);
request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "eyes", version: "1" }, appCapabilities: {} }).then((r) => {
  theme(r?.hostContext?.theme);
  post({ method: "ui/notifications/initialized" });
  contextCapability = r?.hostCapabilities?.updateModelContext ?? null;
  publishTask();
});
`;

export const WIDGET_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${file("tokens.css")}${file("components.css")}${CSS}</style></head>
<body class="ui">${file("icons.svg")}<main class="w" id="root" aria-live="polite"></main>
<script type="module">${WIDGET_SCRIPT}</script></body></html>`;
