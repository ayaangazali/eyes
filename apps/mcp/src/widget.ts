// One MCP Apps widget for ChatGPT and Claude: an HTML resource (text/html;profile=mcp-app) with the
// Eyes design system inlined and a small vanilla script. It speaks the MCP Apps postMessage bridge
// (ui/initialize, ui/notifications/tool-result), which both hosts implement, and falls back to
// window.openai.toolOutput. It renders by result shape: quote, task (ask_eyes, get_task,
// await_answer) or balance. No React, no bundler: the markup reuses the classes in packages/ui.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const WIDGET_URI = "ui://eyes/card.html";
export const WIDGET_MIME = "text/html;profile=mcp-app";

/** Photos load from InsForge storage; signed URLs redirect to the CDN. */
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
.w .row{display:flex;flex-wrap:wrap;gap:.25rem 1rem;align-items:baseline}
`;

const SCRIPT = String.raw`
const root = document.getElementById("root");
let input = {}, last = null, seq = 0;
const pending = new Map();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (n) => '<svg class="ui-icon" aria-hidden="true"><use href="#i-' + n + '"></use></svg>';
const usd = (n) => "$" + Number(n ?? 0).toFixed(2);
const time = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
const label = (s) => esc(String(s).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));
const TYPES = { is_open: "Open now?", line_length: "Line length", in_stock: "In stock?", photo_of_place: "Photo of place", price_check: "Price check", crowd_level: "Crowd level", other_public: "Look at a public place" };

function post(msg) { window.parent.postMessage({ jsonrpc: "2.0", ...msg }, "*"); }
function request(method, params) {
  const id = ++seq, { promise, resolve } = Promise.withResolvers();
  pending.set(id, resolve);
  post({ id, method, params });
  return promise;
}
function openLink(url) {
  if (window.openai?.openExternal) window.openai.openExternal({ href: url });
  else request("ui/open-link", { url });
}
function say(text) {
  if (window.openai?.sendFollowUpMessage) window.openai.sendFollowUpMessage({ prompt: text });
  else request("ui/message", { role: "user", content: [{ type: "text", text }] });
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
  const verdict = a.answer_bool === null ? "" : '<span class="ui-badge">' + (a.answer_bool ? "Yes" : "No") + "</span> ";
  return (photo ? '<figure class="ui-viewfinder ui-viewfinder--compact"><img src="' + esc(a.photo_url) + '" alt="Photo the worker took on site" loading="lazy"></figure>' : "") +
    '<p class="ui-card__answer">' + verdict + esc(a.answer_text) + "</p>" +
    '<ul class="ui-checks">' +
    check(v.gps_ok, "On site", Math.round(a.worker_distance_m) + " m away") +
    check(v.fresh_ok, "Fresh photo", "taken " + time(a.captured_at)) +
    check(v.vision_ok, "Answers the question", v.vision_ok ? Math.round(a.confidence * 100) + "% sure" : v.vision_reason) +
    "</ul>" +
    (status === "needs_review" ? '<div class="ui-notice ui-notice--warning">' + icon("alert") + "<span>A check failed. A person reviews it before the worker is paid; your escrow stays held.</span></div>" : "") +
    '<dl class="ui-kv"><dt>' + icon("cash") + "Cost</dt><dd>" + usd(a.cost_usd) + "</dd></dl>";
}

function quote(q) {
  const type = TYPES[input.task_type] ?? "";
  const head = '<header class="ui-card__header"><h3 class="ui-card__title">' + esc(q.resolved_location.label) + "</h3>" +
    (q.allowed ? '<span class="ui-badge ui-badge--success">' + icon("check") + "Can ask</span>" : '<span class="ui-badge ui-badge--danger">' + icon("x") + "Can't ask</span>") + "</header>";
  const meta = '<ul class="ui-meta">' +
    "<li>" + icon("eye") + "<strong>" + q.workers_nearby + "</strong> worker" + (q.workers_nearby === 1 ? "" : "s") + " nearby</li>" +
    (q.est_minutes_to_answer ? "<li>" + icon("clock") + "about <strong>" + Math.round(q.est_minutes_to_answer) + " min</strong></li>" : "") +
    (q.allowed ? "<li>" + icon("cash") + "<strong>" + usd(q.suggested_bounty_usd) + "</strong> + $0.50 fee</li>" : "") + "</ul>";
  const why = q.allowed ? (q.workers_nearby === 0 ? '<div class="ui-notice">' + icon("info") + "<span>Nobody is nearby right now. Try a busier place or ask later.</span></div>" : "")
    : '<div class="ui-notice ui-notice--danger">' + icon("alert") + "<span>" + esc(q.reason_if_not) + "</span></div>";
  const act = q.allowed && q.workers_nearby > 0
    ? '<footer class="ui-card__actions"><button class="ui-button ui-button--primary" data-act="ask">Ask for ' + usd(q.suggested_bounty_usd) + "</button></footer>" : "";
  return '<article class="ui-card">' + head + (type ? '<p class="ui-text-sm ui-text-secondary" style="margin:0">' + type + "</p>" : "") + meta + why + act + "</article>";
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
    : status === "disputed" ? '<div class="ui-notice ui-notice--warning">' + icon("alert") + "<span>You disputed this answer. A person reviews it.</span></div>" : "";
  return '<article class="ui-card"><header class="ui-card__header"><h3 class="ui-card__title">' + esc(title) + "</h3>" + badge(status) + "</header>" +
    (place ? '<p class="ui-place">' + icon("pin") + '<span class="ui-place__name">' + esc(place) + "</span></p>" : "") +
    (a ? answerBlock(a, status) : (open ? steps(status) : "") + meta + end) + "</article>";
}

function balance(b) {
  return '<article class="ui-card"><header class="ui-card__header"><span class="ui-text-sm ui-text-secondary">Eyes balance</span></header>' +
    '<div class="row"><span class="big ui-num">' + usd(b.balance_usd) + "</span>" +
    (b.escrowed_usd > 0 ? '<span class="ui-text-sm ui-text-secondary">' + usd(b.escrowed_usd) + " held in open tasks</span>" : "") + "</div>" +
    (b.balance_usd < 1.5 ? '<div class="ui-notice ui-notice--warning">' + icon("alert") + "<span>Too low for a task. The smallest costs $1.50 with the fee.</span></div>" : "") +
    (b.top_up_url ? '<footer class="ui-card__actions"><button class="ui-button' + (b.balance_usd < 1.5 ? " ui-button--primary" : "") + '" data-act="topup">Top up</button></footer>' : "") + "</article>";
}

function render(out) {
  if (!out || typeof out !== "object") return;
  last = out;
  root.innerHTML = "workers_nearby" in out ? quote(out) : "balance_usd" in out ? balance(out) : "task_id" in out ? task(out) : "";
  for (const b of root.querySelectorAll("[data-act]")) b.onclick = () => {
    if (b.dataset.act === "topup") openLink(last.top_up_url);
    if (b.dataset.act === "ask") say("Ask Eyes about " + last.resolved_location.label + " (" + (input.task_type ?? "other_public") + ") for " + usd(last.suggested_bounty_usd) + ".");
  };
  size();
}
function size() {
  post({ method: "ui/notifications/size-changed", params: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } });
}

window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.jsonrpc !== "2.0") return;
  if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === "ui/notifications/tool-input") { input = m.params?.arguments ?? {}; if (last) render(last); }
  if (m.method === "ui/notifications/tool-result") render(m.params?.structuredContent);
  if (m.method === "ui/notifications/host-context-changed") theme(m.params?.theme);
});
new ResizeObserver(size).observe(document.body);

if (window.openai) {
  theme(window.openai.theme);
  input = window.openai.toolInput ?? {};
  render(window.openai.toolOutput);
  window.addEventListener("openai:set_globals", (e) => {
    const g = e.detail?.globals ?? {};
    if (g.theme) theme(g.theme);
    if (g.toolInput) input = g.toolInput;
    if (g.toolOutput) render(g.toolOutput);
  });
}
request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "eyes", version: "1" }, appCapabilities: {} }).then((r) => {
  theme(r?.hostContext?.theme);
  post({ method: "ui/notifications/initialized" });
});
`;

export const WIDGET_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${file("tokens.css")}${file("components.css")}${CSS}</style></head>
<body class="ui">${file("icons.svg")}<main class="w" id="root" aria-live="polite"></main>
<script type="module">${SCRIPT}</script></body></html>`;
