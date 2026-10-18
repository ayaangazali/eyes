// The /ops page: DOM rendering, polling, the review panel and ticket actions. server.ts inlines this file
// (types stripped, imports dropped) after format.ts into ops.html and calls boot(window).
import {
  after,
  ago,
  checkReason,
  cut,
  eventQuery,
  filterTickets,
  LEDGER_LABEL,
  LIVE,
  nearLabel,
  nextTab,
  POLL_MS,
  STATUS_TONE,
  stamp,
  sum,
  TABS,
  type TicketFields,
  tabFor,
  ticketOpen,
  time,
  uptime,
  usd,
} from "./format.ts";
import { createTable, hashFor, parseHash, stateFrom, type TableOptions, type TableState } from "./table.ts";

type Checked = {
  gps_ok?: boolean | null;
  fresh_ok?: boolean | null;
  vision_ok?: boolean | null;
  confidence?: number | null;
  vision_reason?: string | null;
  place_label?: string | null;
  question?: string | null;
  bounty_cents?: number;
  distance_m?: number | null;
  radius_m?: number;
  photo_url?: string | null;
  answer_text?: string | null;
};
export type Task = Checked & {
  id: string;
  status: string;
  workers_notified?: number | null;
  created_at: string;
  claimed_at?: string | null;
  submitted_at?: string | null;
  money_at?: Record<string, string> | null;
};
type TaskDetail = Task & {
  fee_cents: number;
  answer_bool?: boolean | null;
  dispute_reason?: string | null;
  message?: string;
  error?: string;
};
export type Ticket = Checked &
  TicketFields & {
    task_status?: string;
    created_at?: string;
    resolved_at?: string | null;
    note?: string | null;
    reversal_owed_cents?: number | null;
    worker_banned?: boolean;
  };
export type Worker = {
  id: string;
  lat: number | null;
  lng: number | null;
  available: boolean;
  opted_in: boolean;
};
type LedgerRow = { type: string; created_at: string; task_id?: string | null; amount_cents: number };
type OpsError = { level: string; at: string; summary: string };
export type OpsFeed = {
  tasks: Task[];
  ledger: LedgerRow[];
  workers: Worker[];
  totals: { escrowed_cents?: number };
  ops: {
    operator?: string;
    since?: string;
    health: {
      uptime_s: number;
      providers: Record<string, string>;
      db: string;
      db_error?: string | null;
      classifier: string;
      commit?: string | null;
      node: string;
    };
    statuses: Record<string, number>;
    partial: { tasks?: boolean; workers?: boolean };
    money_24h: Record<string, number>;
    queue: Task[];
    workers: { opted_in: number; online: number; total: number };
    errors: OpsError[];
  };
};
type OpsEvent = { id?: number; at: string; kind: string; level: string; summary: string; task_id?: string };
type Series = {
  source: string;
  dropped?: number;
  requests: number[];
  errors: number[];
  p95_ms: number[];
  hours: unknown[];
  tasks: Record<string, number[]>;
  payouts: { ok: number[]; failed: number[] };
};
type Reply = { message?: string; error?: string; [key: string]: unknown };

type Layer = { addTo(target: unknown): Layer; clearLayers(): void };
type LeafletMap = {
  setView(center: [number, number], zoom: number): LeafletMap;
  fitBounds(bounds: unknown, options: object): void;
  invalidateSize(): void;
};
export type Leaflet = {
  map(id: string, options: object): LeafletMap;
  tileLayer(url: string, options: object): Layer;
  layerGroup(): Layer;
  circleMarker(at: [number, number], options: object): Layer;
  latLngBounds(points: [number, number][]): { pad(ratio: number): unknown };
};
export type OpsWindow = Window & { L?: Leaflet; qTimer?: number };
type Kid = Node | string | null | false;

export function boot(win: OpsWindow) {
  const { document, location, history } = win;
  // The dashboard lives at the root of its own host; loopback (tests, local runs) keeps it under /ops.
  const base = location.pathname.startsWith("/ops") ? "/ops" : "";
  const fetch = (path: string, init?: RequestInit) => win.fetch(`${base}${path}`, init);
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href^="/ops/"]'))
    a.setAttribute("href", `${base}${a.getAttribute("href")?.slice(4)}`);
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const value = (id: string) => $<HTMLInputElement>(id).value;
  const json = <T>(res: Response) => res.json().catch(() => ({})) as Promise<T>;

  function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, ...kids: Kid[]) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    for (const kid of kids) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  const badge = (text: string, tone?: string) =>
    h("span", `ui-badge${tone ? ` ui-badge--${tone}` : ""}`, text);
  const kv = (dl: HTMLElement, pairs: [string, Kid][]) =>
    dl.replaceChildren(...pairs.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
  const empty = (text: string) => h("li", "muted", text);
  const count = (id: string, n: number, hot: boolean) => {
    $(id).textContent = n ? String(n) : "";
    $(id).classList.toggle("hot", Boolean(hot && n));
  };

  function checks(t: Checked) {
    if (t.gps_ok == null) return null;
    const mark = (ok: boolean | null | undefined, label: string) =>
      badge(`${ok ? "✓" : "✗"} ${label}`, ok ? "success" : "danger");
    return h(
      "span",
      "flow-checks",
      mark(t.gps_ok, "GPS"),
      " ",
      mark(t.fresh_ok, "fresh"),
      " ",
      mark(t.vision_ok, "safe photo"),
      t.confidence != null ? h("span", "tiny", ` ${Math.round(t.confidence * 100)}% sure`) : null,
    );
  }

  function flow(t: Task) {
    const steps: [string, string | null | undefined][] = [
      ["asked", t.created_at],
      ["claimed", t.claimed_at],
      ["answered", t.submitted_at],
    ];
    for (const [type, at] of Object.entries(t.money_at || {}))
      if (type !== "escrow")
        steps.push([
          type === "release"
            ? "released"
            : type === "payout"
              ? "paid out"
              : type === "refund"
                ? "refunded"
                : type,
          at,
        ]);
    steps.sort((a, b) => Date.parse(a[1] || "0") - Date.parse(b[1] || "0"));
    return h(
      "div",
      "flow",
      ...steps
        .filter((step): step is [string, string] => Boolean(step[1]))
        .map(([label, at], i) =>
          h("span", null, i === 0 ? `${label} ${stamp(at)}` : `${label} ${after(t.created_at, at)}`),
        ),
    );
  }

  function photoOf(t: Checked) {
    if (!t.photo_url) return h("div", "nophoto", "No photo");
    const photo = h("img");
    photo.src = t.photo_url;
    photo.alt = "Worker photo";
    photo.referrerPolicy = "no-referrer";
    return photo;
  }

  function noteAndStatus(placeholder: string) {
    const note = h("textarea", "ui-input");
    note.placeholder = placeholder;
    note.maxLength = 500;
    const out = h("span", "tiny");
    out.setAttribute("role", "status");
    return { note, out };
  }

  function taskRow(t: Task) {
    const li = h("li");
    li.append(
      h(
        "div",
        "task-head",
        h("p", "q", cut(t.question, 160)),
        badge(t.status.replace("_", " "), STATUS_TONE[t.status]),
      ),
      h(
        "div",
        "line",
        h("span", null, cut(nearLabel(t.place_label), 70)),
        h("span", null, "bounty ", h("strong", null, usd(t.bounty_cents))),
        h("span", null, "notified ", h("strong", null, String(t.workers_notified ?? 0))),
        checks(t),
      ),
      flow(t),
      h("span", "tiny", t.id),
    );
    if (t.status === "needs_review" || t.status === "disputed") {
      // The review panel replaces the old `pnpm resolve-task` commands.
      li.className = "open";
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.setAttribute("aria-label", `Review: ${cut(t.question, 80)}`);
      li.addEventListener("click", () => openReview(t.id));
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openReview(t.id);
        }
      });
    }
    return li;
  }

  // Release or refund a needs_review / disputed task. Same server path as `pnpm resolve-task` (resolveTask).
  async function openReview(id: string) {
    const review = $<HTMLDialogElement>("review-panel");
    const close = h("button", "ui-button ui-button--ghost ui-button--sm", "Close");
    close.type = "button";
    close.addEventListener("click", () => review.close());
    const res = await fetch(`/tasks/${id}`, { cache: "no-store" });
    const t = await json<TaskDetail>(res);
    if (!res.ok) {
      review.replaceChildren(
        h("p", null, `Could not load the task: ${t.message || t.error || res.status}`),
        close,
      );
      if (!review.open) review.showModal();
      return;
    }
    const open = t.status === "needs_review" || t.status === "disputed";
    const { note, out } = noteAndStatus("Note (optional), saved with the decision");
    const decide = (outcome: string) => async () => {
      const r = await fetch(`/tasks/${t.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outcome, note: note.value.trim() || undefined }),
      });
      const body = await json<Reply>(r);
      if (!r.ok) {
        out.textContent = `Failed: ${body.message || body.error || r.status}`;
        return false;
      }
      out.textContent = body.already_resolved
        ? `Already ${body.status}; no money moved.`
        : `Done: ${body.status}. It leaves the queue on the next refresh.`;
      for (const b of review.querySelectorAll<HTMLButtonElement>(".actions button")) b.disabled = true;
      return true;
    };
    const checklist: [string, boolean | null | undefined][] = [
      ["At the place (GPS)", t.gps_ok],
      ["Taken just now", t.fresh_ok],
      ["Photo is safe to share", t.vision_ok],
    ];
    // replaceChildren would print a null as the text "null".
    review.replaceChildren(
      ...[
        h(
          "div",
          "task-head",
          h("h2", "ui-card__title", cut(t.question, 200)),
          badge(t.status.replace("_", " "), STATUS_TONE[t.status]),
          close,
        ),
        photoOf(t),
        t.answer_text || t.answer_bool != null
          ? h("p", null, "Answer: ", h("strong", null, t.answer_text || (t.answer_bool ? "Yes" : "No")))
          : h("p", "muted", "No answer submitted."),
        h(
          "div",
          "line",
          h("span", null, cut(nearLabel(t.place_label), 90)),
          h(
            "span",
            null,
            "worker ",
            h("strong", null, t.distance_m == null ? "?" : `${t.distance_m} m`),
            ` away (radius ${t.radius_m} m)`,
          ),
          h(
            "span",
            null,
            "bounty ",
            h("strong", null, usd(t.bounty_cents)),
            ` + fee ${usd(t.fee_cents)} in escrow`,
          ),
        ),
        t.gps_ok == null
          ? null
          : h(
              "ul",
              "checklist",
              ...checklist.map(([label, ok]) =>
                h("li", null, h("span", ok ? "ok" : "bad", ok ? "✓ " : "✗ "), label),
              ),
            ),
        t.vision_reason ? h("p", "muted", `Moderation: ${checkReason(t.vision_reason)}`) : null,
        t.dispute_reason ? h("p", "msg", `Agent's dispute: ${t.dispute_reason}`) : null,
        open
          ? h(
              "div",
              "actions",
              note,
              confirmButton(
                "Release (pay the worker)",
                `Confirm: pay the worker ${usd(t.bounty_cents)}`,
                "primary",
                decide("release"),
              ),
              confirmButton(
                "Refund (return to the agent)",
                `Confirm: refund ${usd((t.bounty_cents ?? 0) + t.fee_cents)}`,
                "ghost",
                decide("refund"),
              ),
              out,
            )
          : h("p", "muted", `Settled: ${t.status.replace("_", " ")}.`),
        h("span", "tiny", t.id),
      ].filter((x) => x != null),
    );
    if (!review.open) review.showModal();
  }

  let map: LeafletMap | null = null;
  let layer: Layer | null = null;
  let fitted = false;
  function renderMap(all: Worker[]) {
    // STOP deletes a worker's location
    const workers = all.filter((w): w is Worker & { lat: number; lng: number } => w.lat != null);
    const L = win.L;
    if (!L) {
      $("map").classList.add("nomap");
      $("map").textContent = "Map needs Leaflet from unpkg.com.";
      return;
    }
    if (!map || !layer) {
      map = L.map("map", { zoomControl: false, attributionControl: true }).setView([37.7749, -122.4194], 12);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        // The page is Referrer-Policy same-origin; OSM blocks tile requests with no Referer.
        referrerPolicy: "strict-origin-when-cross-origin",
        maxZoom: 16,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      layer = L.layerGroup().addTo(map);
    }
    layer.clearLayers();
    for (const w of workers) {
      const on = w.available && w.opted_in;
      L.circleMarker([w.lat, w.lng], {
        radius: 7,
        weight: 2,
        color: "#0d0d0d",
        fillColor: on ? "#ffd60a" : "#8f8f8f",
        fillOpacity: on ? 0.95 : 0.5,
      }).addTo(layer);
    }
    if (!fitted && workers.length) {
      map.fitBounds(L.latLngBounds(workers.map((w) => [w.lat, w.lng])).pad(0.3), { maxZoom: 14 });
      fitted = true;
    }
  }

  let last: Pick<OpsFeed, "tasks" | "ledger" | "workers"> = { tasks: [], ledger: [], workers: [] };
  function render(feed: OpsFeed) {
    const o = feed.ops;
    const hl = o.health;
    $("uptime").textContent = uptime(hl.uptime_s);
    $("providers").replaceChildren(
      ...Object.entries(hl.providers).map(([name, mode]) =>
        h(
          "li",
          null,
          h("span", "ui-status__name", name),
          badge(mode, mode === "live" ? "success" : "warning"),
        ),
      ),
    );
    kv($("health"), [
      [
        "Database",
        hl.db_error
          ? badge("failing", "danger")
          : hl.db === "insforge"
            ? "hosted Postgres"
            : "local Postgres",
      ],
      ["Safety classifier", hl.classifier],
      ["Commit", hl.commit ? h("code", null, hl.commit.slice(0, 10)) : "unknown"],
      ["Node", hl.node],
    ]);
    const banner = $("banner");
    banner.hidden = !hl.db_error;
    banner.textContent = hl.db_error
      ? `Database read failed: ${hl.db_error}. Health and errors below are still live.`
      : "";

    const total = sum(Object.values(o.statuses));
    $("operator").textContent = o.operator ? `signed in: ${o.operator}` : "";
    $("tasks-total").textContent =
      `${total}${o.partial.tasks ? "+" : ""} created since ${time(o.since)} yesterday`;
    $("statuses").replaceChildren(
      ...Object.entries(o.statuses).map(([s, n]) => {
        const hot = (s === "needs_review" || s === "disputed") && n > 0;
        return h(
          "div",
          `stat${hot ? " hot" : ""}${LIVE.includes(s) && n > 0 ? " live" : ""}`,
          h("b", null, String(n)),
          h("span", null, s.replace("_", " ")),
        );
      }),
    );

    const m = o.money_24h;
    $("escrowed").textContent = usd(feed.totals.escrowed_cents);
    kv($("money-kv"), [
      ["Escrowed", usd(m.escrow)],
      ["Released to workers", usd(m.release)],
      ["Refunded to agents", usd(m.refund)],
      ["Fees", usd(m.fee)],
      ["Paid out (Stripe)", usd(m.payout)],
      ["Top-ups", usd(m.topup)],
    ]);

    $("queue-count").textContent = String(o.queue.length);
    $("queue-count").className = `ui-badge${o.queue.length ? " ui-badge--danger" : " ui-badge--success"}`;
    review.setRows(o.queue);
    count("n-review", o.queue.length, true);

    last = feed;
    renderTasks();

    const w = o.workers;
    $("worker-stats").replaceChildren(
      h(
        "div",
        "stat",
        h("b", null, `${w.opted_in}${o.partial.workers ? "+" : ""}`),
        h("span", null, "opted in"),
      ),
      h("div", "stat live", h("b", null, String(w.online)), h("span", null, "available now")),
      h("div", "stat", h("b", null, String(w.total)), h("span", null, "signed up")),
    );
    renderMap(feed.workers);
    renderWorkers();
    renderLedger();

    $("errors").replaceChildren(
      ...(o.errors.length
        ? o.errors.map((e) =>
            h(
              "li",
              null,
              h(
                "div",
                "line",
                badge(e.level, e.level === "error" ? "danger" : "warning"),
                h("span", "tiny", stamp(e.at)),
              ),
              h("pre", "err", e.summary),
            ),
          )
        : [empty("No errors or warnings since the server started.")]),
    );
    count(
      "n-logs",
      o.errors.length,
      o.errors.some((e) => e.level === "error"),
    );
  }

  function renderTasks() {
    const s = value("task-status");
    const shown = s ? last.tasks.filter((t) => t.status === s) : last.tasks;
    $("tasks-shown").textContent = `${shown.length} of ${last.tasks.length}, newest first`;
    $("task-list").replaceChildren(
      ...(shown.length
        ? shown.map(taskRow)
        : [empty(last.tasks.length ? "No tasks with this status." : "No tasks yet.")]),
    );
  }

  function renderLedger() {
    const places = new Map(last.tasks.map((t) => [t.id, nearLabel(t.place_label)]));
    const type = value("ledger-type");
    const rows = type ? last.ledger.filter((r) => r.type === type) : last.ledger;
    $("ledger").replaceChildren(
      ...(rows.length
        ? rows.flatMap((row) => [
            h("span", "tiny", stamp(row.created_at)),
            h(
              "span",
              null,
              LEDGER_LABEL[row.type] || row.type,
              row.task_id
                ? h("span", "tiny", ` ${cut(places.get(row.task_id) || row.task_id.slice(0, 8), 40)}`)
                : null,
            ),
            h("span", "amt", usd(row.amount_cents)),
          ])
        : [h("span", "muted", type ? "No rows of this type." : "No ledger rows yet.")]),
    );
  }

  // No coordinates here: the map already shows rounded positions.
  function renderWorkers() {
    const rank = (w: Worker) => (w.available && w.opted_in ? 2 : w.opted_in ? 1 : 0);
    const all = [...last.workers].sort((a, b) => rank(b) - rank(a));
    $("workers-list").replaceChildren(
      ...(all.length
        ? all.map((w) =>
            h(
              "li",
              null,
              h(
                "div",
                "line",
                badge(
                  ["opted out", "opted in", "available"][rank(w)] as string,
                  ["", "", "success"][rank(w)],
                ),
                h("span", "tiny", `worker ${w.id.slice(0, 8)}`),
                w.lat == null ? h("span", "muted", "no location") : null,
              ),
            ),
          )
        : [empty("No workers yet.")]),
    );
  }

  // Two clicks: the first arms the button for 5 s and says what will happen, the second does it.
  // A decided action stays disabled; a failed one can be tried again.
  function confirmButton(label: string, armed: string, tone: string, act: () => Promise<boolean>) {
    const b = h("button", `ui-button ui-button--sm ui-button--${tone}`, label);
    b.type = "button";
    let timer = 0;
    b.addEventListener("click", async () => {
      if (!b.dataset.armed) {
        b.dataset.armed = "1";
        b.textContent = armed;
        timer = win.setTimeout(() => {
          delete b.dataset.armed;
          b.textContent = label;
        }, 5000);
        return;
      }
      win.clearTimeout(timer);
      b.disabled = true;
      b.textContent = "Working";
      let done = false;
      try {
        done = await act();
      } finally {
        b.disabled = done;
        delete b.dataset.armed;
        b.textContent = label;
      }
    });
    return b;
  }

  // Dispute actions (confirm_fraud, reject_dispute) take only a note; the others also send the task id.
  async function act(t: Ticket, action: string, note: HTMLTextAreaElement, out: HTMLElement) {
    if (!note.value.trim()) {
      out.textContent =
        t.kind === "dispute"
          ? "Write a note first; it is kept with the decision."
          : "Write a note first; it is texted to the worker.";
      return false;
    }
    const res = await fetch(`/tickets/${t.id}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        t.kind === "dispute" ? { note: note.value } : { task_id: t.task_id, note: note.value },
      ),
    });
    const body = await json<Reply>(res);
    if (!res.ok) {
      out.textContent = `Failed: ${body.message || body.error || res.status}`;
      return false;
    }
    out.textContent = body.already_resolved
      ? `Already ${body.dispute_status || "resolved"}; no money moved.`
      : action === "confirm_fraud"
        ? `Done: agent refunded ${usd(body.agent_refund_cents as number)}, transfer ${body.reversal === "owed" ? `reversal owed ${usd(body.reversal_owed_cents as number)}` : body.reversal}, worker banned.`
        : `Done: ticket #${t.id} ${action.replace("_", " ")}.`;
    await loadTickets();
    return true;
  }

  function ticketRow(t: Ticket) {
    const dispute = t.kind === "dispute";
    const open = ticketOpen(t);
    const { note, out } = noteAndStatus(
      dispute ? "Note, kept with the decision" : "Note, texted to the worker",
    );
    const bounty = usd(t.bounty_cents);
    const state = dispute ? t.dispute_status || "open" : open ? "open" : "resolved";
    const body = h(
      "div",
      null,
      h(
        "div",
        "task-head",
        h("p", "q", `#${t.id} ${cut(t.question, 160)}`),
        h(
          "span",
          "line",
          dispute ? badge("dispute", "warning") : null,
          badge(state, open ? "danger" : state === "upheld" ? "warning" : "success"),
        ),
      ),
      h(
        "div",
        "line",
        h("span", null, cut(nearLabel(t.place_label), 70)),
        h("span", null, "bounty ", h("strong", null, bounty)),
        h(
          "span",
          null,
          "worker ",
          h("strong", null, t.distance_m == null ? "?" : `${t.distance_m} m`),
          ` from the place (radius ${t.radius_m} m)`,
        ),
        checks(t),
      ),
      t.vision_reason ? h("p", "muted", `Photo safety: ${checkReason(t.vision_reason)}`) : null,
      t.answer_text ? h("p", "muted", `Answer: ${cut(t.answer_text, 300)}`) : null,
      h("p", "msg", dispute ? `Agent says: ${t.message || "(no reason)"}` : t.message || "(no message)"),
      t.reversal_owed_cents
        ? h(
            "p",
            "muted",
            badge(`reversal owed ${usd(t.reversal_owed_cents)}`, "danger"),
            " the worker already moved the money; collect it by hand.",
          )
        : null,
      t.worker_banned ? h("p", "muted", "Worker banned.") : null,
      h("span", "tiny", `task ${t.task_id}, ${t.task_status}, opened ${stamp(t.created_at)}`),
    );
    const held = t.task_status === "needs_review" || t.task_status === "disputed";
    if (open && dispute) {
      body.append(
        note,
        h(
          "div",
          "actions",
          confirmButton(
            "Confirm fraud: ban + refund",
            "Confirm: refund the agent, reverse the payout, ban the worker",
            "danger",
            () => act(t, "confirm_fraud", note, out),
          ),
          confirmButton("Reject", "Confirm: reject, the worker keeps the pay", "ghost", () =>
            act(t, "reject_dispute", note, out),
          ),
          out,
        ),
      );
    } else if (open) {
      body.append(
        note,
        h(
          "div",
          "actions",
          held
            ? confirmButton("Release", `Confirm: pay worker ${bounty}`, "primary", () =>
                act(t, "release", note, out),
              )
            : null,
          held
            ? confirmButton("Refund", "Confirm: refund the agent", "ghost", () => act(t, "refund", note, out))
            : null,
          confirmButton("Resolve with note", "Confirm: close, no money moves", "ghost", () =>
            act(t, "close", note, out),
          ),
          out,
        ),
      );
    } else {
      body.append(h("p", "muted", `Resolved ${stamp(t.resolved_at)}: ${t.note || ""}`));
    }
    return h("li", "ticket", photoOf(t), body);
  }

  let ticketsText = "";
  let tickets: Ticket[] = [];
  let ticketPages = 1;
  const TICKETS_PER_PAGE = 50;
  async function loadTickets() {
    const res = await fetch("/tickets", { cache: "no-store" });
    if (!res.ok) return;
    const text = await res.text();
    if (text === ticketsText) return;
    ticketsText = text;
    tickets = JSON.parse(text).tickets;
    const open = tickets.filter(ticketOpen).length;
    $("tickets-count").textContent = `${open} open`;
    $("tickets-count").className = `ui-badge ${open ? "ui-badge--danger" : "ui-badge--success"}`;
    count("n-support", open, true);
    renderTickets();
  }

  function renderTickets() {
    const shown = filterTickets(tickets, value("t-q"), value("t-status"));
    $("tickets-list").replaceChildren(
      ...(shown.length
        ? shown.slice(0, ticketPages * TICKETS_PER_PAGE).map(ticketRow)
        : [
            empty(
              tickets.length
                ? "No tickets match."
                : "No tickets. A worker opens one by texting HELP after an answer is held for review.",
            ),
          ]),
    );
    $("t-more").hidden = shown.length <= ticketPages * TICKETS_PER_PAGE;
  }

  let oldest: number | null = null;
  function eventRow(e: OpsEvent) {
    const { task_id } = e;
    const task = task_id ? h("button", null, task_id.slice(0, 8)) : "";
    if (task_id && typeof task !== "string")
      task.addEventListener("click", () => {
        $<HTMLInputElement>("f-task").value = task_id;
        loadEvents(false);
      });
    const tone = e.level === "error" ? "danger" : e.level === "warn" ? "warning" : "";
    return h(
      "tr",
      null,
      h("td", null, stamp(e.at)),
      h("td", null, badge(e.kind, tone)),
      h("td", null, task),
      h("td", "sum", e.summary),
    );
  }
  async function loadEvents(older: boolean) {
    const query = eventQuery(
      { q: value("f-q"), kind: value("f-kind"), level: value("f-level"), task_id: value("f-task") },
      older ? oldest : null,
    );
    const res = await fetch(`/events?${query}`, { cache: "no-store" });
    if (!res.ok) return;
    const { source, events } = (await res.json()) as { source: string; events: OpsEvent[] };
    oldest = events.length ? (events.at(-1)?.id ?? null) : oldest;
    $("events-source").textContent =
      source === "memory"
        ? "database unreachable: showing this process's memory only"
        : "searchable, newest first";
    const rows = events.map(eventRow);
    if (older) $("events").append(...rows);
    else
      $("events").replaceChildren(
        ...(rows.length ? rows : [h("tr", null, h("td", "muted", "No events match."))]),
      );
    $("older").hidden = source === "memory" || events.length < 200;
  }

  // One SVG area chart: values scaled to the panel, no axes. The title carries the latest value and the max.
  function chart(title: string, values: number[], note: string, bad?: boolean) {
    const max = Math.max(1, ...values);
    const n = Math.max(1, values.length - 1);
    const pts = values.map((v, i) => `${(i / n) * 100},${30 - (v / max) * 28}`).join(" ");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 100 30");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${title}: ${note}`);
    const area = document.createElementNS(svg.namespaceURI, "polygon");
    area.setAttribute("class", "area");
    area.setAttribute("points", `0,30 ${pts} 100,30`);
    const line = document.createElementNS(svg.namespaceURI, "polyline");
    line.setAttribute("class", "line");
    line.setAttribute("points", pts);
    svg.append(area, line);
    return h(
      "div",
      `chart${bad ? " bad" : ""}`,
      h("h3", null, h("span", null, title), h("span", "sub", note)),
      svg,
    );
  }

  let seriesText = "";
  async function loadSeries() {
    const res = await fetch("/series", { cache: "no-store" });
    if (!res.ok) return;
    const text = await res.text();
    if (text === seriesText) return;
    seriesText = text;
    const s: Series = JSON.parse(text);
    $("series-source").textContent =
      s.source === "clickhouse"
        ? `ClickHouse${s.dropped ? `, ${s.dropped} events dropped while it was down` : ""}`
        : "Postgres and this process's last 500 events (ClickHouse off)";
    const errorRate = s.requests.map((r, i) => (r ? ((s.errors[i] ?? 0) / r) * 100 : 0));
    const reqs = sum(s.requests);
    const errs = sum(s.errors);
    const statuses = Object.keys(s.tasks);
    $("charts").replaceChildren(
      chart("Requests / min", s.requests, `${s.requests.at(-1) ?? 0} now, ${reqs} in 2 h`),
      chart(
        "Error rate (5xx)",
        errorRate,
        `${reqs ? ((errs / reqs) * 100).toFixed(1) : "0.0"}% over 2 h`,
        errs > 0,
      ),
      chart("p95 latency", s.p95_ms, `${Math.max(0, ...s.p95_ms)} ms max over 2 h`),
      ...(statuses.length
        ? statuses.map((st) => {
            const counts = s.tasks[st] as number[];
            return chart(
              `Tasks / hour: ${st}`,
              counts,
              `${sum(counts)} in 24 h`,
              ["needs_review", "disputed"].includes(st),
            );
          })
        : [
            chart(
              "Tasks / hour",
              s.hours.map(() => 0),
              "none in 24 h",
            ),
          ]),
      chart(
        "Payouts / hour",
        s.payouts.ok,
        `${sum(s.payouts.ok)} ok, ${sum(s.payouts.failed)} failed in 24 h`,
        sum(s.payouts.failed) > 0,
      ),
    );
  }

  async function poll() {
    const state = $("state");
    try {
      const res = await fetch("/feed", { cache: "no-store" });
      if (res.status === 401) return location.assign(`${base}/login`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      render(await res.json());
      await Promise.all([
        loadTickets(),
        // Refresh the first page on each poll unless the operator paged back.
        document.querySelectorAll("#events tr").length > 200 ? null : loadEvents(false),
        loadSeries(),
      ]);
      state.className = "ui-badge ui-badge--success";
      state.textContent = "Live";
      $("updated").textContent = `updated ${new Date().toLocaleTimeString()}, every ${POLL_MS / 1000} s`;
    } catch (err) {
      state.className = "ui-badge ui-badge--danger";
      state.textContent = `Feed failed: ${(err as Error).message}`;
    }
    win.setTimeout(poll, POLL_MS);
  }
  $("logout").addEventListener("click", async () => {
    await fetch("/logout", { method: "POST" }).catch(() => {});
    location.assign(`${base}/login`);
  });
  for (const id of ["f-q", "f-kind", "f-level", "f-task"])
    $(id).addEventListener("change", () => loadEvents(false));
  $("f-q").addEventListener("input", () => {
    win.clearTimeout(win.qTimer);
    win.qTimer = win.setTimeout(() => loadEvents(false), 300);
  });
  $("older").addEventListener("click", () => loadEvents(true));
  $("task-status").addEventListener("change", renderTasks);
  $("ledger-type").addEventListener("change", renderLedger);
  $("t-status").addEventListener("change", () => {
    ticketPages = 1;
    renderTickets();
  });
  $("t-q").addEventListener("input", () => {
    ticketPages = 1;
    renderTickets();
  });
  $("t-more").addEventListener("click", () => {
    ticketPages++;
    renderTickets();
  });

  const later = (fn: () => void, ms: number) => {
    const id = win.setTimeout(fn, ms);
    return () => win.clearTimeout(id);
  };
  // Each tab's table keeps its state in the hash while it is shown, and in memory when it is not.
  const remembered: Record<string, TableState> = {};
  const restore: Record<string, (params: URLSearchParams) => void> = {};
  const tableFor = <T>(tab: string, options: Omit<TableOptions<T>, "onChange" | "later">) => {
    const table = createTable<T>(document, {
      ...options,
      later,
      onChange: (state) => {
        remembered[tab] = state;
        history.replaceState(null, "", hashFor(tab, state));
      },
    });
    restore[tab] = (params) => {
      const state = params.size ? stateFrom(params, options.filters) : remembered[tab];
      if (!state) return;
      remembered[tab] = state;
      table.setState(state);
      history.replaceState(null, "", hashFor(tab, state));
    };
    return table;
  };
  const checkText = (t: Checked) =>
    t.gps_ok == null
      ? ""
      : [
          [t.gps_ok, "GPS"],
          [t.fresh_ok, "fresh"],
          [t.vision_ok, "safe photo"],
        ]
          .map(([ok, label]) => `${ok ? "✓" : "✗"} ${label}`)
          .join(" ");
  const review = tableFor<Task>("review", {
    name: "decisions",
    empty:
      "Nothing needs a decision. Tasks in needs_review or disputed show here; click one to release or refund it.",
    label: (t) => `Review: ${cut(t.question, 80)}`,
    open: (t) => openReview(t.id),
    columns: [
      {
        key: "question",
        label: "Question",
        text: (t) => cut(t.question, 160),
        cell: (t) => h("p", "q", cut(t.question, 160)),
      },
      { key: "place", label: "Place", text: (t) => cut(nearLabel(t.place_label), 70) },
      {
        key: "bounty",
        label: "Bounty",
        num: true,
        desc: true,
        text: (t) => usd(t.bounty_cents),
        sort: (t) => t.bounty_cents ?? 0,
      },
      { key: "checks", label: "Checks", text: checkText, cell: (t) => checks(t) ?? "" },
      {
        key: "status",
        label: "Status",
        text: (t) => t.status.replace("_", " "),
        cell: (t) => badge(t.status.replace("_", " "), STATUS_TONE[t.status]),
      },
      {
        key: "age",
        label: "Age",
        num: true,
        desc: true,
        text: (t) => ago(t.created_at, Date.now()),
        sort: (t) => -Date.parse(t.created_at),
      },
    ],
    filters: [
      {
        kind: "select",
        key: "status",
        label: "Statuses",
        options: [
          ["needs_review", "needs review"],
          ["disputed", "disputed"],
        ],
        value: (t) => t.status,
      },
      {
        kind: "range",
        key: "created",
        label: "Created",
        unit: "date",
        value: (t) => Date.parse(t.created_at),
      },
      { kind: "range", key: "bounty", label: "Bounty", unit: "usd", value: (t) => t.bounty_cents ?? null },
    ],
  });
  $("queue").replaceChildren(review.el);

  function showTab() {
    const name = tabFor(location.hash);
    restore[name]?.(parseHash(location.hash).params);
    for (const t of TABS) {
      $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
      $(`tab-${t}`).tabIndex = t === name ? 0 : -1;
      $(`p-${t}`).hidden = t !== name;
    }
    $(`tab-${name}`).scrollIntoView({ block: "nearest", inline: "nearest" });
    // Leaflet measured a hidden box; size it again and refit.
    if (name === "workers" && map) {
      map.invalidateSize();
      fitted = false;
      renderMap(last.workers);
    }
  }
  $("tabs").addEventListener("keydown", (e) => {
    const t = nextTab(document.activeElement?.id ?? "", e.key);
    if (!t) return;
    e.preventDefault();
    $(`tab-${t}`).focus();
    history.replaceState(null, "", remembered[t] ? hashFor(t, remembered[t]) : `#${t}`);
    showTab();
  });
  win.addEventListener("hashchange", showTab);
  function measure() {
    const bar = document.querySelector<HTMLElement>(".bar")?.offsetHeight ?? 0;
    document.documentElement.style.setProperty("--bar-h", `${bar}px`);
    document.documentElement.style.setProperty("--chrome", `${bar + $("tabs").offsetHeight}px`);
  }
  win.addEventListener("resize", measure);
  measure();
  showTab();
  return poll();
}
