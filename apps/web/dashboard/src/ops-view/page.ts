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
  LIVE,
  nearLabel,
  nextTab,
  POLL_MS,
  STATUS_TONE,
  stamp,
  sum,
  TABS,
  type TicketFields,
  type Timed,
  tabFor,
  taskHeadline,
  taskSteps,
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
  statusLabel,
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
  /** A smoke or end-to-end run (migration 030): tagged, never counted. */
  test?: boolean;
  /** From the feed: where the task is, for its map marker. */
  lat?: number;
  lng?: number;
  fee_cents?: number;
};
/** GET /ops/workers/:id: one worker for the Workers panel. */
type WorkerDetail = {
  worker: Worker & {
    banned?: boolean;
    location_at: string;
    location_source?: string | null;
    created_at: string;
  };
  tasks: (Task & Checked & Timed)[];
  earnings: { paid_cents?: number; payouts?: number; released_cents?: number; last_paid_at?: string | null };
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
    classifier_status?: "open" | "approved" | "rejected" | "expired" | "consumed";
    agent_id?: string;
    request?: Record<string, unknown> | null;
    reported_context?: unknown;
    request_fingerprint?: string;
    decision_by?: string | null;
    decision_at?: string | null;
    approval_expires_at?: string | null;
  };
export type Worker = {
  id: string;
  lat: number | null;
  lng: number | null;
  available: boolean;
  opted_in: boolean;
  /** App Review and other test accounts (migration 030): listed, never counted or mapped. */
  test?: boolean;
};
/** A real position: not missing, not the 0,0 placeholder. */
const located = (p: { lat?: number | null; lng?: number | null }) =>
  p.lat != null && p.lng != null && !(p.lat === 0 && p.lng === 0);
/** The content hash in an InsForge photo URL (?v=<md5>); two tasks with the same one share a photo. */
const photoHash = (url: string | null | undefined) =>
  url ? new URL(url).searchParams.get("v") || url : null;
type LedgerRow = {
  id: string;
  type: string;
  created_at: string;
  task_id?: string | null;
  amount_cents: number;
  place_label?: string | null;
};
/** GET /ops/issues: one issue, with 24 hourly counts and how many it touched. */
type Issue = {
  fingerprint: string;
  level: string;
  title: string;
  culprit: string | null;
  status: "unresolved" | "resolved" | "ignored";
  regressed: boolean;
  ignore_until: number | null;
  count: number;
  first_seen: string;
  last_seen: string;
  message: string;
  stack: string | null;
  spark: number[];
  affected: { workers: number; agents: number; tasks: number };
};
type IssueEvent = { id: number; at: string; message: string; tags: Record<string, string> };
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
  };
};
type Series = SeriesData & { source: string; dropped?: number };
type Reply = { message?: string; error?: string; [key: string]: unknown };

type Layer = { addTo(target: unknown): Layer; clearLayers(): void };
type Marker = Layer & {
  on(event: string, fn: () => void): Marker;
  bindTooltip(text: string, options?: object): Marker;
};
type LeafletMap = {
  setView(center: [number, number], zoom: number): LeafletMap;
  fitBounds(bounds: unknown, options: object): void;
  invalidateSize(): void;
};
export type Leaflet = {
  map(id: string, options: object): LeafletMap;
  tileLayer(url: string, options: object): Layer;
  layerGroup(): Layer;
  circleMarker(at: [number, number], options: object): Marker;
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

  const safety = $("safety-settings");
  const safetyControls = $<HTMLFieldSetElement>("safety-controls");
  const safetyInput = $<HTMLInputElement>("safety-threshold");
  const safetySave = $<HTMLButtonElement>("safety-save");
  const safetyRetry = $<HTMLButtonElement>("safety-retry");
  const safetyStatus = $("safety-status");
  let safetySaved: number | null = null;
  let safetyPending = false;
  const validThreshold = (value: number) => Number.isFinite(value) && value >= 0.5 && value <= 1;
  function safetyMessage(message: string, state = "") {
    safetyStatus.textContent = message;
    safetyStatus.dataset.state = state;
    safetyStatus.setAttribute("role", state === "error" ? "alert" : "status");
  }
  function updateSafety() {
    const value = safetyInput.valueAsNumber;
    $("safety-value").textContent = safetySaved === null ? "—" : value.toFixed(2);
    $("safety-saved").textContent = safetySaved === null ? "" : `Saved: ${safetySaved.toFixed(2)}`;
    safetySave.disabled =
      safetyPending || safetySaved === null || !validThreshold(value) || value === safetySaved;
    safetyControls.disabled = safetyPending || safetySaved === null;
    safety.setAttribute("aria-busy", String(safetyPending));
  }
  async function thresholdResponse(res: Response) {
    const body = await json<{ classifier_block_min: number; message?: string; error?: string }>(res);
    if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
    if (!validThreshold(body.classifier_block_min)) throw new Error("Invalid threshold from server");
    return body.classifier_block_min;
  }
  async function loadSafety() {
    safetyPending = true;
    safetyRetry.hidden = true;
    safetyMessage("Loading settings…");
    updateSafety();
    try {
      const res = await fetch("/api/settings", {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      if (res.status === 404) {
        safety.hidden = true;
        return;
      }
      safetySaved = await thresholdResponse(res);
      safetyInput.value = String(safetySaved);
      safetyMessage("");
    } catch (error) {
      safetyMessage(
        `Could not load settings: ${error instanceof Error ? error.message : "Request failed"}`,
        "error",
      );
      safetyRetry.hidden = false;
    } finally {
      safetyPending = false;
      updateSafety();
    }
  }
  safetyInput.addEventListener("input", () => {
    safetyMessage("");
    updateSafety();
  });
  safetyRetry.addEventListener("click", () => void loadSafety());
  $("safety-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = safetyInput.valueAsNumber;
    if (safetyPending || safetySaved === null || !validThreshold(value) || value === safetySaved) return;
    safetyPending = true;
    safetySave.textContent = "Saving…";
    safetyMessage("Saving…");
    updateSafety();
    try {
      safetySaved = await thresholdResponse(
        await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ classifier_block_min: value }),
        }),
      );
      safetyInput.value = String(safetySaved);
      safetyMessage("Saved.", "success");
    } catch (error) {
      safetyMessage(`Not saved: ${error instanceof Error ? error.message : "Request failed"}`, "error");
    } finally {
      safetyPending = false;
      safetySave.textContent = "Save";
      updateSafety();
    }
  });

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

  // A small photo that opens full width on click (and on Enter), and closes the same way.
  function thumb(url: string) {
    const img = h("img", "thumb");
    img.src = url;
    img.alt = "Worker photo; select to enlarge";
    img.referrerPolicy = "no-referrer";
    img.tabIndex = 0;
    const toggle = () => img.classList.toggle("is-big");
    img.addEventListener("click", toggle);
    img.addEventListener("keydown", (e) => e.key === "Enter" && toggle());
    return img;
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

  // Workers map: dark street tiles in dark mode, task pins colored by status, workers you can click.
  let map: LeafletMap | null = null;
  let layer: Layer | null = null;
  let fitted = false;
  let mapTasks: Task[] = [];
  // Attention first, then live, then done, then ended: the order pins stack and spots pick a color.
  const URGENCY = (t: Task) =>
    ({ needs_review: 5, disputed: 5, dispatched: 4, claimed: 4, submitted: 4, verified: 3, paid: 2 })[
      t.status
    ] ?? 1;
  // The map's tasks follow the Tasks tab's filters (status, dates); no dates means the last 24 h.
  // Open and attention tasks always show, whatever their age.
  async function loadMapTasks(refit: boolean) {
    const st = tasks.state();
    const query = new URLSearchParams(
      [["status", st.f.status ?? ""], ...datedQuery(st.f, "", new Date())].filter(([, v]) => v),
    );
    const res = await fetch(`/map/tasks?${query}`, { cache: "no-store" });
    if (!res.ok) return;
    mapTasks = ((await res.json()) as { tasks: Task[] }).tasks;
    const window = st.f.when || st.f.date_min || st.f.date_max ? "the Tasks tab's dates" : "the last 24 h";
    $("map-scope").textContent =
      `${mapTasks.length} task${mapTasks.length === 1 ? "" : "s"}: ${st.f.status ? `${statusLabel(st.f.status).toLowerCase()}, ` : ""}${window} and every open one`;
    if (refit) fitted = false;
    renderMap(workers.visible());
  }
  // Several tasks at one spot: pick one.
  function openSpot(ts: Task[]) {
    const panel = $<HTMLDialogElement>("review-panel");
    const close = h("button", "ui-button ui-button--ghost ui-button--sm", "Close");
    close.type = "button";
    close.addEventListener("click", () => panel.close());
    panel.replaceChildren(
      h(
        "div",
        "task-head",
        h("h2", "ui-card__title", `${ts.length} tasks at ${cut(nearLabel(ts[0]?.place_label), 60)}`),
        close,
      ),
      h(
        "ul",
        "spot",
        ...ts.map((t) => {
          const b = h(
            "button",
            "spot__task",
            badge(statusLabel(t.status), STATUS_TONE[t.status]),
            " ",
            cut(t.question, 100),
            h("span", "tiny", ` ${ago(t.created_at, Date.now())} ago`),
          );
          b.type = "button";
          b.addEventListener("click", () => openReview(t.id, t));
          return h("li", null, b);
        }),
      ),
    );
    panel.showModal();
  }
  /** The worker shown in the panel (full id), kept in the hash as `w=<8 chars>`. */
  let selected: string | null = null;
  let wanted: string | null = null;
  function renderMap(all: Worker[]) {
    // STOP deletes a worker's location
    const workers = all.filter((w): w is Worker & { lat: number; lng: number } => located(w) && !w.test);
    const L = win.L;
    if (!L) {
      $("map").classList.add("nomap");
      $("map").textContent = "Map needs Leaflet from unpkg.com.";
      return;
    }
    if (!map || !layer) {
      map = L.map("map", { zoomControl: false, attributionControl: true }).setView([37.7749, -122.4194], 13);
      // Street tiles, greyed (and inverted in dark mode) by CSS so the pins carry the color.
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        // The page is Referrer-Policy same-origin; OSM blocks tile requests with no Referer.
        referrerPolicy: "strict-origin-when-cross-origin",
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
      layer = L.layerGroup().addTo(map);
    }
    layer.clearLayers();
    // Tasks at the same spot share one pin: the most urgent status colors it, the size counts them,
    // and urgent pins draw last (on top). Clicking opens the task, or a list when there are several.
    const spots = new Map<string, Task[]>();
    for (const t of mapTasks) {
      if (!located(t)) continue;
      const key = `${(t.lat as number).toFixed(5)},${(t.lng as number).toFixed(5)}`;
      spots.set(key, [...(spots.get(key) ?? []), t]);
    }
    const groups = [...spots.values()].map((ts) => ts.toSorted((a, b) => URGENCY(b) - URGENCY(a)));
    for (const ts of groups.toSorted((a, b) => URGENCY(a[0] as Task) - URGENCY(b[0] as Task))) {
      const t = ts[0] as Task;
      const big = URGENCY(t) >= 4;
      const counts = new Map<string, number>();
      for (const x of ts) counts.set(x.status, (counts.get(x.status) ?? 0) + 1);
      const what = [...counts]
        .map(([st, n]) => `${statusLabel(st).toLowerCase()}${n > 1 ? ` ×${n}` : ""}`)
        .join(", ");
      L.circleMarker([t.lat as number, t.lng as number], {
        radius: (big ? 9 : 6) + Math.min(ts.length - 1, 4),
        weight: 2,
        className: `pin s-${t.status}${big ? " is-live" : ""}`,
      })
        .bindTooltip(
          ts.length === 1
            ? `${statusLabel(t.status)}: ${cut(nearLabel(t.place_label), 60)}`
            : `${ts.length} tasks at ${cut(nearLabel(t.place_label), 50)}: ${what}`,
          { direction: "top" },
        )
        .on("click", () => (ts.length === 1 ? openReview(t.id, t) : openSpot(ts)))
        .addTo(layer);
    }
    for (const w of workers) {
      const on = w.available && w.opted_in;
      const marker = L.circleMarker([w.lat, w.lng], {
        radius: w.id === selected ? 11 : 7,
        weight: w.id === selected ? 4 : 2,
        className: `wk ${on ? "is-on" : "is-off"}${w.id === selected ? " is-selected" : ""}`,
      });
      marker
        .bindTooltip(`worker ${w.id.slice(0, 8)}, ${RANK[rank(w)]}`, { direction: "top" })
        .on("click", () => openWorker(w.id))
        .addTo(layer);
    }
    // City zoom around every task pin and worker, so nothing starts off screen.
    const points = [...groups.map((ts) => ts[0] as Task), ...workers].map(
      (p) => [p.lat as number, p.lng as number] as [number, number],
    );
    if (!fitted && points.length) {
      map.fitBounds(L.latLngBounds(points).pad(0.2), { maxZoom: 15 });
      fitted = true;
    }
  }

  // The latest task, told the way the live map did: one headline and its timeline.
  function steps(t: Timed, mini = false) {
    const all = taskSteps(t);
    const next = LIVE.includes(t.status) ? all.find((x) => !x.done) : undefined;
    return h(
      "ol",
      mini ? "steps steps--mini" : "steps",
      ...all.map((x) =>
        h(
          "li",
          `step t-${x.tone}${x.done ? " is-done" : ""}${x === next ? " is-next" : ""}`,
          h("b", null, x.label),
          h("time", null, x.done && x.at ? time(x.at) : ""),
        ),
      ),
    );
  }
  function renderStory(tasks: Task[]) {
    const t = tasks.find((x) => LIVE.includes(x.status)) ?? tasks[0];
    $("story").replaceChildren(
      ...(t
        ? [
            h("p", "story__head", badge(statusLabel(t.status), STATUS_TONE[t.status]), " ", taskHeadline(t)),
            h("p", "story__q muted", cut(t.question, 140)),
            steps(t),
          ]
        : [h("p", "muted", "No tasks yet. When an agent asks about a place, its story shows here.")]),
    );
  }

  // A link with #workers?w=<8 chars> opens that worker, once the feed has the workers.
  function openWanted() {
    const want = wanted && workers.visible().find((x) => x.id.startsWith(wanted as string));
    if (!want) return;
    wanted = null;
    void openWorker(want.id);
  }
  const workerHash = () => (selected ? `w=${selected.slice(0, 8)}` : "");
  function selectWorker(id: string | null) {
    selected = id;
    history.replaceState(null, "", hashOf("workers", workers.state()));
    renderMap(workers.visible());
  }
  // One worker in the side panel: state, last fix, earnings, the latest photo and their tasks.
  async function openWorker(id: string) {
    const panel = $<HTMLDialogElement>("review-panel");
    const close = h("button", "ui-button ui-button--ghost ui-button--sm", "Close");
    close.type = "button";
    close.addEventListener("click", () => panel.close());
    selectWorker(id);
    const res = await fetch(`/workers/${id}`, { cache: "no-store" });
    const d = await json<WorkerDetail & Reply>(res);
    panel.dataset.worker = id;
    if (res.ok) showWorker(d, close);
    else panel.replaceChildren(h("p", null, `Could not load the worker: ${d.message ?? res.status}`), close);
    if (!panel.open) panel.showModal();
  }
  function showWorker(d: WorkerDetail, close: HTMLElement) {
    const w = d.worker;
    const state = w.banned ? "banned" : (RANK[rank(w)] as string);
    const e = d.earnings;
    // Each task shows its own photo; a photo seen on an earlier task here gets a warning chip.
    const firstWith = new Map<string, string>();
    for (const t of d.tasks.toReversed()) {
      const hash = photoHash(t.photo_url);
      if (hash && !firstWith.has(hash)) firstWith.set(hash, t.id);
    }
    $("review-panel").replaceChildren(
      ...[
        h(
          "div",
          "task-head",
          h("h2", "ui-card__title", `Worker ${w.id.slice(0, 8)}`),
          h(
            "span",
            null,
            badge(state, w.banned ? "danger" : rank(w) === 2 ? "success" : ""),
            w.test ? badge("test") : null,
          ),
          close,
        ),
        h(
          "div",
          "line",
          h(
            "span",
            null,
            w.lat == null
              ? "No location (texted STOP or never shared)"
              : `Last spot ${ago(w.location_at, Date.now())} ago${w.location_source ? ` (${w.location_source})` : ""}, near ${w.lat.toFixed(3)}, ${w.lng?.toFixed(3)}`,
          ),
          h(
            "span",
            null,
            "earned ",
            h("strong", null, usd(e.paid_cents)),
            ` in ${e.payouts ?? 0} payout${e.payouts === 1 ? "" : "s"}`,
            e.last_paid_at ? `, last ${stamp(e.last_paid_at)}` : "",
            e.released_cents && e.released_cents !== e.paid_cents
              ? `, ${usd(e.released_cents)} released`
              : "",
          ),
        ),
        h("h3", "panel__sub", d.tasks.length ? `Last ${d.tasks.length} tasks` : "No tasks yet"),
        h(
          "ul",
          "wtasks",
          ...d.tasks.map((t) => {
            const same = firstWith.get(photoHash(t.photo_url) ?? "");
            return h(
              "li",
              null,
              h(
                "p",
                "wtasks__head",
                badge(statusLabel(t.status), STATUS_TONE[t.status]),
                t.test ? badge("test run") : null,
                " ",
                cut(t.question, 120),
              ),
              t.photo_url ? thumb(t.photo_url) : null,
              checks(t),
              same && same !== t.id ? badge(`same photo as task ${same.slice(0, 8)}`, "warning") : null,
              h(
                "p",
                "tiny",
                `${cut(nearLabel(t.place_label), 70)} · ${usd(t.bounty_cents)} · ${stamp(t.created_at)}`,
              ),
              steps(t, true),
            );
          }),
        ),
        h("span", "tiny", w.id),
      ].filter((x) => x != null),
    );
  }
  // Esc or Close: the worker is no longer selected.
  $("review-panel").addEventListener("close", () => {
    const panel = $("review-panel");
    if (!panel.dataset.worker) return;
    delete panel.dataset.worker;
    selectWorker(null);
  });

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
    renderStory(feed.tasks);
    openWanted();
    // The list tabs refresh with the feed while they are shown.
    const tab = tabFor(location.hash);
    if (tab === "tasks") taskPager.load();
    if (tab === "workers") void loadMapTasks(false);
    if (tab === "money") ledgerPager.load();
  }

  // Classifier and dispute decisions send only a note; task support also sends the task id.
  const decideTicket =
    (t: Ticket, action: string) =>
    async (note: string): Promise<Outcome> => {
      const res = await fetch(`/tickets/${t.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          t.kind === "dispute" || t.kind === "classifier_feedback" ? { note } : { task_id: t.task_id, note },
        ),
      });
      const body = await json<Reply>(res);
      if (!res.ok) return { ok: false, message: `Failed: ${body.message || body.error || res.status}` };
      loadTickets();
      countOpenTickets();
      if (t.kind === "classifier_feedback")
        return {
          ok: true,
          message: `${body.already_resolved ? "Already" : "Decision saved:"} ${body.status}. ${
            body.status === "approved"
              ? "Only the same agent may explicitly retry this exact request within 24 hours."
              : "No new retry authorization."
          } No task dispatched, charge made or worker messaged.`,
        };
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
    if (t.kind === "classifier_feedback")
      return actionArea(document, {
        id: `ticket-${t.id}`,
        primary: {
          label: "Approve",
          confirm:
            "Allow the same agent to explicitly retry this exact request within 24 hours? This does not dispatch a task or charge.",
          verb: "Approve retry",
          tone: "primary",
          run: decideTicket(t, "approve_classifier"),
        },
        more: [
          {
            label: "Reject",
            confirm:
              "Keep this request blocked? Your note, or “Classifier block upheld by operator.”, is saved as the rejection reason.",
            verb: "Reject report",
            tone: "danger",
            run: (note) =>
              decideTicket(t, "reject_classifier")(note || "Classifier block upheld by operator."),
          },
        ],
        inlineMore: true,
        note: {
          label: "Decision note (optional)",
          hint: "Kept with this review; not sent to a worker. If rejected without a note: “Classifier block upheld by operator.”",
          required: false,
        },
        toast,
      });
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
    t.kind === "classifier_feedback"
      ? t.classifier_status || (ticketOpen(t) ? "open" : "resolved")
      : t.kind === "dispute"
        ? t.dispute_status || "open"
        : ticketOpen(t)
          ? "open"
          : "resolved";
  const stateTone = (state: string) =>
    state === "open" ? "danger" : state === "upheld" ? "warning" : "success";
  function openTicket(t: Ticket) {
    const panel = $<HTMLDialogElement>("review-panel");
    const close = h("button", "ui-button ui-button--ghost ui-button--sm", "Close");
    close.type = "button";
    close.addEventListener("click", () => panel.close());
    const dispute = t.kind === "dispute";
    const state = ticketState(t);
    if (t.kind === "classifier_feedback") {
      const context = h(
        "details",
        "classifier-review__details",
        h("summary", null, "Client-reported classifier decision and reason (untrusted)"),
        h("pre", "msg", JSON.stringify(t.reported_context ?? null, null, 2)),
      );
      context.open = true;
      panel.replaceChildren(
        h(
          "div",
          "task-head",
          h("h2", "ui-card__title", `Classifier review #${t.id}`),
          badge(state === "open" ? "Pending review" : state, stateTone(state)),
          close,
        ),
        h("h3", "tiny", "Original question"),
        h("p", "q classifier-review__text", t.question || "(not supplied)"),
        h("h3", "tiny", "Original place"),
        h("p", "classifier-review__text", t.place_label || JSON.stringify(t.request?.location ?? null)),
        h("p", "muted classifier-review__text", `Agent: ${t.agent_id || "(not supplied)"}`),
        context,
        h("p", "msg classifier-review__text", t.message || "(no report message)"),
        h(
          "details",
          "classifier-review__details",
          h("summary", null, "Exact request and server fingerprint"),
          h("pre", "msg", JSON.stringify(t.request ?? null, null, 2)),
          h("p", "tiny classifier-review__text", t.request_fingerprint || "(not supplied)"),
        ),
        h(
          "p",
          "muted",
          "Approval only unlocks the same exact request for the same agent to retry explicitly within 24 hours. No task is dispatched, no charge is made and no worker is messaged.",
        ),
        h("p", "tiny", `Opened ${stamp(t.created_at)}`),
        ...(state === "open" && ticketOpen(t)
          ? [ticketActions(t)]
          : [
              h(
                "p",
                "muted",
                `Decision: ${state}. ${t.decision_by || ""} ${stamp(t.decision_at || t.resolved_at)}`,
              ),
              ...(t.note ? [h("p", "msg classifier-review__text", `Decision reason: ${t.note}`)] : []),
              ...(t.approval_expires_at
                ? [h("p", "muted", `Approval expires ${stamp(t.approval_expires_at)}`)]
                : []),
            ]),
      );
      if (!panel.open) panel.showModal();
      return;
    }
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
      await Promise.all([loadTickets(), countOpenTickets(), pollEvents(), loadSeries(), loadIssues()]);
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
  // The Workers tab also keeps the selected worker in its hash.
  const hashOf = (tab: string, state: TableState) => {
    const hash = hashFor(tab, state);
    const extra = tab === "workers" ? workerHash() : "";
    return extra ? `${hash}${hash.includes("?") ? "&" : "?"}${extra}` : hash;
  };
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
        if (tabFor(location.hash) === tab) history.replaceState(null, "", hashOf(tab, state));
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
      history.replaceState(null, "", hashOf(tab, state));
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
    empty: "No tickets. Workers can request help; agents can report a classifier decision for review.",
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
      {
        key: "kind",
        label: "Kind",
        text: (t) =>
          t.kind === "classifier_feedback" ? "Classifier review" : t.kind === "dispute" ? "Dispute" : "Help",
      },
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
          ["classifier_feedback", "Classifier review"],
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
    key: (w) => w.id,
    label: (w) => `Worker ${w.id.slice(0, 8)}, ${RANK[rank(w)]}`,
    open: (w) => openWorker(w.id),
    columns: [
      { key: "worker", label: "Worker", text: (w) => `worker ${w.id.slice(0, 8)}` },
      {
        key: "state",
        label: "State",
        desc: true,
        text: (w) => RANK[rank(w)] as string,
        sort: rank,
        cell: (w) =>
          h(
            "span",
            null,
            badge(RANK[rank(w)] as string, rank(w) === 2 ? "success" : ""),
            w.test ? badge("test") : null,
          ),
      },
      {
        key: "location",
        label: "Location",
        text: (w) => (!located(w) ? "no location" : w.test ? "test, not mapped" : "on the map"),
      },
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
        value: (w) => (located(w) && !w.test ? "on the map" : "no location"),
      },
    ],
  });
  $("workers").replaceChildren(workers.el);

  const toast = createToaster(document, later);

  // Errors: console errors grouped into issues (fingerprinted on the server, kept in Postgres).
  let issueRows: Issue[] = [];
  const affectedText = (a: Issue["affected"]) =>
    [
      a.workers ? `${a.workers} worker${a.workers === 1 ? "" : "s"}` : "",
      a.agents ? `${a.agents} agent${a.agents === 1 ? "" : "s"}` : "",
      a.tasks ? `${a.tasks} task${a.tasks === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(", ");
  const issueState = (i: Issue) =>
    i.status === "ignored" && i.ignore_until != null ? `ignored until ${i.ignore_until}` : i.status;
  function spark(values: number[]) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "spark");
    svg.setAttribute("viewBox", "0 0 48 12");
    svg.setAttribute("aria-hidden", "true");
    const top = Math.max(1, ...values);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", values.map((v, i) => `${i * 2},${12 - (v / top) * 11}`).join(" "));
    svg.append(line);
    return svg;
  }
  const issues = tableFor<Issue>("errors", {
    name: "issues",
    empty: "No errors or warnings recorded. Console errors on the server show up here, grouped.",
    initial: { q: "", sort: "-last", f: { status: "unresolved" } },
    key: (i) => i.fingerprint,
    label: (i) => `${levelOf(i.level)[0]}: ${cut(i.title, 80)}, ${i.count} events`,
    open: (i) => openIssue(i),
    columns: [
      {
        key: "level",
        label: "Level",
        text: (i) => levelOf(i.level)[0],
        cell: (i) => badgeIcon(document, levelOf(i.level), `ev-level ev-level--${i.level}`),
      },
      {
        key: "issue",
        label: "Issue",
        text: (i) => `${i.title} ${i.culprit ?? ""}`,
        cell: (i) =>
          h("span", "issue", h("b", null, cut(i.title, 140)), h("code", "tiny", i.culprit ?? "no stack")),
      },
      {
        key: "count",
        label: "Events",
        num: true,
        desc: true,
        text: (i) => String(i.count),
        sort: (i) => i.count,
      },
      { key: "affected", label: "Affected", text: (i) => affectedText(i.affected) },
      {
        key: "last",
        label: "Last seen",
        num: true,
        desc: true,
        text: (i) => ago(i.last_seen, Date.now()),
        sort: (i) => Date.parse(i.last_seen),
      },
      {
        key: "first",
        label: "First seen",
        num: true,
        desc: true,
        text: (i) => ago(i.first_seen, Date.now()),
        sort: (i) => Date.parse(i.first_seen),
      },
      { key: "spark", label: "24 h", text: (i) => String(sum(i.spark)), cell: (i) => spark(i.spark) },
      {
        key: "status",
        label: "Status",
        text: issueState,
        cell: (i) =>
          h(
            "span",
            null,
            badge(issueState(i), i.status === "unresolved" ? "danger" : ""),
            i.regressed ? badge("regressed", "warning") : null,
          ),
      },
    ],
    filters: [
      {
        kind: "select",
        key: "status",
        label: "Statuses",
        options: [
          ["unresolved", "Unresolved"],
          ["resolved", "Resolved"],
          ["ignored", "Ignored"],
        ],
        value: (i) => i.status,
      },
      {
        kind: "select",
        key: "level",
        label: "Levels",
        options: [
          ["error", "Error"],
          ["warn", "Warning"],
        ],
        value: (i) => i.level,
      },
    ],
  });
  $("issues").replaceChildren(issues.el);
  async function loadIssues() {
    const res = await fetch("/issues", { cache: "no-store" });
    if (!res.ok) return;
    issueRows = ((await res.json()) as { issues: Issue[] }).issues;
    issues.setRows(issueRows);
    const open = issueRows.filter((i) => i.status === "unresolved");
    count(
      "n-errors",
      open.length,
      open.some((i) => i.level === "error"),
    );
  }
  // One issue: message, stack with our frames marked, tags, latest occurrences, a link into Logs, status.
  async function openIssue(i: Issue) {
    const panel = $<HTMLDialogElement>("review-panel");
    const close = h("button", "ui-button ui-button--ghost ui-button--sm", "Close");
    close.type = "button";
    close.addEventListener("click", () => panel.close());
    const res = await fetch(`/issues/${i.fingerprint}`, { cache: "no-store" });
    const occurrences = res.ok ? ((await res.json()) as { events: IssueEvent[] }).events : [];
    const tags = Object.entries(occurrences[0]?.tags ?? {}).map(([k, v]) =>
      badge(`${k}: ${/_id$/.test(k) ? `${v.slice(0, 8)}…` : v}`),
    );
    const firstLine = i.message.split("\n")[0] ?? "";
    const logs = h("a", "ui-link", "Show in Logs");
    logs.href = hashFor("logs", { q: firstLine.slice(0, 60), sort: "", f: { kind: "log", level: i.level } });
    logs.addEventListener("click", () => panel.close());
    const setStatus = (status: Issue["status"], more: number | undefined, label: string) => {
      const b = h(
        "button",
        `ui-button ui-button--sm ${status === "resolved" ? "ui-button--primary" : "ui-button--ghost"}`,
        label,
      );
      b.type = "button";
      b.addEventListener("click", async () => {
        b.disabled = true;
        const r = await fetch(`/issues/${i.fingerprint}/status`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status, more }),
        });
        const body = await json<{ issue?: Issue } & Reply>(r);
        if (!r.ok || !body.issue) {
          b.disabled = false;
          toast(`Not changed: ${body.message ?? r.status}`);
          return;
        }
        toast(`Issue ${label.toLowerCase()}`);
        await loadIssues();
        void openIssue({ ...i, ...body.issue });
      });
      return b;
    };
    panel.replaceChildren(
      ...[
        h(
          "div",
          "task-head",
          h("h2", "ui-card__title", cut(i.title, 200)),
          h(
            "span",
            null,
            badge(issueState(i), i.status === "unresolved" ? "danger" : ""),
            i.regressed ? badge("regressed", "warning") : null,
          ),
          close,
        ),
        h(
          "div",
          "line",
          badgeIcon(document, levelOf(i.level), `ev-level ev-level--${i.level}`),
          h("code", null, i.culprit ?? "no stack"),
          h("span", null, `${i.count} events, first ${stamp(i.first_seen)}, last ${stamp(i.last_seen)}`),
          affectedText(i.affected) ? h("span", null, affectedText(i.affected)) : null,
        ),
        h(
          "div",
          "decide__row",
          ...(i.status === "unresolved"
            ? [
                setStatus("resolved", undefined, "Resolve"),
                setStatus("ignored", 10, "Ignore until 10 more"),
                setStatus("ignored", 100, "Ignore until 100 more"),
                setStatus("ignored", undefined, "Ignore forever"),
              ]
            : [setStatus("unresolved", undefined, "Reopen")]),
        ),
        h("pre", "err", i.message),
        i.stack
          ? h(
              "pre",
              "stack",
              ...i.stack
                .split("\n")
                .map((line) =>
                  h(
                    "span",
                    /(apps|packages)\//.test(line) && !line.includes("node_modules") ? "in-app" : null,
                    `${line}\n`,
                  ),
                ),
            )
          : null,
        tags.length ? h("p", "tags", ...tags) : null,
        h(
          "h3",
          "panel__sub",
          occurrences.length ? `Latest ${occurrences.length}` : "No occurrences kept (older than 14 days)",
        ),
        h(
          "ul",
          "occurrences",
          ...occurrences.map((o) =>
            h("li", null, h("span", "tiny", stamp(o.at)), " ", cut(o.message.split("\n")[0], 160)),
          ),
        ),
        h("p", null, logs),
        h("span", "tiny", i.fingerprint),
      ].filter((x) => x != null),
    );
    if (!panel.open) panel.showModal();
  }

  // Access: who can sign in to ops. The JSON routes the old /allowlist page used (same CSRF/Origin checks).
  type AccessEntry = {
    id: string;
    kind: string;
    value: string;
    added_by: string;
    added_at: string;
    self?: boolean;
    invite_status?: "sent" | "copy" | "failed" | null;
    invite_at?: string | null;
    invites_left?: number;
  };
  let loginUrl = "";
  const INVITE_TEXT = { sent: "Invite sent", failed: "Invite failed", copy: "" };
  // The invite line under a row: what happened last, a copy button when email was refused, and Resend.
  function inviteLine(e: AccessEntry) {
    const line = h("span", "access__invite tiny");
    if (e.invite_status === "copy") {
      const copy = h("button", "ui-button ui-button--ghost ui-button--sm", "Copy link");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        await win.navigator.clipboard?.writeText(loginUrl);
        toast("Sign-in link copied");
      });
      line.append(h("span", "access__warn", "Couldn't email them: send them this link yourself"), " ", copy);
    } else if (e.invite_status)
      line.append(
        h(
          "span",
          e.invite_status === "failed" ? "access__warn" : null,
          `${INVITE_TEXT[e.invite_status]}${e.invite_at ? ` ${ago(e.invite_at, Date.now())} ago` : ""}`,
        ),
      );
    else line.append(h("span", null, "No invite sent"));
    const resend = h("button", "ui-button ui-button--ghost ui-button--sm", "Resend invite");
    resend.type = "button";
    resend.disabled = e.invites_left === 0;
    if (resend.disabled) resend.title = "3 invites a day; try tomorrow";
    resend.addEventListener("click", async () => {
      resend.disabled = true;
      const res = await post("/allowlist/invite", { id: e.id });
      const body = await json<{ entry?: AccessEntry } & Reply>(res);
      if (!res.ok || !body.entry) {
        resend.disabled = false;
        toast(`Not sent: ${body.message ?? res.status}`);
        return;
      }
      toast(
        body.entry.invite_status === "sent"
          ? "Invite sent"
          : body.entry.invite_status === "copy"
            ? "Couldn't email them: copy the link"
            : "Invite failed",
      );
      await loadAccess();
    });
    line.append(" ", resend);
    return line;
  }
  const post = (path: string, body: object) =>
    fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  function accessRow(e: AccessEntry) {
    const li = h(
      "li",
      "access__row",
      h(
        "span",
        "access__who",
        h("strong", null, e.value),
        " ",
        badge(e.kind),
        e.self ? badge("you", "success") : null,
        h("span", "tiny", ` added by ${e.added_by} on ${e.added_at.slice(0, 10)}`),
      ),
    );
    if (!e.self) li.append(inviteLine(e));
    if (e.self) {
      li.append(h("span", "tiny muted", "You cannot remove yourself"));
      return li;
    }
    const remove = h("button", "ui-button ui-button--ghost ui-button--sm", "Remove");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${e.value}`);
    // Inline confirm: the row asks once, Cancel or Escape puts the button back.
    remove.addEventListener("click", () => {
      const yes = h("button", "ui-button ui-button--danger ui-button--sm", "Remove");
      const no = h("button", "ui-button ui-button--ghost ui-button--sm", "Cancel");
      yes.type = "button";
      no.type = "button";
      const ask = h(
        "span",
        "decide__row is-confirming",
        h("span", null, `Remove ${e.value}? They can no longer sign in.`),
        yes,
        no,
      );
      const back = () => {
        ask.replaceWith(remove);
        remove.focus();
      };
      no.addEventListener("click", back);
      ask.addEventListener("keydown", (k) => k.key === "Escape" && back());
      yes.addEventListener("click", async () => {
        yes.disabled = true;
        const res = await post("/allowlist/remove", { id: e.id });
        const body = await json<Reply>(res);
        if (!res.ok) {
          yes.disabled = false;
          toast(`Not removed: ${body.message ?? res.status}`);
          return;
        }
        toast(`Removed ${e.value}`);
        await loadAccess();
      });
      remove.replaceWith(ask);
      no.focus();
    });
    li.append(remove);
    return li;
  }
  async function loadAccess() {
    const res = await fetch("/allowlist", { cache: "no-store", headers: { accept: "application/json" } });
    const body = await json<{ entries?: AccessEntry[]; login_url?: string } & Reply>(res);
    loginUrl = body.login_url ?? loginUrl;
    const list = $("access-list");
    if (!res.ok || !body.entries) {
      list.replaceChildren(empty(`Could not load the list: ${body.message ?? res.status}`));
      return;
    }
    list.replaceChildren(...(body.entries.length ? body.entries.map(accessRow) : [empty("Nobody yet.")]));
  }
  $<HTMLFormElement>("access-add").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const input = $<HTMLInputElement>("access-identifier");
    const error = $("access-error");
    const res = await post("/allowlist", { identifier: input.value });
    const body = await json<{ entry?: AccessEntry } & Reply>(res);
    if (!res.ok) {
      error.textContent = body.message ?? `Failed: ${res.status}`;
      input.setAttribute("aria-invalid", "true");
      return;
    }
    error.textContent = "";
    input.removeAttribute("aria-invalid");
    input.value = "";
    const sent = body.entry?.invite_status;
    toast(
      sent === "sent"
        ? "Added and invited. They sign in with a code."
        : sent === "copy"
          ? "Added. Couldn't email them: copy the link from their row."
          : "Added. The invite did not go out: resend it from their row.",
    );
    await loadAccess();
  });

  function showTab() {
    const name = tabFor(location.hash);
    const params = parseHash(location.hash).params;
    if (name === "workers" && params.get("w") && params.get("w") !== selected?.slice(0, 8))
      wanted = params.get("w");
    restore[name]?.(params);
    openWanted();
    for (const t of TABS) {
      $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
      $(`tab-${t}`).tabIndex = t === name ? 0 : -1;
      $(`p-${t}`).hidden = t !== name;
    }
    $(`tab-${name}`).scrollIntoView({ block: "nearest", inline: "nearest" });
    if (name === "tasks") taskPager.load();
    if (name === "money") ledgerPager.load();
    if (name === "access") void loadAccess();
    // Leaflet measured a hidden box; size it again and refit.
    if (name === "workers") {
      map?.invalidateSize();
      void loadMapTasks(true);
    }
  }
  $("tabs").addEventListener("keydown", (e) => {
    const t = nextTab(document.activeElement?.id ?? "", e.key);
    if (!t) return;
    e.preventDefault();
    $(`tab-${t}`).focus();
    history.replaceState(null, "", remembered[t] ? hashOf(t, remembered[t]) : `#${t}`);
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
  return Promise.all([loadSafety(), poll()]);
}
