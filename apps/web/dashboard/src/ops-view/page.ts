// The /ops page: DOM rendering, polling, the review panel and ticket actions. server.ts inlines this file
// (types stripped, imports dropped) after format.ts into ops.html and calls boot(window).

import { type Action, actionArea, createToaster, type Outcome } from "./actions.ts";
import {
  after,
  ago,
  checkReason,
  cut,
  datedQuery,
  eventQuery,
  LEDGER_LABEL,
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
  WHEN,
} from "./format.ts";
import {
  badgeIcon,
  eventDetail,
  eventKey,
  LEVELS,
  type LogEvent,
  levelOf,
  mergeEvents,
  SOURCES,
  sourceOf,
} from "./logs.ts";
import {
  chartCard,
  renderFunnel,
  renderHealth,
  renderMoney,
  type SeriesData,
  seriesCharts,
} from "./overview.ts";
import {
  createTable,
  type Filter,
  hashFor,
  parseHash,
  stateFrom,
  type TableOptions,
  type TableState,
} from "./table.ts";

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
  /** From the paged /ops/tasks list. */
  agent?: string | null;
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
type LedgerRow = {
  id: string;
  type: string;
  created_at: string;
  task_id?: string | null;
  amount_cents: number;
  place_label?: string | null;
};
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
type Series = SeriesData & { source: string; dropped?: number };
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
  const json = <T>(res: Response) => res.json().catch(() => ({})) as Promise<T>;

  function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, ...kids: Kid[]) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    for (const kid of kids) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  const empty = (text: string) => h("li", "muted", text);
  const badge = (text: string, tone?: string) =>
    h("span", `ui-badge${tone ? ` ui-badge--${tone}` : ""}`, text);
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

  // Release or refund a needs_review / disputed task. Same server path as `pnpm resolve-task` (resolveTask).
  // From the Tasks list the row also brings the task's timeline (asked, claimed, answered, money).
  async function openReview(id: string, row?: Task) {
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
    const bounty = t.bounty_cents ?? 0;
    const resolve =
      (outcome: "release" | "refund") =>
      async (note: string): Promise<Outcome> => {
        const r = await fetch(`/tasks/${t.id}/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ outcome, note: note || undefined }),
        });
        const body = await json<Reply>(r);
        if (!r.ok) return { ok: false, message: `Failed: ${body.message || body.error || r.status}` };
        return {
          ok: true,
          message: body.already_resolved
            ? `Already ${body.status}; no money moved.`
            : `Done: ${body.status}. It leaves the queue on the next refresh.`,
        };
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
        row ? flow(row) : null,
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
          ? actionArea(document, {
              id: `task-${t.id}`,
              primary: {
                label: "Release to the worker",
                confirm: `Pay the worker ${usd(bounty)}? The task is marked verified.`,
                verb: `Release ${usd(bounty)}`,
                tone: "primary",
                run: resolve("release"),
              },
              more: [
                {
                  label: "Refund the agent",
                  confirm: `Return ${usd(bounty + t.fee_cents)} to the agent? The worker is not paid.`,
                  verb: `Refund ${usd(bounty + t.fee_cents)}`,
                  tone: "danger",
                  run: resolve("refund"),
                },
              ],
              note: { label: "Note (optional)", hint: "Saved with the decision.", required: false },
              toast,
            })
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

  function render(feed: OpsFeed) {
    const o = feed.ops;
    const hl = o.health;
    $("uptime").textContent = uptime(hl.uptime_s).replace(/^up /, "");
    renderHealth(document, $("health"), hl);
    const banner = $("banner");
    banner.hidden = !hl.db_error;
    banner.textContent = hl.db_error
      ? `Database read failed: ${hl.db_error}. Health and errors below are still live.`
      : "";

    const total = sum(Object.values(o.statuses));
    $("operator").textContent = o.operator ? `signed in: ${o.operator}` : "";
    $("tasks-total").textContent =
      `${total}${o.partial.tasks ? "+" : ""} created since ${time(o.since)} yesterday`;
    renderFunnel(document, $("statuses"), o.statuses);

    const m = o.money_24h;
    $("escrowed").textContent = usd(feed.totals.escrowed_cents);
    renderMoney(document, $("money-kv"), m);

    $("queue-count").textContent = String(o.queue.length);
    $("queue-count").className = `ui-badge${o.queue.length ? " ui-badge--danger" : " ui-badge--success"}`;
    review.setRows(o.queue);
    count("n-review", o.queue.length, true);

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
    workers.setRows(feed.workers);
    renderMap(workers.visible());
    // The list tabs refresh with the feed while they are shown.
    const tab = tabFor(location.hash);
    if (tab === "tasks") taskPager.load();
    if (tab === "money") ledgerPager.load();

    $("errors").replaceChildren(
      ...(o.errors.length
        ? o.errors.map((e) =>
            h(
              "li",
              null,
              h(
                "div",
                "line",
                badgeIcon(document, levelOf(e.level), `ev-level ev-level--${e.level}`),
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

  // Ticket decisions. Dispute actions (confirm_fraud, reject_dispute) take only a note; the others also send the task id.
  const decideTicket =
    (t: Ticket, action: string) =>
    async (note: string): Promise<Outcome> => {
      const res = await fetch(`/tickets/${t.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(t.kind === "dispute" ? { note } : { task_id: t.task_id, note }),
      });
      const body = await json<Reply>(res);
      if (!res.ok) return { ok: false, message: `Failed: ${body.message || body.error || res.status}` };
      loadTickets();
      countOpenTickets();
      return {
        ok: true,
        message: body.already_resolved
          ? `Already ${body.dispute_status || "resolved"}; no money moved.`
          : action === "confirm_fraud"
            ? `Done: agent refunded ${usd(body.agent_refund_cents as number)}, transfer ${body.reversal === "owed" ? `reversal owed ${usd(body.reversal_owed_cents as number)}` : body.reversal}, worker banned.`
            : `Done: ticket #${t.id} ${action.replace("_", " ")}.`,
      };
    };

  /** One clear primary action per ticket state; the rest in the menu. */
  function ticketActions(t: Ticket) {
    const bounty = usd(t.bounty_cents);
    if (t.kind === "dispute")
      return actionArea(document, {
        id: `ticket-${t.id}`,
        primary: {
          label: "Reject the dispute",
          confirm: "Reject the dispute? The answer stands and the worker keeps the pay.",
          verb: "Reject dispute",
          tone: "primary",
          run: decideTicket(t, "reject_dispute"),
        },
        more: [
          {
            label: "Confirm fraud",
            confirm: "Confirm fraud? The agent is refunded, the payout reversed and the worker banned.",
            verb: "Confirm fraud",
            tone: "danger",
            run: decideTicket(t, "confirm_fraud"),
          },
        ],
        note: { label: "Note", hint: "Kept with the decision.", required: true },
        toast,
      });
    const held = t.task_status === "needs_review" || t.task_status === "disputed";
    const close: Action = {
      label: "Resolve with note",
      confirm: "Close the ticket? No money moves; the worker gets your note.",
      verb: "Resolve",
      tone: held ? "ghost" : "primary",
      run: decideTicket(t, "close"),
    };
    return actionArea(document, {
      id: `ticket-${t.id}`,
      primary: held
        ? {
            label: "Release to the worker",
            confirm: `Pay the worker ${bounty}? They get your note by text.`,
            verb: `Release ${bounty}`,
            tone: "primary",
            run: decideTicket(t, "release"),
          }
        : close,
      more: held
        ? [
            {
              label: "Refund the agent",
              confirm: "Refund the agent? The worker is not paid and gets your note by text.",
              verb: "Refund the agent",
              tone: "danger",
              run: decideTicket(t, "refund"),
            },
            close,
          ]
        : [],
      note: { label: "Note to the worker", hint: "Texted to the worker.", required: true },
      toast,
    });
  }

  const ticketState = (t: Ticket) =>
    t.kind === "dispute" ? t.dispute_status || "open" : ticketOpen(t) ? "open" : "resolved";
  const stateTone = (state: string) =>
    state === "open" ? "danger" : state === "upheld" ? "warning" : "success";
  function openTicket(t: Ticket) {
    const panel = $<HTMLDialogElement>("review-panel");
    const close = h("button", "ui-button ui-button--ghost ui-button--sm", "Close");
    close.type = "button";
    close.addEventListener("click", () => panel.close());
    const dispute = t.kind === "dispute";
    const state = ticketState(t);
    panel.replaceChildren(
      ...[
        h(
          "div",
          "task-head",
          h("h2", "ui-card__title", `Ticket #${t.id}`),
          h("span", "line", dispute ? badge("dispute", "warning") : null, badge(state, stateTone(state))),
          close,
        ),
        h("p", "q", cut(t.question, 200)),
        photoOf(t),
        h(
          "div",
          "line",
          h("span", null, cut(nearLabel(t.place_label), 90)),
          h(
            "span",
            null,
            "answer taken ",
            h("strong", null, t.distance_m == null ? "?" : `${t.distance_m} m`),
            ` from the place (radius ${t.radius_m} m)`,
          ),
          h("span", null, "bounty ", h("strong", null, usd(t.bounty_cents))),
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
        state === "open"
          ? ticketActions(t)
          : h("p", "muted", `Resolved ${stamp(t.resolved_at)}${t.note ? `: ${t.note}` : ""}`),
      ].filter((x) => x != null),
    );
    if (!panel.open) panel.showModal();
  }

  /**
   * A server-paged list (tickets, tasks, ledger): newest first by cursor. A filter change starts over;
   * a poll with the same filters refreshes the first page and keeps older pages already loaded. A
   * response for filters that have since changed is dropped.
   */
  function pager<T extends { id: string | number; created_at?: string | null }>(opts: {
    path: string;
    field: string;
    query: () => URLSearchParams;
    table: () => { setRows(rows: T[]): void; setEnd(end: "more" | "loading" | "end"): void };
    onBody?: (body: Record<string, unknown>) => void;
  }) {
    let rows: T[] = [];
    let cursor: string | null = null;
    let total: number | null = null;
    let gen = 0;
    let loaded = "";
    let busy = false;
    let paged = false;
    async function load(older = false) {
      if (older && (busy || !cursor)) return;
      const g = older ? gen : ++gen;
      const query = opts.query();
      const filters = String(query);
      query.set("limit", "50");
      if (older) {
        busy = true;
        query.set("cursor", cursor as string);
        opts.table().setEnd("loading");
      }
      // Offline counts as a failed page: the pager stays where it was.
      const res = await fetch(`${opts.path}?${query}`, { cache: "no-store" }).catch(() => null);
      if (older) busy = false;
      if (g !== gen) return;
      if (!res?.ok) {
        opts.table().setEnd(cursor ? "more" : "end");
        return;
      }
      const body = (await res.json()) as Record<string, unknown> & {
        total: number;
        next_cursor: string | null;
      };
      const fresh = body[opts.field] as T[];
      total = body.total;
      opts.onBody?.(body);
      if (older) {
        rows = [...rows, ...fresh.filter((r) => !rows.some((x) => x.id === r.id))];
        cursor = body.next_cursor;
        paged = true;
      } else {
        const kept = filters === loaded && paged;
        const oldest = fresh.at(-1)?.created_at ?? "";
        rows = [...fresh, ...(kept ? rows.filter((r) => (r.created_at ?? "") < oldest) : [])];
        if (!kept) {
          cursor = body.next_cursor;
          paged = false;
        }
        loaded = filters;
      }
      opts.table().setRows(rows);
      opts.table().setEnd(cursor ? "more" : "end");
    }
    return {
      load,
      total: () => total,
      // Sorting reorders what is loaded; only a filter or search change asks the server again.
      changed: () => String(opts.query()) !== loaded && load(),
    };
  }
  const params = (entries: [string, string | undefined][]) => {
    const p = new URLSearchParams();
    for (const [k, v] of entries) if (v?.trim()) p.set(k, v.trim());
    return p;
  };

  // Support tickets.
  const ticketPager = pager<Ticket>({
    path: "/tickets",
    field: "tickets",
    query: (): URLSearchParams => {
      const st: TableState = support.state();
      return params([
        ["q", st.q],
        ["state", st.f.state],
        ["kind", st.f.kind],
      ]);
    },
    table: () => support,
  });
  const loadTickets = (older = false) => ticketPager.load(older);
  // The tab and header counts are open tickets of any kind, whatever the list filters.
  async function countOpenTickets() {
    const res = await fetch("/tickets?state=open&limit=1", { cache: "no-store" });
    if (!res.ok) return;
    const open = Number(((await res.json()) as { total: number }).total);
    $("tickets-count").textContent = `${open} open`;
    $("tickets-count").className = `ui-badge ${open ? "ui-badge--danger" : "ui-badge--success"}`;
    count("n-support", open, true);
  }

  // Logs: server-paged by cursor, newest first. Live events wait behind a pill instead of moving the list.
  let events: LogEvent[] = [];
  let pending: LogEvent[] = [];
  let cursor: string | null = null;
  let newest: string | null = null;
  let generation = 0;
  let loadingOlder = false;
  let loadedQuery = "";
  const eventFilters = () => {
    const st = logs.state();
    return eventQuery(
      {
        q: st.q,
        kind: st.f.kind ?? "",
        level: st.f.level ?? "",
        task_id: st.f.task ?? "",
        monitors: st.f.monitors ?? "",
        ...Object.fromEntries(datedQuery(st.f, st.q, new Date())),
      },
      null,
    );
  };
  async function loadEvents(older: boolean) {
    if (older && (loadingOlder || !cursor)) return;
    const gen = older ? generation : ++generation;
    const query = eventFilters();
    if (!older) loadedQuery = String(query);
    query.set("limit", "100");
    if (older) {
      loadingOlder = true;
      query.set("cursor", cursor as string);
      logs.setEnd("loading");
    }
    const res = await fetch(`/events?${query}`, { cache: "no-store" });
    if (older) loadingOlder = false;
    if (gen !== generation) return;
    if (!res.ok) {
      logs.setEnd(cursor ? "more" : "end");
      return;
    }
    const body = (await res.json()) as {
      source: string;
      events: LogEvent[];
      next_cursor: string | null;
      newest_cursor: string | null;
    };
    $("events-source").textContent =
      body.source === "memory" ? "Database unreachable: this process's memory only" : "Newest first";
    if (older) events = mergeEvents(events, body.events);
    else {
      events = body.events;
      newest = body.newest_cursor;
      pending = [];
      showPending();
    }
    cursor = body.next_cursor;
    logs.setRows(events);
    logs.setEnd(cursor ? "more" : "end");
  }
  // Each poll asks only for events newer than the newest one shown.
  async function pollEvents() {
    if (!newest) return loadEvents(false);
    const gen = generation;
    const query = eventFilters();
    query.set("since", newest);
    const res = await fetch(`/events?${query}`, { cache: "no-store" });
    if (!res.ok || gen !== generation) return;
    const body = (await res.json()) as { events: LogEvent[]; newest_cursor: string | null };
    newest = body.newest_cursor ?? newest;
    pending = mergeEvents(body.events, pending).filter(
      (e) => !events.some((x) => eventKey(x) === eventKey(e)),
    );
    showPending();
  }
  function showPending() {
    const pill = $<HTMLButtonElement>("new-events");
    pill.hidden = pending.length === 0;
    pill.textContent = `${pending.length} new event${pending.length === 1 ? "" : "s"}`;
  }
  $("new-events").addEventListener("click", () => {
    events = mergeEvents(pending, events);
    pending = [];
    showPending();
    logs.setRows(events);
    $("events").scrollIntoView({ block: "start" });
  });

  const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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
    $("charts").replaceChildren(...seriesCharts(s).map((spec) => chartCard(document, spec, clock)));
  }

  async function poll() {
    const state = $("state");
    try {
      const res = await fetch("/feed", { cache: "no-store" });
      if (res.status === 401) return location.assign(`${base}/login`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      render(await res.json());
      await Promise.all([loadTickets(), countOpenTickets(), pollEvents(), loadSeries()]);
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

  const later = (fn: () => void, ms: number) => {
    const id = win.setTimeout(fn, ms);
    return () => win.clearTimeout(id);
  };
  // Each tab's table keeps its state in the hash while it is shown, and in memory when it is not.
  const remembered: Record<string, TableState> = {};
  const restore: Record<string, (params: URLSearchParams) => void> = {};
  // Today, yesterday, the last 7 days, or custom days; the server filters (see datedQuery).
  const dateFilters = <T>(): Filter<T>[] => [
    { kind: "select", key: "when", label: "Dates", options: WHEN },
    { kind: "range", key: "date", label: "From, to", unit: "date", value: () => null },
  ];
  const tableFor = <T>(
    tab: string,
    options: Omit<TableOptions<T>, "onChange" | "later"> & { onState?: () => void; initial?: TableState },
  ) => {
    const table = createTable<T>(document, {
      ...options,
      later,
      onChange: (state) => {
        remembered[tab] = state;
        // Only the shown tab owns the hash.
        if (tabFor(location.hash) === tab) history.replaceState(null, "", hashFor(tab, state));
        options.onState?.();
      },
    });
    if (options.initial) {
      remembered[tab] = options.initial;
      table.setState(options.initial);
    }
    restore[tab] = (params) => {
      const state = params.size ? stateFrom(params, options.filters) : remembered[tab];
      if (!state) return;
      remembered[tab] = state;
      table.setState(state);
      history.replaceState(null, "", hashFor(tab, state));
      options.onState?.();
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

  const logs = tableFor<LogEvent>("logs", {
    name: "events",
    empty: "No events match.",
    remote: { noun: "events", more: () => loadEvents(true) },
    key: eventKey,
    detail: (e) =>
      eventDetail(document, e, (task) => {
        logs.setState({ ...logs.state(), f: { ...logs.state().f, task } });
        history.replaceState(null, "", hashFor("logs", logs.state()));
        loadEvents(false);
      }),
    label: (e) => `${levelOf(e.level)[0]}, ${sourceOf(e.kind)[0]}: ${cut(e.summary, 80)}`,
    // Sorting reorders what is loaded; only a filter or search change asks the server again.
    onState: () => String(eventFilters()) !== loadedQuery && loadEvents(false),
    columns: [
      {
        key: "level",
        label: "Level",
        text: (e) => levelOf(e.level)[0],
        cell: (e) => badgeIcon(document, levelOf(e.level), `ev-level ev-level--${e.level}`),
      },
      {
        key: "at",
        label: "Time",
        num: true,
        desc: true,
        text: (e) => stamp(e.at),
        sort: (e) => Date.parse(e.at),
      },
      {
        key: "kind",
        label: "Source",
        text: (e) => sourceOf(e.kind)[0],
        cell: (e) => badgeIcon(document, sourceOf(e.kind), "ev-source"),
      },
      { key: "summary", label: "Event", text: (e) => e.summary, cell: (e) => h("span", "ev-sum", e.summary) },
    ],
    filters: [
      {
        kind: "select",
        key: "kind",
        label: "Sources",
        options: Object.entries(SOURCES).map(([k, [label]]) => [k, label]),
      },
      {
        kind: "select",
        key: "level",
        label: "Levels",
        options: Object.entries(LEVELS).map(([k, [label]]) => [k, label]),
      },
      { kind: "text", key: "task", label: "Task id" },
      ...dateFilters(),
      // Uptime monitors' /healthz checks, every minute: hidden unless asked for.
      { kind: "check", key: "monitors", label: "Show health checks" },
    ],
  });
  $("events").replaceChildren(logs.el);
  logs.el.querySelector(".tbl-bar")?.append($("new-events"));

  const support = tableFor<Ticket>("support", {
    name: "tickets",
    empty: "No tickets. A worker opens one by texting HELP after an answer is held for review.",
    remote: {
      noun: "tickets",
      more: () => loadTickets(true),
      total: (): number | null => ticketPager.total(),
    },
    initial: { q: "", sort: "", f: { state: "open" } },
    key: (t) => String(t.id),
    label: (t) => `Ticket ${t.id}: ${cut(t.question, 80)}`,
    open: openTicket,
    onState: () => ticketPager.changed(),
    columns: [
      {
        key: "ticket",
        label: "Ticket",
        text: (t) => `#${t.id} ${cut(t.question, 120)}`,
        sort: (t) => t.id,
        cell: (t) => h("p", "q", h("span", "tiny", `#${t.id} `), cut(t.question, 120)),
      },
      { key: "kind", label: "Kind", text: (t) => (t.kind === "dispute" ? "Dispute" : "Help") },
      {
        key: "state",
        label: "State",
        text: ticketState,
        cell: (t) => badge(ticketState(t), stateTone(ticketState(t))),
      },
      { key: "place", label: "Place", text: (t) => cut(nearLabel(t.place_label), 60) },
      {
        key: "bounty",
        label: "Bounty",
        num: true,
        desc: true,
        text: (t) => usd(t.bounty_cents),
        sort: (t) => t.bounty_cents ?? 0,
      },
      {
        key: "distance",
        label: "Answer distance",
        num: true,
        text: (t) => (t.distance_m == null ? "?" : `${t.distance_m} m`),
        sort: (t) => t.distance_m ?? -1,
      },
      {
        key: "opened",
        label: "Opened",
        num: true,
        desc: true,
        text: (t) => ago(t.created_at ?? "", Date.now()),
        sort: (t) => -(Date.parse(t.created_at ?? "") || 0),
      },
    ],
    filters: [
      {
        kind: "select",
        key: "state",
        label: "States",
        options: [
          ["open", "Open"],
          ["resolved", "Resolved"],
        ],
      },
      {
        kind: "select",
        key: "kind",
        label: "Kinds",
        options: [
          ["manual_review", "Help"],
          ["dispute", "Dispute"],
        ],
      },
    ],
  });
  $("tickets").replaceChildren(support.el);

  // Tasks: server-paged; a click opens the task panel.
  const taskPager = pager<Task>({
    path: "/tasks",
    field: "tasks",
    query: (): URLSearchParams => {
      const st: TableState = tasks.state();
      return params([["q", st.q], ["status", st.f.status], ...datedQuery(st.f, st.q, new Date())]);
    },
    table: () => tasks,
  });
  const tasks = tableFor<Task>("tasks", {
    name: "tasks",
    empty: "No tasks yet.",
    remote: {
      noun: "tasks",
      more: () => taskPager.load(true),
      total: (): number | null => taskPager.total(),
    },
    key: (t) => t.id,
    label: (t) => `Task: ${cut(t.question, 80)}`,
    open: (t) => openReview(t.id, t),
    onState: () => taskPager.changed(),
    columns: [
      {
        key: "question",
        label: "Question",
        text: (t) => cut(t.question, 140),
        cell: (t) => h("p", "q", cut(t.question, 140)),
      },
      { key: "place", label: "Place", text: (t) => cut(nearLabel(t.place_label), 60) },
      {
        key: "bounty",
        label: "Bounty",
        num: true,
        desc: true,
        text: (t) => usd(t.bounty_cents),
        sort: (t) => t.bounty_cents ?? 0,
      },
      {
        key: "distance",
        label: "Worker distance",
        num: true,
        text: (t) => (t.distance_m == null ? "" : `${t.distance_m} m`),
        sort: (t) => t.distance_m ?? -1,
      },
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
        sort: (t) => -(Date.parse(t.created_at) || 0),
      },
      { key: "agent", label: "Agent", text: (t) => t.agent ?? "" },
    ],
    filters: [
      {
        kind: "select",
        key: "status",
        label: "Statuses",
        options: Object.keys(STATUS_TONE).map((s) => [s, s.replace("_", " ")]),
      },
      ...dateFilters(),
    ],
  });
  $("tasks").replaceChildren(tasks.el);

  // Money: the ledger, server-paged, with the total for whatever the filters select.
  const ledgerPager = pager<LedgerRow>({
    path: "/ledger",
    field: "ledger",
    query: (): URLSearchParams => {
      const st: TableState = ledger.state();
      return params([["q", st.q], ["type", st.f.type], ...datedQuery(st.f, st.q, new Date())]);
    },
    table: () => ledger,
    onBody: (body) => {
      const total = Number(body.total);
      $("ledger-total").textContent =
        `${usd(Number(body.total_cents))} across ${total} row${total === 1 ? "" : "s"}`;
    },
  });
  const ledger = tableFor<LedgerRow>("money", {
    name: "ledger rows",
    empty: "No ledger rows yet.",
    remote: {
      noun: "rows",
      more: () => ledgerPager.load(true),
      total: (): number | null => ledgerPager.total(),
    },
    key: (r) => r.id,
    onState: () => ledgerPager.changed(),
    columns: [
      {
        key: "date",
        label: "Date",
        desc: true,
        text: (r) => stamp(r.created_at),
        sort: (r) => Date.parse(r.created_at) || 0,
      },
      { key: "type", label: "Type", text: (r) => LEDGER_LABEL[r.type] || r.type },
      {
        key: "amount",
        label: "Amount",
        num: true,
        desc: true,
        text: (r) => usd(r.amount_cents),
        sort: (r) => r.amount_cents,
      },
      {
        key: "task",
        label: "Task",
        text: (r) => (r.task_id ? `${cut(nearLabel(r.place_label), 50)} ${r.task_id.slice(0, 8)}` : ""),
        cell: (r) =>
          r.task_id
            ? h(
                "span",
                null,
                cut(nearLabel(r.place_label), 50),
                h("span", "tiny", ` ${r.task_id.slice(0, 8)}`),
              )
            : "",
      },
    ],
    filters: [
      {
        kind: "select",
        key: "type",
        label: "Types",
        options: Object.entries(LEDGER_LABEL).map(([k, label]) => [k, label]),
      },
      ...dateFilters(),
    ],
  });
  $("ledger").replaceChildren(ledger.el);

  // Workers: every worker from the feed; the filters also pick which markers the map shows.
  const rank = (w: Worker) => (w.available && w.opted_in ? 2 : w.opted_in ? 1 : 0);
  const RANK = ["opted out", "opted in", "available"];
  const workers = tableFor<Worker>("workers", {
    name: "workers",
    empty: "No workers yet.",
    initial: { q: "", sort: "-state", f: {} },
    onState: () => renderMap(workers.visible()),
    columns: [
      { key: "worker", label: "Worker", text: (w) => `worker ${w.id.slice(0, 8)}` },
      {
        key: "state",
        label: "State",
        desc: true,
        text: (w) => RANK[rank(w)] as string,
        sort: rank,
        cell: (w) => badge(RANK[rank(w)] as string, rank(w) === 2 ? "success" : ""),
      },
      { key: "location", label: "Location", text: (w) => (w.lat == null ? "no location" : "on the map") },
    ],
    filters: [
      {
        kind: "select",
        key: "state",
        label: "States",
        options: RANK.map((r) => [r, r]),
        value: (w) => RANK[rank(w)] as string,
      },
      {
        kind: "select",
        key: "location",
        label: "Locations",
        options: [
          ["on the map", "On the map"],
          ["no location", "No location"],
        ],
        value: (w) => (w.lat == null ? "no location" : "on the map"),
      },
    ],
  });
  $("workers").replaceChildren(workers.el);

  const toast = createToaster(document, later);

  function showTab() {
    const name = tabFor(location.hash);
    restore[name]?.(parseHash(location.hash).params);
    for (const t of TABS) {
      $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
      $(`tab-${t}`).tabIndex = t === name ? 0 : -1;
      $(`p-${t}`).hidden = t !== name;
    }
    $(`tab-${name}`).scrollIntoView({ block: "nearest", inline: "nearest" });
    if (name === "tasks") taskPager.load();
    if (name === "money") ledgerPager.load();
    // Leaflet measured a hidden box; size it again and refit.
    if (name === "workers" && map) {
      map.invalidateSize();
      fitted = false;
      renderMap(workers.visible());
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
