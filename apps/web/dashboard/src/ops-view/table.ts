// One table for every ops list: search, sortable headers, filters, a result count and "Clear filters",
// with the state in the URL hash (#review?q=..&sort=-age&status=disputed). server.ts inlines this file.

export type Column<T> = {
  key: string;
  label: string;
  /** The visible text; search matches it, and it is the cell unless `cell` is set. */
  text: (row: T) => string;
  sort?: (row: T) => number | string;
  cell?: (row: T) => Node | string;
  /** Numbers: right-aligned, tabular. */
  num?: boolean;
  /** First click sorts descending (dates, money). */
  desc?: boolean;
};
export type Filter<T> =
  | { kind: "select"; key: string; label: string; options: [string, string][]; value?: (row: T) => string }
  | { kind: "text"; key: string; label: string; value?: (row: T) => string }
  | { kind: "range"; key: string; label: string; unit: "date" | "usd"; value: (row: T) => number | null };
export type TableState = { q: string; sort: string; f: Record<string, string> };

const DAY_MS = 86_400_000;

/** `#review?q=x&sort=-age` → the tab and its params. */
export function parseHash(hash: string) {
  const [tab = "", query = ""] = hash.replace(/^#/, "").split("?");
  return { tab, params: new URLSearchParams(query) };
}

const filterKeys = <T>(filters: Filter<T>[]) =>
  filters.flatMap((f) => (f.kind === "range" ? [`${f.key}_min`, `${f.key}_max`] : [f.key]));

export function stateFrom<T>(params: URLSearchParams, filters: Filter<T>[]): TableState {
  const f: Record<string, string> = {};
  for (const key of filterKeys(filters)) {
    const v = params.get(key);
    if (v) f[key] = v;
  }
  return { q: params.get("q") ?? "", sort: params.get("sort") ?? "", f };
}

export function hashFor(tab: string, state: TableState) {
  const p = new URLSearchParams();
  if (state.q.trim()) p.set("q", state.q.trim());
  if (state.sort) p.set("sort", state.sort);
  for (const [k, v] of Object.entries(state.f)) if (v) p.set(k, v);
  const query = String(p);
  return `#${tab}${query ? `?${query}` : ""}`;
}

// A date filter is a whole local day: from its start to the end of the `max` day.
function bound(unit: "date" | "usd", text: string, end: boolean) {
  if (unit === "usd") return Number.isFinite(Number(text)) ? Math.round(Number(text) * 100) : null;
  const [y, m, d] = text.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).getTime() + (end ? DAY_MS - 1 : 0);
}

export function applyTable<T>(rows: T[], columns: Column<T>[], filters: Filter<T>[], state: TableState) {
  const words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = rows.filter((row) => {
    if (words.length) {
      const hay = columns
        .map((c) => c.text(row))
        .join(" ")
        .toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return filters.every((f) => {
      // A server-paged table has no `value`: the server filtered already.
      if (f.kind === "select") return !state.f[f.key] || !f.value || f.value(row) === state.f[f.key];
      if (f.kind === "text")
        return !state.f[f.key] || !f.value || f.value(row).includes(state.f[f.key] as string);
      const min = state.f[`${f.key}_min`];
      const max = state.f[`${f.key}_max`];
      if (!min && !max) return true;
      const v = f.value(row);
      if (v == null) return false;
      const lo = min ? bound(f.unit, min, false) : null;
      const hi = max ? bound(f.unit, max, true) : null;
      return (lo == null || v >= lo) && (hi == null || v <= hi);
    });
  });
  const desc = state.sort.startsWith("-");
  const column = columns.find((c) => c.key === state.sort.replace(/^-/, ""));
  if (!column) return kept;
  const key = column.sort ?? column.text;
  return kept
    .map((row) => ({ row, k: key(row) }))
    .sort((a, b) => {
      const order =
        typeof a.k === "number" && typeof b.k === "number"
          ? a.k - b.k
          : String(a.k).localeCompare(String(b.k));
      return desc ? -order : order;
    })
    .map(({ row }) => row);
}

/** Next sort after clicking a header: the same column flips, another starts at its natural direction. */
export function nextSort<T>(current: string, column: Column<T>) {
  if (current === column.key) return `-${column.key}`;
  if (current === `-${column.key}`) return column.key;
  return column.desc ? `-${column.key}` : column.key;
}

export type TableOptions<T> = {
  name: string;
  columns: Column<T>[];
  filters: Filter<T>[];
  empty: string;
  /** Row label for screen readers; with `open`, the row is a button. */
  label?: (row: T) => string;
  open?: (row: T) => void;
  onChange: (state: TableState) => void;
  later: (fn: () => void, ms: number) => () => void;
  /**
   * Server-paged: the server filters and searches (the caller refetches on change), the table only
   * sorts what is loaded and shows a footer that loads the next page when it scrolls into view.
   */
  remote?: { noun: string; more: () => void; total?: () => number | null };
  /** Click or Enter on a row shows these details under it (instead of `open`). `key` keeps rows apart. */
  detail?: (row: T) => Node;
  key?: (row: T) => string;
  /** Render at most `rows` rows around the viewport; each row is about `height` px tall. */
  window?: { rows: number; height: number };
};

export function createTable<T>(doc: Document, opts: TableOptions<T>) {
  const { columns, filters } = opts;
  let state: TableState = { q: "", sort: "", f: {} };
  let rows: T[] = [];
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const root = el("div", "tbl");
  const bar = el("div", "tbl-bar");
  const search = el("input", "ui-input tbl-search");
  search.type = "search";
  search.placeholder = `Search ${opts.name}`;
  search.setAttribute("aria-label", `Search ${opts.name}`);
  let cancel = () => {};
  search.addEventListener("input", () => {
    cancel();
    cancel = opts.later(() => update({ ...state, q: search.value }), 200);
  });
  // Phones: the filters fold behind one button so the sticky bar stays one line.
  const toggle = el("button", "ui-button ui-button--ghost ui-button--sm tbl-toggle", "Filters");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.addEventListener("click", () => {
    const open = root.classList.toggle("tbl--open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  bar.append(search, toggle);

  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  for (const f of filters) {
    if (f.kind === "select") {
      const select = el("select", "ui-input tbl-filter");
      select.setAttribute("aria-label", f.label);
      select.append(el("option", undefined, `All ${f.label.toLowerCase()}`));
      (select.firstChild as HTMLOptionElement).value = "";
      for (const [value, text] of f.options) {
        const option = el("option", undefined, text);
        option.value = value;
        select.append(option);
      }
      select.addEventListener("change", () => update({ ...state, f: { ...state.f, [f.key]: select.value } }));
      inputs.set(f.key, select);
      bar.append(select);
      continue;
    }
    if (f.kind === "text") {
      const input = el("input", "ui-input tbl-filter");
      input.type = "search";
      input.placeholder = f.label;
      input.setAttribute("aria-label", f.label);
      input.addEventListener("change", () =>
        update({ ...state, f: { ...state.f, [f.key]: input.value.trim() } }),
      );
      inputs.set(f.key, input);
      bar.append(input);
      continue;
    }
    const group = el("span", "tbl-range");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", f.label);
    group.append(el("span", "tbl-range__label", f.label));
    for (const end of ["min", "max"] as const) {
      const input = el("input", "ui-input");
      const key = `${f.key}_${end}`;
      if (f.unit === "date") input.type = "date";
      else {
        input.type = "number";
        input.min = "0";
        input.step = "0.01";
        input.inputMode = "decimal";
        input.placeholder = end === "min" ? "min $" : "max $";
      }
      input.setAttribute("aria-label", `${f.label} ${end === "min" ? "from" : "to"}`);
      input.addEventListener("change", () => update({ ...state, f: { ...state.f, [key]: input.value } }));
      inputs.set(key, input);
      group.append(input);
    }
    bar.append(group);
  }

  const count = el("span", "tbl-count");
  count.setAttribute("role", "status");
  const clear = el("button", "ui-button ui-button--ghost ui-button--sm tbl-clear", "Clear filters");
  clear.type = "button";
  clear.addEventListener("click", () => update({ q: "", sort: state.sort, f: {} }));
  bar.append(count, clear);

  const table = el("table", "tbl-table");
  const head = el("tr");
  const ths = columns.map((c) => {
    const th = el("th");
    th.scope = "col";
    if (c.num) th.className = "num";
    const button = el("button", "tbl-sort", c.label);
    button.type = "button";
    button.addEventListener("click", () => update({ ...state, sort: nextSort(state.sort, c) }));
    th.append(button);
    head.append(th);
    return th;
  });
  const thead = el("thead");
  thead.append(head);
  const tbody = el("tbody");
  table.append(thead, tbody);
  const empty = el("p", "tbl-empty muted");
  // The footer of a server-paged list: a sentinel that loads the next page, a button as fallback.
  const foot = el("div", "tbl-foot");
  const moreButton = el("button", "ui-button ui-button--ghost ui-button--sm", "Load more");
  moreButton.type = "button";
  const endText = el("span", "tbl-end muted");
  foot.append(moreButton, endText);
  let end: "more" | "loading" | "end" = "end";
  const { remote } = opts;
  if (remote) {
    moreButton.addEventListener("click", () => end === "more" && remote.more());
    const View = doc.defaultView as (Window & typeof globalThis) | null;
    if (View?.IntersectionObserver) {
      new View.IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting) && end === "more") remote.more();
      }).observe(foot);
    }
    root.append(bar, table, empty, foot);
  } else root.append(bar, table, empty);

  const expanded = new Set<string>();
  const keyOf = opts.key ?? ((row: T) => String(rows.indexOf(row)));
  let first = 0;
  const win = opts.window;
  // Measured from the rows on screen once there are some; the estimate until then.
  let rowHeight = win?.height ?? 0;
  // Each drawn row's real height, so a spacer replacing rows is exactly as tall as they were.
  const heights = new Map<string, number>();
  if (win) {
    // Re-render only when the viewport moves a quarter window away from what is drawn.
    doc.defaultView?.addEventListener(
      "scroll",
      () => {
        if (Math.abs(startFor() - first) >= win.rows / 4) draw();
      },
      { passive: true },
    );
  }
  function startFor() {
    if (!win) return 0;
    const top = table.getBoundingClientRect().top;
    return Math.max(0, Math.floor(-top / rowHeight) - Math.floor(win.rows / 4));
  }

  function update(next: TableState) {
    state = next;
    opts.onChange(state);
    draw();
  }

  function draw() {
    if (doc.activeElement !== search) search.value = state.q;
    for (const [key, input] of inputs) input.value = state.f[key] ?? "";
    ths.forEach((th, i) => {
      const key = columns[i]?.key;
      th.setAttribute(
        "aria-sort",
        state.sort === key ? "ascending" : state.sort === `-${key}` ? "descending" : "none",
      );
    });
    const shown = remote
      ? applyTable(rows, columns, [], { ...state, q: "" })
      : applyTable(rows, columns, filters, state);
    const filtered = Boolean(state.q.trim() || Object.values(state.f).some(Boolean));
    const total = remote?.total?.();
    count.textContent = remote
      ? `${rows.length}${total == null ? "" : ` of ${total}`} ${remote.noun} loaded`
      : filtered
        ? `${shown.length} of ${rows.length}`
        : `${rows.length} shown`;
    const active = Object.values(state.f).filter(Boolean).length;
    toggle.textContent = active ? `Filters (${active})` : "Filters";
    clear.disabled = !filtered;
    const drawn = [...tbody.children].filter(
      (tr) => !tr.matches(".tbl-spacer, .tbl-detail"),
    ) as HTMLElement[];
    // Fractional heights: rounding 200 rows to whole pixels would drift the page by tens of pixels.
    const sizes = drawn.map((tr) => tr.getBoundingClientRect().height);
    drawn.forEach((tr, i) => {
      if (sizes[i]) heights.set(tr.dataset.key ?? "", sizes[i] as number);
    });
    const measured = sizes.reduce((sum, h) => sum + h, 0) / (drawn.length || 1);
    if (measured > 0) rowHeight = measured;
    first = win && shown.length > win.rows ? Math.min(startFor(), shown.length - win.rows) : 0;
    const last = win ? Math.min(shown.length, first + win.rows) : shown.length;
    const spacer = (rowsIn: T[]) => {
      const tr = el("tr", "tbl-spacer");
      tr.setAttribute("aria-hidden", "true");
      const td = el("td");
      td.colSpan = columns.length;
      td.style.height = `${rowsIn.reduce((sum, row) => sum + (heights.get(keyOf(row)) ?? rowHeight), 0)}px`;
      tr.append(td);
      return tr;
    };
    tbody.replaceChildren(
      ...(first ? [spacer(shown.slice(0, first))] : []),
      ...shown.slice(first, last).flatMap((row) => {
        const tr = el("tr");
        for (const c of columns) {
          const td = el("td", c.num ? "num" : undefined);
          td.dataset.label = c.label;
          td.append(c.cell ? c.cell(row) : c.text(row));
          tr.append(td);
        }
        const { detail, label } = opts;
        const key = keyOf(row);
        tr.dataset.key = key;
        const isOpen = expanded.has(key);
        const open = detail
          ? () => {
              if (!expanded.delete(key)) expanded.add(key);
              draw();
            }
          : opts.open && (() => opts.open?.(row));
        if (open) {
          tr.className = "open";
          tr.tabIndex = 0;
          tr.setAttribute("role", "button");
          if (detail) tr.setAttribute("aria-expanded", String(isOpen));
          if (label) tr.setAttribute("aria-label", label(row));
          tr.addEventListener("click", open);
          tr.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              open();
            }
          });
        }
        if (!detail || !isOpen) return [tr];
        const more = el("tr", "tbl-detail");
        const td = el("td");
        td.colSpan = columns.length;
        td.append(detail(row));
        more.append(td);
        return [tr, more];
      }),
      ...(last < shown.length ? [spacer(shown.slice(last))] : []),
    );
    moreButton.hidden = end !== "more";
    endText.textContent =
      end === "loading" ? "Loading…" : end === "end" && rows.length ? `End of ${remote?.noun}` : "";
    table.hidden = shown.length === 0;
    empty.hidden = shown.length > 0;
    empty.textContent = rows.length ? "Nothing matches these filters." : opts.empty;
  }

  draw();
  return {
    el: root,
    setRows(next: T[]) {
      rows = next;
      draw();
    },
    setState(next: TableState) {
      state = next;
      draw();
    },
    setEnd(next: "more" | "loading" | "end") {
      end = next;
      draw();
    },
    state: () => state,
    /** The rows the filters and search leave, in the current order. */
    visible: () => applyTable(rows, columns, filters, state),
  };
}
