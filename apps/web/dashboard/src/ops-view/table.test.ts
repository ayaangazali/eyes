import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTable,
  type Column,
  createTable,
  type Filter,
  hashFor,
  nextSort,
  parseHash,
  stateFrom,
  type TableState,
} from "./table.ts";

type Row = { id: number; name: string; status: string; cents: number | null; at: string };
const ROWS: Row[] = [
  { id: 1, name: "Blue Bottle line", status: "open", cents: 300, at: "2026-10-15T12:00:00" },
  { id: 2, name: "Dolores gate", status: "closed", cents: 500, at: "2026-10-16T09:00:00" },
  { id: 3, name: "blue door photo", status: "open", cents: null, at: "2026-10-17T23:30:00" },
];
const COLUMNS: Column<Row>[] = [
  { key: "name", label: "Name", text: (r) => r.name },
  { key: "status", label: "Status", text: (r) => r.status, cell: (r) => `[${r.status}]` },
  {
    key: "cents",
    label: "Bounty",
    num: true,
    desc: true,
    text: (r) => String(r.cents ?? "-"),
    sort: (r) => r.cents ?? 0,
  },
];
const FILTERS: Filter<Row>[] = [
  {
    kind: "select",
    key: "status",
    label: "Statuses",
    options: [
      ["open", "open"],
      ["closed", "closed"],
    ],
    value: (r) => r.status,
  },
  { kind: "range", key: "at", label: "Created", unit: "date", value: (r) => Date.parse(r.at) },
  { kind: "range", key: "cents", label: "Bounty", unit: "usd", value: (r) => r.cents },
];
const state = (over: Partial<TableState> = {}): TableState => ({ q: "", sort: "", f: {}, ...over });
const ids = (rows: Row[]) => rows.map((r) => r.id);
// Events from the element's own window, so happy-dom accepts them.
const emit = (el: Element | undefined, type: string) => {
  const view = el?.ownerDocument.defaultView as unknown as typeof globalThis;
  el?.dispatchEvent(new view.Event(type));
};

describe("table state", () => {
  it("reads the tab and its params from the hash, and writes them back without empties", () => {
    const { tab, params } = parseHash("#review?q=blue&sort=-cents&status=open&at_min=2026-10-16&junk=1");
    expect(tab).toBe("review");
    const s = stateFrom(params, FILTERS);
    expect(s).toEqual({ q: "blue", sort: "-cents", f: { status: "open", at_min: "2026-10-16" } });
    expect(hashFor("review", s)).toBe("#review?q=blue&sort=-cents&status=open&at_min=2026-10-16");
    expect(hashFor("review", state({ q: "  ", f: { status: "" } }))).toBe("#review");
    expect(parseHash("")).toEqual({ tab: "", params: new URLSearchParams() });
  });

  it("flips the same column and starts others at their natural direction", () => {
    const [name, , cents] = COLUMNS as [Column<Row>, Column<Row>, Column<Row>];
    expect(nextSort("", name)).toBe("name");
    expect(nextSort("name", name)).toBe("-name");
    expect(nextSort("-name", name)).toBe("name");
    expect(nextSort("name", cents)).toBe("-cents");
  });
});

describe("applyTable", () => {
  it("searches every visible column for all words, case-insensitively", () => {
    expect(ids(applyTable(ROWS, COLUMNS, FILTERS, state({ q: "BLUE" })))).toEqual([1, 3]);
    expect(ids(applyTable(ROWS, COLUMNS, FILTERS, state({ q: "blue open 300" })))).toEqual([1]);
    expect(ids(applyTable(ROWS, COLUMNS, FILTERS, state({ q: "nothing" })))).toEqual([]);
  });

  it("filters by select, whole local days and dollar amounts; a missing value fails an active range", () => {
    const f = (filters: Record<string, string>) =>
      ids(applyTable(ROWS, COLUMNS, FILTERS, state({ f: filters })));
    expect(f({ status: "open" })).toEqual([1, 3]);
    expect(f({ at_min: "2026-10-16" })).toEqual([2, 3]);
    expect(f({ at_max: "2026-10-16" })).toEqual([1, 2]);
    expect(f({ at_min: "2026-10-16", at_max: "2026-10-16" })).toEqual([2]);
    expect(f({ at_min: "not-a-date" })).toEqual([1, 2, 3]);
    expect(f({ cents_min: "4" })).toEqual([2]);
    expect(f({ cents_max: "3.00" })).toEqual([1]);
    expect(f({ cents_min: "abc" })).toEqual([1, 2]);
  });

  it("sorts numbers numerically and text by locale, either way, keeping ties in order", () => {
    expect(ids(applyTable(ROWS, COLUMNS, FILTERS, state({ sort: "-cents" })))).toEqual([2, 1, 3]);
    expect(ids(applyTable(ROWS, COLUMNS, FILTERS, state({ sort: "cents" })))).toEqual([3, 1, 2]);
    expect(ids(applyTable(ROWS, COLUMNS, FILTERS, state({ sort: "name" })))).toEqual([1, 3, 2]);
    expect(ids(applyTable(ROWS, COLUMNS, FILTERS, state({ sort: "status" })))).toEqual([2, 1, 3]);
    expect(ids(applyTable(ROWS, COLUMNS, FILTERS, state({ sort: "nope" })))).toEqual([1, 2, 3]);
  });
});

describe("createTable", () => {
  const windows: Window[] = [];
  afterEach(async () => {
    for (const w of windows.splice(0)) await w.happyDOM.close();
  });

  function mount(open?: (r: Row) => void) {
    const happy = new Window();
    windows.push(happy);
    const doc = happy.document as unknown as Document;
    const changes: TableState[] = [];
    const timers: (() => void)[] = [];
    let cancelled = 0;
    const table = createTable<Row>(doc, {
      name: "rows",
      columns: COLUMNS,
      filters: FILTERS,
      empty: "No rows yet.",
      label: (r) => `Row ${r.id}`,
      open,
      onChange: (s) => changes.push(s),
      later: (fn) => {
        timers.push(fn);
        return () => cancelled++;
      },
    });
    doc.body.append(table.el);
    const q = <T extends Element>(sel: string) => table.el.querySelector(sel) as unknown as T;
    const all = (sel: string) => [...table.el.querySelectorAll(sel)];
    const fire = (el: Element, type: string, init: object = {}) =>
      el.dispatchEvent(new happy.KeyboardEvent(type, init) as unknown as Event);
    return { table, doc, changes, timers, q, all, fire, cancelled: () => cancelled };
  }

  it("renders rows with labels and custom cells, and an empty message before and after filtering", () => {
    const { table, q, all } = mount();
    expect(q<HTMLTableElement>("table").hidden).toBe(true);
    expect(q("p.tbl-empty")?.textContent).toBe("No rows yet.");
    table.setRows(ROWS);
    expect(all("tbody tr").map((tr) => tr.textContent)).toEqual([
      "Blue Bottle line[open]300",
      "Dolores gate[closed]500",
      "blue door photo[open]-",
    ]);
    expect(all("tbody tr")[0]?.getAttribute("role")).toBeNull();
    expect(all("td")[2]?.className).toBe("num");
    expect(all("td")[2]?.getAttribute("data-label")).toBe("Bounty");
    expect(q(".tbl-count")?.textContent).toBe("3 shown");
    expect(q<HTMLButtonElement>(".tbl-clear").disabled).toBe(true);
    table.setState(state({ q: "zzz" }));
    expect(q("p.tbl-empty")?.textContent).toBe("Nothing matches these filters.");
    expect(q<HTMLParagraphElement>("p.tbl-empty").hidden).toBe(false);
    expect(q(".tbl-count")?.textContent).toBe("0 of 3");
  });

  it("debounces search, sorts from the headers with aria-sort, filters, and clears", () => {
    const { table, q, all, changes, timers, cancelled } = mount();
    table.setRows(ROWS);
    const search = q<HTMLInputElement>(".tbl-search");
    search.value = "blu";
    emit(search, "input");
    search.value = "blue";
    emit(search, "input");
    expect(cancelled()).toBe(1);
    expect(changes).toEqual([]);
    timers.at(-1)?.();
    expect(changes.at(-1)).toEqual(state({ q: "blue" }));
    expect(all("tbody tr")).toHaveLength(2);

    const headers = all("th");
    expect(headers.map((th) => th.getAttribute("aria-sort"))).toEqual(["none", "none", "none"]);
    headers[2]?.querySelector("button")?.click();
    expect(headers[2]?.getAttribute("aria-sort")).toBe("descending");
    expect(all("tbody tr")[0]?.textContent).toContain("Blue Bottle");
    headers[2]?.querySelector("button")?.click();
    expect(headers[2]?.getAttribute("aria-sort")).toBe("ascending");
    expect(changes.at(-1)?.sort).toBe("cents");

    const select = q<HTMLSelectElement>("select");
    expect([...select.options].map((o) => o.textContent)).toEqual(["All statuses", "open", "closed"]);
    select.value = "closed";
    emit(select, "change");
    expect(q(".tbl-count")?.textContent).toBe("0 of 3");
    const [from, to, min] = all(".tbl-range input") as HTMLInputElement[];
    expect([from?.type, to?.getAttribute("aria-label"), min?.type, min?.placeholder]).toEqual([
      "date",
      "Created to",
      "number",
      "min $",
    ]);
    select.value = "";
    emit(select, "change");
    (min as HTMLInputElement).value = "4";
    emit(min, "change");
    expect(changes.at(-1)?.f).toEqual({ status: "", cents_min: "4" });
    expect(q(".tbl-toggle")?.textContent).toBe("Filters (1)");
    expect(q(".tbl-count")?.textContent).toBe("0 of 3");
    q<HTMLButtonElement>(".tbl-clear").click();
    expect(changes.at(-1)).toEqual(state({ sort: "cents" }));
    expect(search.value).toBe("");
    expect((min as HTMLInputElement).value).toBe("");
    expect(q(".tbl-toggle")?.textContent).toBe("Filters");
  });

  it("keeps the search box as typed while it has focus", () => {
    const { table, q } = mount();
    const search = q<HTMLInputElement>(".tbl-search");
    search.focus();
    search.value = "typing";
    table.setState(state({ q: "old" }));
    expect(search.value).toBe("typing");
  });

  it("opens rows by click, Enter and Space, but not other keys", () => {
    const opened: number[] = [];
    const { table, all, fire } = mount((r) => opened.push(r.id));
    table.setRows(ROWS);
    const [first, second] = all("tbody tr") as HTMLElement[];
    expect([first?.getAttribute("role"), first?.tabIndex, first?.getAttribute("aria-label")]).toEqual([
      "button",
      0,
      "Row 1",
    ]);
    first?.click();
    fire(second as Element, "keydown", { key: "Enter", cancelable: true });
    fire(second as Element, "keydown", { key: " ", cancelable: true });
    fire(second as Element, "keydown", { key: "a" });
    expect(opened).toEqual([1, 2, 2]);
  });

  it("folds the filters behind a toggle", () => {
    const { table, q } = mount();
    const toggle = q<HTMLButtonElement>(".tbl-toggle");
    toggle.click();
    expect([table.el.classList.contains("tbl--open"), toggle.getAttribute("aria-expanded")]).toEqual([
      true,
      "true",
    ]);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("exposes its state", () => {
    const { table } = mount();
    table.setState(state({ sort: "-name" }));
    expect(table.state()).toEqual(state({ sort: "-name" }));
  });
});

describe("createTable, server-paged", () => {
  const windows: Window[] = [];
  afterEach(async () => {
    for (const w of windows.splice(0)) await w.happyDOM.close();
  });

  function remote(
    opts: { observer?: boolean; total?: number | null; window?: { rows: number; height: number } } = {},
  ) {
    const happy = new Window();
    windows.push(happy);
    const view = happy as unknown as Window & typeof globalThis;
    const seen: { fire: (hit: boolean) => void }[] = [];
    if (opts.observer) {
      (view as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
        cb: (entries: { isIntersecting: boolean }[]) => void;
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          this.cb = cb;
        }
        observe() {
          seen.push({ fire: (hit) => this.cb([{ isIntersecting: hit }]) });
        }
      };
    } else (view as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
    const doc = happy.document as unknown as Document;
    let more = 0;
    const table = createTable<Row>(doc, {
      name: "rows",
      columns: COLUMNS,
      filters: [...FILTERS, { kind: "text", key: "who", label: "Who", value: (r) => r.name }],
      empty: "No rows.",
      onChange: () => {},
      later: (fn) => {
        fn();
        return () => {};
      },
      remote: {
        noun: "rows",
        more: () => more++,
        total: opts.total === undefined ? undefined : () => opts.total ?? null,
      },
      key: (r) => String(r.id),
      detail: (r) => {
        const p = doc.createElement("p");
        p.textContent = `detail ${r.id}`;
        return p;
      },
      window: opts.window,
    });
    doc.body.append(table.el);
    return { table, doc, happy, seen, more: () => more };
  }

  it("leaves filtering to the server, counts what is loaded, and pages from the footer", () => {
    const { table, seen, more } = remote({ observer: true, total: 9 });
    table.setRows(ROWS);
    table.setState({ q: "zzz", sort: "-cents", f: { status: "closed", who: "nobody" } });
    expect([...table.el.querySelectorAll("tbody tr")].map((tr) => tr.textContent?.slice(0, 5))).toEqual([
      "Dolor",
      "Blue ",
      "blue ",
    ]);
    expect(table.el.querySelector(".tbl-count")?.textContent).toBe("3 of 9 rows loaded");
    const button = table.el.querySelector(".tbl-foot button") as HTMLButtonElement;
    expect(button.hidden).toBe(true);
    table.setEnd("more");
    expect(button.hidden).toBe(false);
    button.click();
    seen[0]?.fire(false);
    seen[0]?.fire(true);
    expect(more()).toBe(2);
    table.setEnd("loading");
    expect(table.el.querySelector(".tbl-end")?.textContent).toBe("Loading…");
    seen[0]?.fire(true);
    button.click();
    expect(more()).toBe(2);
    table.setEnd("end");
    expect(table.el.querySelector(".tbl-end")?.textContent).toBe("End of rows");
    table.setRows([]);
    expect(table.el.querySelector(".tbl-end")?.textContent).toBe("");
  });

  it("works without an IntersectionObserver and without a total", () => {
    const { table, more } = remote();
    table.setRows(ROWS);
    expect(table.el.querySelector(".tbl-count")?.textContent).toBe("3 rows loaded");
    table.setEnd("more");
    (table.el.querySelector(".tbl-foot button") as HTMLButtonElement).click();
    expect(more()).toBe(1);
    const text = table.el.querySelector("input.tbl-filter") as HTMLInputElement;
    expect(text.getAttribute("aria-label")).toBe("Who");
    text.value = " gate ";
    emit(text, "change");
    expect(table.state().f.who).toBe("gate");
  });

  it("toggles details under a row by click and key, keeping them across redraws", () => {
    const { table, happy } = remote();
    table.setRows(ROWS);
    const row = () => table.el.querySelector("tbody tr") as HTMLElement;
    row().click();
    expect(row().getAttribute("aria-expanded")).toBe("true");
    expect(table.el.querySelector(".tbl-detail td")?.textContent).toBe("detail 1");
    expect((table.el.querySelector(".tbl-detail td") as HTMLTableCellElement).colSpan).toBe(3);
    table.setRows([...ROWS]);
    expect(table.el.querySelector(".tbl-detail")).toBeTruthy();
    row().dispatchEvent(
      new happy.KeyboardEvent("keydown", { key: "Enter", cancelable: true }) as unknown as Event,
    );
    expect(table.el.querySelector(".tbl-detail")).toBeNull();
  });

  it("windows long lists: spacers stand in for rows outside the viewport", () => {
    const { table, happy } = remote({ window: { rows: 4, height: 10 } });
    const many = Array.from({ length: 12 }, (_, i) => ({ ...ROWS[0], id: i }) as Row);
    let top = 0;
    const tableEl = table.el.querySelector("table") as HTMLElement;
    tableEl.getBoundingClientRect = () => ({ top }) as DOMRect;
    table.setRows(many);
    const shape = () =>
      [...table.el.querySelectorAll("tbody tr")].map((tr) =>
        tr.className === "tbl-spacer"
          ? `gap ${(tr.firstChild as HTMLElement).style.height}`
          : tr.textContent?.slice(-3),
      );
    expect(shape()).toEqual(["300", "300", "300", "300", "gap 80px"]);
    top = -60;
    happy.dispatchEvent(new happy.Event("scroll"));
    expect(shape()).toEqual(["gap 50px", "300", "300", "300", "300", "gap 30px"]);
    top = -65;
    happy.dispatchEvent(new happy.Event("scroll"));
    expect(shape()[0]).toBe("gap 50px");
    top = -500;
    happy.dispatchEvent(new happy.Event("scroll"));
    expect(shape()).toEqual(["gap 80px", "300", "300", "300", "300"]);
  });

  it("sizes spacers from the measured height of the rows they replace", () => {
    const { table, happy } = remote({ window: { rows: 4, height: 10 } });
    const many = Array.from({ length: 12 }, (_, i) => ({ ...ROWS[0], id: i }) as Row);
    let top = 0;
    (table.el.querySelector("table") as HTMLElement).getBoundingClientRect = () => ({ top }) as DOMRect;
    table.setRows(many);
    // The four drawn rows are really 25 px tall, not the 10 px estimate: the spacer for 8 rows is 200 px.
    for (const tr of table.el.querySelectorAll("tbody tr:not(.tbl-spacer)"))
      (tr as HTMLElement).getBoundingClientRect = () => ({ height: 25 }) as DOMRect;
    top = -250;
    happy.dispatchEvent(new happy.Event("scroll"));
    const gaps = [...table.el.querySelectorAll(".tbl-spacer td")].map(
      (td) => (td as HTMLElement).style.height,
    );
    expect(gaps).toEqual(["200px"]);
  });
});
