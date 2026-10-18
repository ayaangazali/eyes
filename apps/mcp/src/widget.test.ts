import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WIDGET_CALLABLE, WIDGET_HTML, WIDGET_SCRIPT } from "./widget.ts";

type Msg = { jsonrpc: "2.0"; id?: number; method?: string; params?: Record<string, unknown> };
type Result = { structuredContent?: unknown; content?: { type: string; text: string }[]; isError?: boolean };
type HostResult = Result | { error: { message: string } };

const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map((win) => win.happyDOM.close()));
  vi.useRealTimers();
});

const QUOTE = {
  workers_nearby: 2,
  est_minutes_to_answer: 8,
  suggested_bounty_usd: 3,
  allowed: true,
  reason_if_not: null,
  resolved_location: { label: "Ferry Building, San Francisco" },
};
const TASK = {
  task_id: "t1",
  status: "dispatched",
  question: "How long is the line?",
  place_label: "Ferry Building",
  answer: null,
  escrowed_usd: 3.5,
  workers_notified: 2,
};
const ANSWER = {
  answer_text: "Ten people",
  answer_bool: null,
  photo_url: null,
  verification: {},
  cost_usd: 3.5,
};

/** Boots the widget script in happy-dom. `openai` stands in for ChatGPT; without it the MCP Apps host answers. */
function boot(
  opts: {
    openai?: Record<string, unknown>;
    host?: (m: Msg) => HostResult | Promise<HostResult>;
    restore?: { name: string; state: string };
    hostCapabilities?: Record<string, unknown>;
    denyStorage?: boolean;
    clock?: boolean;
    initialize?: boolean;
  } = {},
) {
  const happy = new Window({ url: "https://card.test/" });
  windows.push(happy);
  const win = happy as unknown as globalThis.Window & {
    openai?: unknown;
  };
  if (opts.clock) {
    Object.defineProperty(win, "setTimeout", { value: setTimeout });
    Object.defineProperty(win, "clearTimeout", { value: clearTimeout });
  }
  win.document.body.innerHTML = '<main id="root"></main>';
  const sent: Msg[] = [];
  const reply = (data: unknown) =>
    win.dispatchEvent(new happy.MessageEvent("message", { data }) as unknown as Event);
  Object.defineProperty(win, "parent", {
    value: {
      postMessage: (m: Msg) => {
        sent.push(m);
        if (m.id == null || !m.method) return;
        if (m.method === "ui/initialize") {
          if (opts.initialize === false) return;
          return reply({
            jsonrpc: "2.0",
            id: m.id,
            result: {
              hostContext: { theme: "dark" },
              hostCapabilities: opts.hostCapabilities,
            },
          });
        }
        const r = opts.host?.(m) ?? {};
        void Promise.resolve(r).then((result) =>
          reply({ jsonrpc: "2.0", id: m.id, ...("error" in result ? result : { result }) }),
        );
      },
    },
  });
  if (opts.openai) win.openai = opts.openai;
  if (opts.restore) {
    win.name = opts.restore.name;
    win.sessionStorage.setItem(`eyes.card.${win.name}`, opts.restore.state);
  }
  if (opts.denyStorage)
    Object.defineProperty(win, "sessionStorage", {
      get() {
        throw new Error("Storage denied");
      },
    });
  let uuid = 0;
  new Function("window", "document", "ResizeObserver", "crypto", WIDGET_SCRIPT)(
    win,
    win.document,
    class {
      observe() {}
    },
    { randomUUID: () => `key-${++uuid}` },
  );
  const root = win.document.getElementById("root") as HTMLElement;
  const show = (structuredContent: unknown, args: Record<string, unknown> = {}) => {
    reply({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: args } });
    reply({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent } });
  };
  const button = (act: string) => root.querySelector(`[data-act="${act}"]`) as HTMLButtonElement;
  // Hosts reply synchronously here, so a call settles within a few microtask turns: drain them, no clock.
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return { win, root, sent, show, button, settle, reply };
}

describe("widget call bridge (MCP Apps host)", () => {
  it("handshakes, then Ask Eyes explicitly confirms the quote and renders the task", async () => {
    const host = vi.fn((_m: Msg): Result => ({ structuredContent: { ...TASK } }));
    const w = boot({ host });
    await w.settle();
    expect(w.sent[0]).toMatchObject({ method: "ui/initialize" });
    expect(w.sent.some((m) => m.method === "ui/notifications/initialized")).toBe(true);
    expect(w.win.document.documentElement.dataset.theme).toBe("dark");

    w.show(QUOTE, { location: "Ferry Building, San Francisco", task_type: "line_length" });
    (w.root.querySelector('[data-field="question"]') as HTMLInputElement).value = " How long is the line? ";
    w.button("ask").click();
    expect(w.button("ask").disabled).toBe(true);
    await w.settle();
    expect(host.mock.calls[0]?.[0]).toMatchObject({
      method: "tools/call",
      params: {
        name: "confirm_ask",
        arguments: {
          question: "How long is the line?",
          location: "Ferry Building, San Francisco",
          task_type: "line_length",
          bounty_usd: 3,
          idempotency_key: "key-1",
        },
      },
    });
    expect(w.root.textContent).toContain("Finding a worker");
    expect(w.button("cancel")).not.toBeNull();
  });

  it.each([
    ["refresh", "get_task", {}],
    ["wait", "await_answer", {}],
    ["cancel", "cancel_task", {}],
  ])("task card %s calls %s with the task_id and merges the result", async (act, tool) => {
    const host = vi.fn((_m: Msg): Result => ({ structuredContent: { task_id: "t1", status: "refunded" } }));
    const w = boot({ host });
    w.show({ ...TASK });
    w.button(act).click();
    await w.settle();
    expect(host.mock.calls.at(-1)?.[0].params).toEqual({ name: tool, arguments: { task_id: "t1" } });
    expect(w.root.textContent).toContain("How long is the line?");
    expect(w.root.textContent).toContain("Refunded");
  });

  it("Dispute sends the typed reason; a tool error shows inline and re-enables the button", async () => {
    const host = vi.fn(
      (_m: Msg): Result => ({ isError: true, content: [{ type: "text", text: "reason too short" }] }),
    );
    const w = boot({ host });
    w.show({ ...TASK, status: "verified", answer: ANSWER });
    (w.root.querySelector('[data-field="reason"]') as HTMLInputElement).value = "Wrong cafe";
    w.button("dispute").click();
    await w.settle();
    expect(host.mock.calls[0]?.[0].params).toEqual({
      name: "dispute_answer",
      arguments: { task_id: "t1", reason: "Wrong cafe" },
    });
    expect(w.root.querySelector("[data-error]")?.textContent).toBe("reason too short");
    expect(w.button("dispute").disabled).toBe(false);
  });

  it("a JSON-RPC error from the host shows inline", async () => {
    const w = boot({ host: () => ({ error: { message: "tool not allowed" } }) });
    w.show({ balance_usd: 4, escrowed_usd: 0, top_up_url: "https://pay.test/top" });
    w.button("balance").click();
    await w.settle();
    expect(w.root.querySelector("[data-error]")?.textContent).toBe("tool not allowed");
  });

  it("balance Refresh calls get_balance; Top up opens the link through ui/open-link", async () => {
    const host = vi.fn(
      (m: Msg): Result =>
        m.method === "tools/call"
          ? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    balance_usd: 9,
                    escrowed_usd: 0,
                    top_up_url: "https://pay.test/top",
                  }),
                },
              ],
            }
          : {},
    );
    const w = boot({ host });
    w.show({ balance_usd: 1, escrowed_usd: 0, top_up_url: "https://pay.test/top" });
    w.button("balance").click();
    await w.settle();
    expect(host.mock.calls[0]?.[0].params).toEqual({ name: "get_balance", arguments: {} });
    expect(w.root.textContent).toContain("$9.00");
    w.button("topup").click();
    expect(w.sent.at(-1)).toMatchObject({ method: "ui/open-link", params: { url: "https://pay.test/top" } });
  });
});

describe("widget call bridge (ChatGPT)", () => {
  it("uses window.openai.callTool and openExternal instead of postMessage", async () => {
    const callTool = vi.fn(async () => ({
      structuredContent: { balance_usd: 7, escrowed_usd: 0, top_up_url: "https://pay.test/top" },
    }));
    const openExternal = vi.fn();
    const w = boot({
      openai: {
        callTool,
        openExternal,
        theme: "light",
        toolInput: {},
        toolOutput: { balance_usd: 2, escrowed_usd: 1, top_up_url: "https://pay.test/top" },
      },
    });
    expect(w.root.textContent).toContain("$2.00");
    w.button("balance").click();
    await w.settle();
    expect(callTool).toHaveBeenCalledWith("get_balance", {});
    expect(w.sent.some((m) => m.method === "tools/call")).toBe(false);
    expect(w.root.textContent).toContain("$7.00");
    w.button("topup").click();
    expect(openExternal).toHaveBeenCalledWith({ href: "https://pay.test/top" });
  });
});

describe.each(["MCP Apps", "ChatGPT"])("%s answer acceptance", (bridge) => {
  const taskId = "ab281e88-eebd-41ec-bffc-0df5ca704c9b";
  const acceptedAt = "2026-10-18T12:00:00.000Z";
  const accepted = { task_id: taskId, status: "accepted", accepted_at: acceptedAt };
  const answered = { ...TASK, task_id: taskId, status: "verified", answer: ANSWER, accepted_at: null };
  function setup(handler: (name: string, args: Record<string, unknown>) => Result | Promise<Result>) {
    const invoke = vi.fn(handler);
    const w =
      bridge === "ChatGPT"
        ? boot({ openai: { callTool: invoke } })
        : boot({
            host: (m) => invoke(String(m.params?.name), m.params?.arguments as Record<string, unknown>),
          });
    w.show(answered);
    return { ...w, invoke };
  }

  it.each(["verified", "paid"])("accepts an answered %s task once while busy", async (status) => {
    let resolve!: (result: Result) => void;
    const pending = new Promise<Result>((done) => {
      resolve = done;
    });
    const w = setup(() => pending);
    w.show({ ...answered, status });
    const button = w.button("accept");
    expect(button.textContent).toBe("Looks good");
    expect(button.classList.contains("ui-button--primary")).toBe(true);
    button.click();
    expect(button.getAttribute("aria-busy")).toBe("true");
    for (const action of ["accept", "refresh", "dispute"]) {
      expect(w.button(action).disabled).toBe(true);
      w.button(action).click();
    }
    expect(w.invoke).toHaveBeenCalledExactlyOnceWith("accept_answer", { task_id: taskId });
    resolve({ content: [{ type: "text", text: JSON.stringify(accepted) }] });
    await w.settle();
    expect(w.root.querySelector("[data-accepted]")?.textContent).toBe("Accepted");
    expect(w.button("accept")).toBeNull();
    expect(w.root.querySelector(".ui-card__header")?.textContent).toContain("Verified");
    expect(w.root.querySelector(".ui-card__answer")?.textContent).toBe("Ten people");
    expect(w.button("refresh").disabled).toBe(false);
    expect(w.button("dispute").disabled).toBe(false);
    if (bridge === "ChatGPT") expect(w.sent.some((m) => m.method === "tools/call")).toBe(false);
  });

  it("preserves the answer and reason after an inline error, then retries", async () => {
    let attempts = 0;
    const w = setup(() =>
      ++attempts === 1
        ? {
            isError: true,
            structuredContent: {
              error: "task_not_acceptable",
              message: "Acceptance <unavailable>.",
              fix: "Try again.",
            },
          }
        : { structuredContent: accepted },
    );
    const reason = w.root.querySelector('[data-field="reason"]') as HTMLInputElement;
    reason.value = "Keep this draft";
    w.button("accept").click();
    await w.settle();
    expect(w.root.querySelector('[data-error][role="alert"]')?.textContent).toBe(
      "Acceptance <unavailable>. Try again.",
    );
    expect(reason.value).toBe("Keep this draft");
    expect(w.root.querySelector(".ui-card__answer")?.textContent).toBe("Ten people");
    for (const action of ["accept", "refresh", "dispute"]) expect(w.button(action).disabled).toBe(false);
    expect(w.button("accept").getAttribute("aria-busy")).toBe("false");
    w.button("accept").click();
    await w.settle();
    expect(w.invoke.mock.calls).toEqual([
      ["accept_answer", { task_id: taskId }],
      ["accept_answer", { task_id: taskId }],
    ]);
    expect(w.root.querySelector("[data-error]")).toBeNull();
    expect(w.root.querySelector("[data-accepted]")).not.toBeNull();
  });

  it("keeps acceptance on refresh and reload without blocking a later dispute", async () => {
    const persisted = { ...answered, accepted_at: acceptedAt };
    const w = setup((name) => ({
      structuredContent: name === "get_task" ? persisted : { task_id: taskId, status: "disputed" },
    }));
    w.show(persisted);
    expect(w.button("accept")).toBeNull();
    w.button("refresh").click();
    await w.settle();
    expect(w.invoke).toHaveBeenLastCalledWith("get_task", { task_id: taskId });
    expect(w.root.querySelector("[data-accepted]")?.textContent).toBe("Accepted");
    const reloaded = setup(() => ({}));
    reloaded.show(persisted);
    expect(reloaded.root.querySelector("[data-accepted]")?.textContent).toBe("Accepted");
    expect(reloaded.button("accept")).toBeNull();
    (w.root.querySelector('[data-field="reason"]') as HTMLInputElement).value = "Wrong cafe";
    w.button("dispute").click();
    await w.settle();
    expect(w.invoke.mock.calls).toEqual([
      ["get_task", { task_id: taskId }],
      ["dispute_answer", { task_id: taskId, reason: "Wrong cafe" }],
    ]);
    expect(w.button("accept")).toBeNull();
    expect(w.root.querySelector(".ui-card__header")?.textContent).toContain("Disputed");
  });

  it("merges host acceptance notifications without losing the verified answer", () => {
    const w = setup(() => ({}));
    if (bridge === "ChatGPT") {
      const notification = w.win.document.createEvent("CustomEvent");
      notification.initCustomEvent("openai:set_globals", false, false, {
        globals: { toolOutput: accepted },
      });
      w.win.dispatchEvent(notification);
    } else {
      w.show(accepted);
    }
    expect(w.root.querySelector("[data-accepted]")?.textContent).toBe("Accepted");
    expect(w.root.querySelector(".ui-card__header")?.textContent).toContain("Verified");
    expect(w.root.querySelector(".ui-card__answer")?.textContent).toBe("Ten people");
    expect(w.button("dispute")).not.toBeNull();
    expect(w.invoke).not.toHaveBeenCalled();
  });

  it("does not claim acceptance from an incomplete result", async () => {
    const w = setup(() => ({ structuredContent: { task_id: taskId, status: "accepted" } }));
    w.button("accept").click();
    await w.settle();
    expect(w.root.querySelector("[data-accepted]")).toBeNull();
    expect(w.root.querySelector('[role="alert"]')?.textContent).toBe(
      "Acceptance was not confirmed. Refresh the task or try again.",
    );
    expect(w.button("accept").disabled).toBe(false);
  });

  it.each([
    ["dispatched", null],
    ["claimed", null],
    ["submitted", ANSWER],
    ["verified", null],
    ["paid", null],
    ["needs_review", ANSWER],
    ["disputed", ANSWER],
    ["expired", null],
    ["refunded", null],
  ])("hides acceptance for %s with answer %j", (status, answer) => {
    const w = setup(() => ({}));
    w.show({ ...answered, status, answer });
    expect(w.button("accept")).toBeNull();
    expect(w.root.querySelector("[data-accepted]")).toBeNull();
    expect(w.invoke).not.toHaveBeenCalled();
  });
});

it("allows the widget to call the real acceptance tool", () => {
  expect(WIDGET_CALLABLE).toContain("accept_answer");
});

describe.each(["MCP Apps", "ChatGPT"])("%s dispute retry", (bridge) => {
  const context = {
    question: 'Is the "north" entrance <still> open?',
    location: { lat: 37.7956, lng: -122.3933, label: "Ferry Building north entrance" },
    task_type: "is_open",
    bounty_usd: 4.25,
    deadline_minutes: 45,
    require_photo: false,
  };
  const answered = { ...TASK, status: "paid", answer: ANSWER };
  const disputed = { task_id: "t1", status: "disputed", retry_context: context };
  const quote = { ...QUOTE, suggested_bounty_usd: 2 };
  function setup(handler: (name: string, args: Record<string, unknown>) => Result | Promise<Result>) {
    const invoke = vi.fn(handler);
    const w =
      bridge === "ChatGPT"
        ? boot({ openai: { callTool: invoke } })
        : boot({
            host: (m) => invoke(String(m.params?.name), m.params?.arguments as Record<string, unknown>),
          });
    const question = () => w.root.querySelector('[data-field="question"]') as HTMLInputElement;
    const dispute = async () => {
      (w.root.querySelector('[data-field="reason"]') as HTMLInputElement).value = "Wrong entrance";
      w.button("dispute").click();
      await w.settle();
    };
    return { ...w, invoke, question, dispute };
  }

  it("clicks original ask, dispute, free quote, then explicitly asks with exact context and a fresh key", async () => {
    let asks = 0;
    const w = setup((name) => ({
      structuredContent:
        name === "confirm_ask"
          ? { ...TASK, task_id: ++asks === 1 ? "t1" : "t2" }
          : name === "dispute_answer"
            ? disputed
            : quote,
    }));
    w.show({ ...QUOTE, suggested_bounty_usd: context.bounty_usd }, context);
    w.button("ask").click();
    await w.settle();
    const originalKey = w.invoke.mock.calls[0]?.[1].idempotency_key;
    w.show(answered, {
      question: "Wrong question",
      location: "Wrong place",
      task_type: "line_length",
      idempotency_key: originalKey,
    });
    await w.dispute();
    expect(w.invoke).toHaveBeenLastCalledWith("dispute_answer", { task_id: "t1", reason: "Wrong entrance" });
    expect(w.root.textContent).toContain("Dispute submitted.");
    expect(w.root.textContent).toContain("Ten people");
    expect(w.button("again").textContent).toBe("Ask again");
    expect(w.button("dispute")).toBeNull();
    expect(w.button("accept")).toBeNull();
    expect(w.invoke.mock.calls.map(([name]) => name)).toEqual(["confirm_ask", "dispute_answer"]);

    w.button("again").click();
    expect(w.button("again").disabled).toBe(true);
    w.button("again").click();
    await w.settle();
    expect(w.invoke).toHaveBeenLastCalledWith("quote_task", {
      location: context.location,
      task_type: context.task_type,
    });
    expect(w.invoke.mock.calls.map(([name]) => name)).toEqual([
      "confirm_ask",
      "dispute_answer",
      "quote_task",
    ]);
    expect(w.question().value).toBe(context.question);
    expect(w.question().readOnly).toBe(true);
    expect(w.root.textContent).toContain("Suggested bounty $2.00");
    expect(w.root.textContent).toContain("The quote is free.");
    expect(w.root.textContent).toContain("2 workers nearby");
    expect(w.button("ask").textContent).toBe("Ask for $4.25 + $0.50 fee");
    w.button("ask").click();
    w.button("ask").click();
    await w.settle();
    const newArgs = w.invoke.mock.calls[3]?.[1];
    expect(newArgs).toEqual({ ...context, idempotency_key: "key-2" });
    expect(newArgs?.idempotency_key).not.toBe(originalKey);
    expect(asks).toBe(2);
    expect(w.root.textContent).toContain("Finding a worker");
    expect(w.root.textContent).not.toContain("Dispute submitted.");
    if (bridge === "ChatGPT") expect(w.sent.some((m) => m.method === "tools/call")).toBe(false);
  });

  it.each([
    { ...quote, workers_nearby: 0 },
    { ...quote, allowed: false, reason_if_not: "Spend limit reached." },
  ])("does not ask when the fresh quote is unavailable: %j", async (unavailable) => {
    let quotes = 0;
    const w = setup((name) => ({
      structuredContent: name === "dispute_answer" ? disputed : ++quotes === 1 ? unavailable : quote,
    }));
    w.show(answered);
    await w.dispute();
    w.button("again").click();
    await w.settle();
    expect(w.button("ask")).toBeNull();
    expect(w.question().value).toBe(context.question);
    expect(w.root.textContent).toContain(unavailable.allowed ? "No one nearby" : "Spend limit reached.");
    expect(w.invoke.mock.calls.map(([name]) => name)).toEqual(["dispute_answer", "quote_task"]);
    w.button("requote").click();
    await w.settle();
    expect(w.invoke).toHaveBeenLastCalledWith("quote_task", {
      location: context.location,
      task_type: context.task_type,
    });
    expect(w.button("ask")).not.toBeNull();
    expect(w.invoke.mock.calls.filter(([name]) => name === "confirm_ask")).toHaveLength(0);
  });

  it.each([
    null,
    {},
    { ...context, location: { label: "Missing coordinates" } },
    { ...context, task_type: "unknown" },
    { ...context, bounty_usd: undefined },
  ])("shows useful availability without guessing missing retry context: %j", async (retry_context) => {
    const w = setup(() => ({ structuredContent: { ...answered, ...disputed } }));
    w.show({ ...answered, ...disputed, retry_context }, { ...context, idempotency_key: "do-not-reuse" });
    expect(w.button("again")).toBeNull();
    expect(w.root.textContent).toContain("original request details are missing");
    expect(w.invoke).not.toHaveBeenCalled();
    w.button("refresh").click();
    await w.settle();
    expect(w.invoke).toHaveBeenCalledExactlyOnceWith("get_task", { task_id: "t1" });
    expect(w.button("again")).not.toBeNull();
  });

  it("uses context from get_task when dispute returns only confirmation, including after prior acceptance", async () => {
    const w = setup((name) => ({
      structuredContent: name === "dispute_answer" ? { task_id: "t1", status: "disputed" } : quote,
    }));
    w.show({ ...answered, retry_context: context, accepted_at: "2026-10-18T12:00:00Z" });
    expect(w.root.querySelector("[data-accepted]")?.textContent).toBe("Accepted");
    await w.dispute();
    w.button("again").click();
    await w.settle();
    expect(w.invoke).toHaveBeenLastCalledWith("quote_task", {
      location: context.location,
      task_type: context.task_type,
    });
    expect(w.question().value).toBe(context.question);
  });

  it("keeps dispute and quote network failures recoverable without sending an ask", async () => {
    let attempts = 0;
    const w = setup((name) =>
      ++attempts === 1 || attempts === 3
        ? { isError: true, structuredContent: { message: "Network unavailable. Retry." } }
        : { structuredContent: name === "dispute_answer" ? disputed : quote },
    );
    w.show(answered);
    await w.dispute();
    expect(w.button("again")).toBeNull();
    expect(w.button("dispute").disabled).toBe(false);
    expect(w.root.querySelector('[role="alert"]')?.textContent).toBe("Network unavailable. Retry.");
    await w.dispute();
    w.button("again").click();
    await w.settle();
    expect(w.root.textContent).toContain("Dispute submitted.");
    expect(w.button("again").disabled).toBe(false);
    w.button("again").click();
    await w.settle();
    expect(w.question().value).toBe(context.question);
    expect(w.invoke.mock.calls.map(([name]) => name)).toEqual([
      "dispute_answer",
      "dispute_answer",
      "quote_task",
      "quote_task",
    ]);
  });

  it.each(["dispute_answer", "quote_task"])(
    "does not treat an incomplete %s result as confirmation",
    async (tool) => {
      const w = setup((name) => ({ structuredContent: name === tool ? {} : disputed }));
      w.show(answered);
      await w.dispute();
      if (tool === "quote_task") {
        w.button("again").click();
        await w.settle();
        expect(w.button("again").disabled).toBe(false);
      } else expect(w.button("again")).toBeNull();
      expect(w.root.querySelector('[role="alert"]')?.textContent).toContain(
        tool === "quote_task" ? "quote was incomplete" : "Dispute was not confirmed",
      );
      expect(w.invoke.mock.calls.filter(([name]) => name === "confirm_ask")).toHaveLength(0);
    },
  );

  it("retains the new ask key and exact arguments across a network failure and a fresh availability check", async () => {
    let asks = 0;
    const w = setup((name) =>
      name === "confirm_ask"
        ? ++asks === 1
          ? { isError: true, structuredContent: { message: "Connection lost." } }
          : { structuredContent: { ...TASK, task_id: "t2" } }
        : { structuredContent: name === "dispute_answer" ? disputed : quote },
    );
    w.show(answered);
    await w.dispute();
    w.button("again").click();
    await w.settle();
    w.button("ask").click();
    await w.settle();
    expect(w.root.querySelector('[role="alert"]')?.textContent).toBe("Connection lost.");
    expect(w.button("ask").disabled).toBe(false);
    const first = w.invoke.mock.calls[2]?.[1];
    w.button("requote").click();
    await w.settle();
    w.button("ask").click();
    await w.settle();
    expect(w.invoke.mock.calls[4]?.[1]).toEqual(first);
    expect(first).toEqual({ ...context, idempotency_key: "key-1" });
    expect(w.root.textContent).toContain("Finding a worker");
  });

  it("preserves Report manual approval for the new ask without sending before approval", async () => {
    const w = setup((name, args) => {
      if (name === "dispute_answer") return { structuredContent: disputed };
      if (name === "quote_task") return { structuredContent: quote };
      if (name === "confirm_ask")
        return args.classifier_report_id
          ? { structuredContent: { ...TASK, task_id: "t2" } }
          : {
              isError: true,
              structuredContent: { error: "unsafe_task", layer: "classifier", message: "Review required." },
            };
      return {
        structuredContent: {
          ticket_id: "report-1",
          status: name === "report_classifier" ? "open" : "approved",
        },
      };
    });
    const report = (action: string) =>
      w.root.querySelector(`[data-report-act="${action}"]`) as HTMLButtonElement;
    w.show(answered);
    await w.dispute();
    w.button("again").click();
    await w.settle();
    w.button("ask").click();
    await w.settle();
    const newArgs = w.invoke.mock.calls[2]?.[1];
    report("submit").click();
    await w.settle();
    expect(w.root.textContent).toContain("Awaiting manual review.");
    report("check").click();
    await w.settle();
    expect(w.invoke.mock.calls.filter(([name]) => name === "confirm_ask")).toHaveLength(1);
    report("retry").click();
    await w.settle();
    expect(w.invoke).toHaveBeenLastCalledWith("confirm_ask", {
      ...newArgs,
      classifier_report_id: "report-1",
    });
    expect(w.root.textContent).toContain("Finding a worker");
  });

  it("shows no-worker no-charge results if availability changes after explicit confirmation", async () => {
    const w = setup((name) => ({
      structuredContent:
        name === "dispute_answer"
          ? disputed
          : name === "quote_task"
            ? quote
            : { status: "not_sent", charged_usd: 0 },
    }));
    w.show(answered);
    await w.dispute();
    w.button("again").click();
    await w.settle();
    w.button("ask").click();
    await w.settle();
    expect(w.root.textContent).toContain(context.question);
    expect(w.root.textContent).toContain(context.location.label);
    expect(w.root.textContent).toContain("Nothing was charged.");
    expect(w.root.textContent).toContain("$0.00");
  });
});

it("allows both widget bridges to call the free quote tool", () => {
  expect(WIDGET_CALLABLE).toContain("quote_task");
});

describe.each(["MCP Apps", "ChatGPT"])("%s readable tool errors", (bridge) => {
  const message = "Safety review <unavailable>";
  const fix = 'Retry the same request & keep "public" places.';
  it.each(["text", "structured", "rejected"])(
    "shows message and fix from %s errors after Ask is clicked",
    async (kind) => {
      const payload = { error: "unsafe_task", message, fix, category: "other" };
      const text = JSON.stringify(payload);
      const result: Result =
        kind === "structured"
          ? { isError: true, structuredContent: payload }
          : { isError: true, content: [{ type: "text", text }] };
      const w =
        bridge === "ChatGPT"
          ? boot({
              openai: {
                callTool: async () => {
                  if (kind === "rejected") throw new Error(text);
                  return result;
                },
              },
            })
          : boot({ host: () => (kind === "rejected" ? { error: { message: text } } : result) });
      w.show(QUOTE, { location: "YC 580 20th Street", question: "Is the hackathon on going?" });
      w.button("ask").click();
      await w.settle();
      const alert = w.root.querySelector('[data-error][role="alert"]');
      expect(alert?.textContent).toBe(`${message} ${fix}`);
      expect(alert?.innerHTML).toContain("&lt;unavailable&gt;");
      expect(alert?.textContent).not.toContain("unsafe_task");
      expect(w.button("ask").disabled).toBe(false);
      w.button("ask").click();
      await w.settle();
      expect(w.root.querySelectorAll("[data-error]")).toHaveLength(1);
    },
  );

  it.each(["detail", "screenshot", "python-repr", "nested-message", "structured-detail"])(
    "extracts the human error from %s after an actual Ask click",
    async (shape) => {
      const payload = { error: "unsafe_task", message, fix: `${fix} Don't photograph <faces>.` };
      const text = JSON.stringify(payload);
      const repr = shape === "python-repr" ? text.replace(/\\/g, "\\\\").replace(/'/g, "\\'") : text;
      const wrapped = `Error code: INVALID_ARGUMENT; Error: RuntimeException: Error calling MCP tool: [TextContent(type='text', text='${repr}', annotations=None, meta=None)]`;
      const detail = shape === "detail" ? payload : wrapped;
      const raw = JSON.stringify(
        shape === "nested-message" ? { message: JSON.stringify({ detail }) } : { detail },
      );
      const result: Result = { isError: true, structuredContent: { detail } };
      const w =
        bridge === "ChatGPT"
          ? boot({
              openai: {
                callTool: async () => {
                  if (shape === "structured-detail") return result;
                  throw new Error(raw);
                },
              },
            })
          : boot({ host: () => (shape === "structured-detail" ? result : { error: { message: raw } }) });
      w.show(QUOTE, { question: "Is it still open?" });
      w.button("ask").click();
      await w.settle();
      const alert = w.root.querySelector('[role="alert"]');
      expect(alert?.textContent).toBe(`${message} ${payload.fix}`);
      expect(alert?.innerHTML).toContain("&lt;faces&gt;");
      expect(alert?.textContent).not.toMatch(/TextContent|INVALID_ARGUMENT|unsafe_task|\{"detail"/);
      expect(w.button("ask").disabled).toBe(false);
    },
  );

  it("hides malformed host wrappers instead of printing raw JSON", async () => {
    const raw = JSON.stringify({
      detail: "RuntimeException: [TextContent(type='text', text='{broken}', meta=None)]",
    });
    const w =
      bridge === "ChatGPT"
        ? boot({
            openai: {
              callTool: async () => {
                throw new Error(raw);
              },
            },
          })
        : boot({ host: () => ({ error: { message: raw } }) });
    w.show(QUOTE);
    w.button("ask").click();
    await w.settle();
    expect(w.root.querySelector('[role="alert"]')?.textContent).toBe("The tool failed. Retry the request.");
    expect(w.button("ask").disabled).toBe(false);
  });
});

describe.each(["MCP Apps", "ChatGPT"])("%s classifier report review", (bridge) => {
  const error = {
    error: "unsafe_task",
    layer: "classifier",
    category: "other",
    message: "Safety review refused.",
    fix: "Nothing was charged.",
  };
  const failed: Result = { isError: true, content: [{ type: "text", text: JSON.stringify(error) }] };
  function setup(handler: (name: string, args: Record<string, unknown>) => Result) {
    const invoke = vi.fn(handler);
    const w =
      bridge === "ChatGPT"
        ? boot({
            openai: { callTool: async (name: string, args: Record<string, unknown>) => invoke(name, args) },
          })
        : boot({
            host: (m) => invoke(String(m.params?.name), m.params?.arguments as Record<string, unknown>),
          });
    w.show(QUOTE, {
      location: { lat: 37.77, lng: -122.4 },
      task_type: "is_open",
    });
    const report = (action: string) =>
      w.root.querySelector(`[data-report-act="${action}"]`) as HTMLButtonElement | null;
    const question = () => w.root.querySelector('[data-field="question"]') as HTMLInputElement;
    const change = (value: string) => {
      question().value = value;
      const event = w.win.document.createEvent("Event");
      event.initEvent("input", true, false);
      question().dispatchEvent(event);
    };
    return { ...w, invoke, report, question, change };
  }

  it("reports the exact refusal, waits for manual approval, then explicitly retries only the original ask", async () => {
    const w = setup((name, args) => {
      if (name === "confirm_ask") return args.classifier_report_id ? { structuredContent: TASK } : failed;
      if (name === "report_classifier")
        return { structuredContent: { ticket_id: "42", created: true, status: "open" } };
      return { structuredContent: { ticket_id: "42", status: "approved" } };
    });
    expect(w.question().value).toBe("");
    w.change("Is it still open?");
    w.button("ask").click();
    await w.settle();
    const original = w.invoke.mock.calls[0]?.[1];
    expect(w.question().value).toBe("Is it still open?");
    w.change("Different question");
    w.report("submit")?.click();
    expect(w.report("submit")?.disabled).toBe(true);
    expect(w.button("ask").disabled).toBe(true);
    await w.settle();
    expect(w.invoke).toHaveBeenNthCalledWith(2, "report_classifier", {
      ...original,
      classifier_error: error,
      ask_idempotency_key: "key-1",
      idempotency_key: "key-2",
    });
    expect(w.root.textContent).toContain("Ticket 42: Awaiting manual review.");
    expect(w.report("submit")).toBeNull();
    expect(w.invoke.mock.calls.filter(([name]) => name === "confirm_ask")).toHaveLength(1);
    // Host report notifications must not replace the quote or its typed question.
    if (bridge === "ChatGPT") {
      const notification = w.win.document.createEvent("CustomEvent");
      notification.initCustomEvent("openai:set_globals", false, false, {
        globals: { toolInput: { ticket_id: "42" }, toolOutput: { ticket_id: "42", status: "open" } },
      });
      w.win.dispatchEvent(notification);
    } else {
      w.show({ ticket_id: "42", status: "open" }, { ticket_id: "42" });
    }
    expect(w.question().value).toBe("Different question");
    w.report("check")?.click();
    await w.settle();
    expect(w.invoke).toHaveBeenNthCalledWith(3, "get_classifier_report", { ticket_id: "42" });
    expect(w.report("retry")?.disabled).toBe(true);
    w.report("retry")?.click();
    expect(w.invoke.mock.calls).toHaveLength(3);
    w.change("Is it still open?");
    w.report("retry")?.click();
    await w.settle();
    expect(w.invoke).toHaveBeenNthCalledWith(4, "confirm_ask", { ...original, classifier_report_id: "42" });
    expect(w.root.textContent).toContain("Finding a worker");
  });

  it("retries report failures with the same report key, without retrying or charging the ask", async () => {
    let attempts = 0;
    const w = setup((name) =>
      name === "confirm_ask"
        ? failed
        : ++attempts === 1
          ? {
              isError: true,
              content: [
                { type: "text", text: JSON.stringify({ message: "Report failed.", fix: "Try again." }) },
              ],
            }
          : { structuredContent: { ticket_id: "43", created: false, status: "open" } },
    );
    w.change("Is it still open?");
    w.button("ask").click();
    await w.settle();
    w.report("submit")?.click();
    await w.settle();
    expect(w.root.querySelector('[data-report] [role="alert"]')?.textContent).toBe(
      "Report failed. Try again.",
    );
    expect(w.report("submit")?.disabled).toBe(false);
    expect(w.question().value).toBe("Is it still open?");
    w.report("submit")?.click();
    await w.settle();
    expect(w.invoke.mock.calls[1]?.[1]).toEqual(w.invoke.mock.calls[2]?.[1]);
    expect(w.invoke.mock.calls.filter(([name]) => name === "confirm_ask")).toHaveLength(1);
    expect(w.report("submit")).toBeNull();
  });

  it.each(["rejected", "expired", "consumed"])(
    "shows review status %s without creating another task",
    async (status) => {
      const w = setup((name) => {
        if (name === "confirm_ask") return failed;
        if (name === "report_classifier") return { structuredContent: { ticket_id: "44", status: "open" } };
        if (name === "get_task") return { structuredContent: TASK };
        return { structuredContent: { ticket_id: "44", status, reason: "<reviewed>", task_id: "t1" } };
      });
      w.change("Is it still open?");
      w.button("ask").click();
      await w.settle();
      w.report("submit")?.click();
      await w.settle();
      w.report("check")?.click();
      await w.settle();
      expect(w.report("retry")).toBeNull();
      expect(w.root.querySelector("[data-report]")?.innerHTML).toContain("&lt;reviewed&gt;");
      if (status === "consumed") {
        w.report("view")?.click();
        await w.settle();
        expect(w.invoke).toHaveBeenLastCalledWith("get_task", { task_id: "t1" });
      }
      expect(w.invoke.mock.calls.filter(([name]) => name === "confirm_ask")).toHaveLength(1);
    },
  );

  it.each(["insufficient_balance", "network_error", "rules"])(
    "does not offer classifier reporting for %s",
    async (kind) => {
      const payload =
        kind === "rules" ? { ...error, layer: "rules" } : { error: kind, message: "Cannot continue." };
      const w = setup(() => ({ isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] }));
      w.change("Is it still open?");
      w.button("ask").click();
      await w.settle();
      expect(w.report("submit")).toBeNull();
    },
  );
});

describe.each(["MCP Apps", "ChatGPT"])("%s request draft", (bridge) => {
  const draft = {
    ...QUOTE,
    status: "confirmation_required",
    question: "AI question",
    location: "Ferry Building",
    task_type: "line_length",
    bounty_usd: 3,
    idempotency_key: "shared-intent",
    deadline_minutes: 30,
    require_photo: true,
  };
  function setup(
    handler: (name: string, args: Record<string, unknown>) => Result | Promise<Result>,
    restore?: { name: string; state: string },
  ) {
    const invoke = vi.fn(handler);
    const w = boot({
      ...(bridge === "ChatGPT"
        ? { openai: { callTool: invoke } }
        : {
            host: (m: Msg) => invoke(String(m.params?.name), m.params?.arguments as Record<string, unknown>),
          }),
      restore,
    });
    const update = (out: unknown, args: Record<string, unknown> = {}) => {
      if (bridge === "ChatGPT") {
        const event = w.win.document.createEvent("CustomEvent");
        event.initCustomEvent("openai:set_globals", false, false, {
          globals: { toolInput: args, toolOutput: out },
        });
        w.win.dispatchEvent(event);
      } else w.show(out, args);
    };
    const field = (name: string) => w.root.querySelector(`[data-field="${name}"]`) as HTMLInputElement;
    const edit = (name: string, value: string) => {
      field(name).value = value;
      const event = w.win.document.createEvent("Event");
      event.initEvent("input", true, false);
      field(name).dispatchEvent(event);
    };
    const snapshot = () => ({
      name: w.win.name,
      state: w.win.sessionStorage.getItem(`eyes.card.${w.win.name}`) ?? "",
    });
    return { ...w, invoke, update, field, edit, snapshot };
  }

  it("preserves user question, place and bounty through late AI updates, and posts only after confirmation", async () => {
    const w = setup(async () => ({ structuredContent: TASK }));
    w.update(draft, draft);
    w.edit("question", "My own question");
    w.edit("location", "My public place");
    w.edit("bounty_usd", "4.25");
    w.update({
      ...draft,
      question: "Late AI",
      location: "Another place",
      bounty_usd: 9,
      idempotency_key: "late-key",
    });
    await w.settle();
    expect([w.field("question").value, w.field("location").value, w.field("bounty_usd").value]).toEqual([
      "My own question",
      "My public place",
      "4.25",
    ]);
    expect(w.invoke).not.toHaveBeenCalled();
    w.button("ask").click();
    await w.settle();
    expect(w.invoke).toHaveBeenCalledExactlyOnceWith("confirm_ask", {
      question: "My own question",
      location: "My public place",
      task_type: "line_length",
      bounty_usd: 4.25,
      deadline_minutes: 30,
      require_photo: true,
      idempotency_key: "shared-intent",
    });
    expect(w.button("cancel")).not.toBeNull();
    w.update({ ...draft, idempotency_key: "another-ai-key" });
    expect(w.button("ask")).toBeNull();
    expect(w.button("cancel")).not.toBeNull();
    expect(w.invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps focus and selection while late host updates refresh an edited field", async () => {
    const w = setup(async () => ({ structuredContent: TASK }));
    w.update(draft);
    w.edit("question", "My question ");
    w.field("question").focus();
    w.field("question").setSelectionRange(3, 8, "backward");
    w.update({ ...draft, question: "Late AI question" });
    expect(w.win.document.activeElement).toBe(w.field("question"));
    expect(w.field("question").value).toBe("My question ");
    expect([
      w.field("question").selectionStart,
      w.field("question").selectionEnd,
      w.field("question").selectionDirection,
    ]).toEqual([3, 8, "backward"]);
    expect(w.invoke).not.toHaveBeenCalled();
  });

  it.each(["invalid_input", "not_sent"])(
    "allows correction after definitive %s without changing the intent key",
    async (outcome) => {
      let attempts = 0;
      const w = setup(async (name) =>
        name === "quote_task"
          ? { structuredContent: { ...QUOTE, resolved_location: { label: "Another public place" } } }
          : ++attempts === 1
            ? outcome === "invalid_input"
              ? { isError: true, structuredContent: { error: "invalid_input", message: "Fix the question." } }
              : { structuredContent: { status: "not_sent", charged_usd: 0 } }
            : { structuredContent: TASK },
      );
      w.update(draft);
      if (outcome === "invalid_input") {
        w.edit("question", "");
        w.edit("bounty_usd", "0");
      }
      w.button("ask").click();
      await w.settle();
      expect(w.field("question").readOnly).toBe(false);
      expect(w.field("bounty_usd").readOnly).toBe(false);
      w.edit("question", "Corrected user question");
      w.edit("location", "Another public place");
      w.edit("bounty_usd", "4.25");
      if (outcome === "not_sent") {
        w.button("requote").click();
        await w.settle();
        expect(w.invoke).toHaveBeenLastCalledWith("quote_task", {
          location: "Another public place",
          task_type: "line_length",
        });
      }
      const beforeConfirm = w.invoke.mock.calls.length;
      w.button("ask").click();
      await w.settle();
      expect(w.invoke).toHaveBeenLastCalledWith("confirm_ask", {
        question: "Corrected user question",
        location: "Another public place",
        task_type: "line_length",
        bounty_usd: 4.25,
        deadline_minutes: 30,
        require_photo: true,
        idempotency_key: "shared-intent",
      });
      expect(w.invoke).toHaveBeenCalledTimes(beforeConfirm + 1);
    },
  );

  it.each(["network error", "in flight"])(
    "keeps an uncertain payload frozen after %s, a later refusal and remount",
    async (outcome) => {
      const first = setup(async () =>
        outcome === "in flight"
          ? new Promise<Result>(() => {})
          : { isError: true, structuredContent: { message: "Connection lost." } },
      );
      first.update(draft);
      first.button("ask").click();
      if (outcome === "network error") await first.settle();
      const savedArgs = first.invoke.mock.calls[0]?.[1];
      let attempts = 0;
      const restored = setup(
        async () =>
          ++attempts === 1
            ? { isError: true, structuredContent: { error: "invalid_input", message: "Try later." } }
            : { structuredContent: TASK },
        first.snapshot(),
      );
      restored.button("ask").click();
      await restored.settle();
      expect(restored.field("question").readOnly).toBe(true);
      restored.update({ ...draft, question: "Different AI request", idempotency_key: "new-ai-key" });
      restored.button("ask").click();
      await restored.settle();
      expect(restored.invoke.mock.calls.map(([, args]) => args)).toEqual([savedArgs, savedArgs]);
    },
  );

  it("does not share draft state through a nonunique host-assigned frame name", async () => {
    const first = setup(async () => ({ structuredContent: TASK }), {
      name: "shared-host-frame",
      state: "null",
    });
    first.update(draft);
    first.edit("question", "First card private draft");
    const second = setup(async () => ({ structuredContent: TASK }), {
      ...first.snapshot(),
      name: "shared-host-frame",
    });
    second.update({ ...draft, question: "Independent second card", idempotency_key: "second-intent" });
    expect(second.field("question").value).toBe("Independent second card");
    second.button("ask").click();
    await second.settle();
    expect(second.invoke.mock.calls[0]?.[1].idempotency_key).toBe("second-intent");
  });

  it("restores valid host state when fallback session storage is denied", () => {
    const w = boot({
      openai: { widgetState: { privateContent: { askKey: "saved-intent", completed: TASK, last: TASK } } },
      restore: { name: "eyes.intent.saved-intent", state: "null" },
      denyStorage: true,
    });
    expect(w.button("ask")).toBeNull();
    expect(w.button("cancel")).not.toBeNull();
    expect(w.root.textContent).toContain("How long is the line?");
  });

  it("does not describe an initial balance view as an ask awaiting confirmation", async () => {
    const setWidgetState = vi.fn();
    const w = boot({ openai: { setWidgetState } });
    w.show({ balance_usd: 10, escrowed_usd: 0 });
    await w.settle();
    expect(setWidgetState.mock.calls.every(([state]) => !("modelContent" in state))).toBe(true);
    expect(w.sent.some((m) => m.method === "ui/update-model-context")).toBe(false);
  });

  it("blocks double confirmation across host rerenders and shows the already-created task", async () => {
    let finish!: (result: Result) => void;
    const pending = new Promise<Result>((resolve) => {
      finish = resolve;
    });
    const w = setup(() => pending);
    w.update(draft);
    w.button("ask").click();
    w.update({ ...draft, idempotency_key: "late-key" });
    expect(w.button("ask").disabled).toBe(true);
    w.button("ask").click();
    expect(w.invoke).toHaveBeenCalledTimes(1);
    w.update(TASK);
    finish({ structuredContent: TASK });
    await w.settle();
    w.update(draft);
    expect(w.button("ask")).toBeNull();
    expect(w.button("cancel")).not.toBeNull();
    expect(w.invoke).toHaveBeenCalledTimes(1);
  });

  it("restores the same frozen intent after a lost response and a remounted host", async () => {
    const w = setup(async () => ({ isError: true, structuredContent: { message: "Connection lost." } }));
    w.update(draft);
    w.edit("question", "User confirmed question");
    w.button("ask").click();
    w.update({ ...draft, question: "Late question", idempotency_key: "late-key" });
    await w.settle();
    expect(w.root.querySelector("[data-error]")?.textContent).toBe("Connection lost.");
    const first = w.invoke.mock.calls[0]?.[1];
    const restored = setup(async () => ({ structuredContent: TASK }), w.snapshot());
    restored.update({ ...draft, question: "Late question", idempotency_key: "late-key" });
    expect(restored.field("question").value).toBe("User confirmed question");
    restored.button("ask").click();
    await restored.settle();
    expect(restored.invoke).toHaveBeenCalledExactlyOnceWith("confirm_ask", first);
    const completed = setup(async () => ({ structuredContent: TASK }), restored.snapshot());
    completed.update(draft);
    expect(completed.button("ask")).toBeNull();
    expect(completed.button("cancel")).not.toBeNull();
    expect(completed.invoke).not.toHaveBeenCalled();
  });

  it("restores an intentional Ask Again draft without posting until fresh confirmation", async () => {
    const context = {
      question: "Check the north entrance again",
      location: { label: "Ferry Building north entrance", lat: 37.7956, lng: -122.3933 },
      task_type: "is_open",
      bounty_usd: 4.25,
    };
    const w = setup(async () => ({ structuredContent: QUOTE }));
    w.update({ ...TASK, status: "disputed", retry_context: context });
    w.button("again").click();
    await w.settle();
    expect(w.invoke).toHaveBeenCalledExactlyOnceWith("quote_task", {
      location: context.location,
      task_type: "is_open",
    });
    const restored = setup(async () => ({ structuredContent: TASK }), w.snapshot());
    expect(restored.field("question").value).toBe(context.question);
    expect(restored.invoke).not.toHaveBeenCalled();
    restored.button("ask").click();
    await restored.settle();
    expect(restored.invoke).toHaveBeenCalledExactlyOnceWith("confirm_ask", {
      ...context,
      idempotency_key: "key-1",
    });
  });

  it("publishes confirmed task context without a follow-up or another paid call", async () => {
    const invoke = vi.fn(async () => ({ structuredContent: TASK }));
    const setWidgetState = vi.fn();
    const w = boot({
      ...(bridge === "ChatGPT"
        ? { openai: { callTool: invoke, setWidgetState } }
        : { hostCapabilities: { updateModelContext: { structuredContent: {} } } }),
      host: (m) => (m.method === "tools/call" ? invoke() : {}),
    });
    w.show(draft);
    w.button("ask").click();
    await w.settle();
    const expected = {
      task_id: "t1",
      status: "dispatched",
      idempotency_key: "shared-intent",
      next_step: "await_answer",
    };
    if (bridge === "ChatGPT") {
      expect(setWidgetState.mock.lastCall?.[0].modelContent).toEqual(expected);
    } else {
      expect(w.sent.find((m) => m.method === "ui/update-model-context")?.params).toEqual({
        structuredContent: expected,
      });
    }
    expect(w.sent.some((m) => m.method === "ui/message")).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe.each(["MCP Apps", "ChatGPT"])("%s pending task auto-refresh", (bridge) => {
  const photo = "https://cdn.insforge.dev/answer.jpg";
  const answered = { ...TASK, status: "paid", answer: { ...ANSWER, photo_url: photo } };
  beforeEach(() => vi.useFakeTimers());
  function setup(handler: (name: string, args: Record<string, unknown>) => Result | Promise<Result>) {
    const invoke = vi.fn(handler);
    const w = boot({
      clock: true,
      ...(bridge === "ChatGPT"
        ? { openai: { callTool: invoke } }
        : {
            host: (m: Msg) => invoke(String(m.params?.name), m.params?.arguments as Record<string, unknown>),
          }),
    });
    return { ...w, invoke };
  }

  it("automatically shows a submitted photo and keeps refreshing until its final status", async () => {
    let reads = 0;
    const w = setup(async (name) => ({
      structuredContent:
        name === "confirm_ask" ? TASK : ++reads === 1 ? { ...answered, status: "submitted" } : answered,
    }));
    w.show(QUOTE, { question: TASK.question, location: TASK.place_label });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.invoke).not.toHaveBeenCalled();
    w.button("ask").click();
    await w.settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.root.querySelector("img")?.getAttribute("src")).toBe(photo);
    expect(w.button("accept")).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.button("accept")).not.toBeNull();
    expect(w.root.querySelector("img")?.getAttribute("src")).toBe(photo);
    expect(w.invoke.mock.calls.map(([name]) => name)).toEqual(["confirm_ask", "get_task", "get_task"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.invoke).toHaveBeenCalledTimes(3);
  });

  it("keeps an unchanged snapshot in place and shares one in-flight read with manual Refresh", async () => {
    let reads = 0;
    let finish!: (result: Result) => void;
    const waiting = new Promise<Result>((resolve) => {
      finish = resolve;
    });
    const w = setup(() => (++reads === 1 ? Promise.resolve({ structuredContent: TASK }) : waiting));
    w.show(TASK);
    const button = w.button("wait");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.button("wait")).toBe(button);
    await vi.advanceTimersByTimeAsync(5_000);
    w.button("refresh").click();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.invoke).toHaveBeenCalledTimes(2);
    finish({ structuredContent: answered });
    await w.settle();
    expect(w.root.querySelector("img")?.getAttribute("src")).toBe(photo);
  });

  it("serializes manual Wait after an in-flight poll instead of substituting the poll result", async () => {
    let finish!: (result: Result) => void;
    const waiting = new Promise<Result>((resolve) => {
      finish = resolve;
    });
    const w = setup((name) =>
      name === "get_task" ? waiting : Promise.resolve({ structuredContent: answered }),
    );
    w.show(TASK);
    await vi.advanceTimersByTimeAsync(5_000);
    w.button("wait").click();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.invoke.mock.calls.map(([name]) => name)).toEqual(["get_task"]);
    finish({ structuredContent: TASK });
    await w.settle();
    expect(w.invoke.mock.calls.map(([name]) => name)).toEqual(["get_task", "await_answer"]);
    expect(w.invoke).toHaveBeenLastCalledWith("await_answer", { task_id: "t1" });
    expect(w.root.querySelector("img")?.getAttribute("src")).toBe(photo);
  });

  it.each(["needs_review", "expired", "refunded", "disputed"])(
    "ignores a pending response after host status becomes %s",
    async (status) => {
      let finish!: (result: Result) => void;
      const w = setup(
        () =>
          new Promise<Result>((resolve) => {
            finish = resolve;
          }),
      );
      w.show(TASK);
      await vi.advanceTimersByTimeAsync(5_000);
      w.show({ ...TASK, status });
      finish({ structuredContent: answered });
      await w.settle();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(w.root.querySelector("img")).toBeNull();
      expect(w.invoke).toHaveBeenCalledTimes(1);
    },
  );

  it("does not replace an intentional new draft with an older pending read", async () => {
    let finish!: (result: Result) => void;
    const waiting = new Promise<Result>((resolve) => {
      finish = resolve;
    });
    const w = setup((name) =>
      name === "quote_task" ? Promise.resolve({ structuredContent: QUOTE }) : waiting,
    );
    w.show(TASK);
    await vi.advanceTimersByTimeAsync(5_000);
    w.show({
      ...TASK,
      status: "disputed",
      retry_context: {
        question: TASK.question,
        location: { label: "Ferry Building", lat: 37.7, lng: -122.4 },
        task_type: "line_length",
        bounty_usd: 3,
      },
    });
    w.button("again").click();
    await w.settle();
    finish({ structuredContent: answered });
    await w.settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.button("ask")).not.toBeNull();
    expect(w.root.querySelector("img")).toBeNull();
    expect(w.invoke.mock.calls.map(([name]) => name)).toEqual(["get_task", "quote_task"]);
  });

  it("pauses while hidden and stops after teardown", async () => {
    const w = setup(async () => ({ structuredContent: TASK }));
    w.show(TASK);
    Object.defineProperty(w.win.document, "hidden", { configurable: true, value: true });
    const event = w.win.document.createEvent("Event");
    event.initEvent("visibilitychange", false, false);
    w.win.document.dispatchEvent(event);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(w.invoke).not.toHaveBeenCalled();
    Object.defineProperty(w.win.document, "hidden", { configurable: true, value: false });
    w.win.document.dispatchEvent(event);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.invoke).toHaveBeenCalledTimes(1);
    w.reply({ jsonrpc: "2.0", id: 99, method: "ui/resource-teardown", params: {} });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(w.invoke).toHaveBeenCalledTimes(1);
    expect(w.sent).toContainEqual({ jsonrpc: "2.0", id: 99, result: {} });
  });

  it("stops on a failed automatic read and lets the existing Refresh button recover", async () => {
    let attempts = 0;
    const w = setup(async () =>
      ++attempts === 1
        ? { isError: true, structuredContent: { message: "Read unavailable." } }
        : { structuredContent: answered },
    );
    w.show(TASK);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.invoke).toHaveBeenCalledTimes(1);
    expect(w.root.querySelector("[data-error]")?.textContent).toContain("Read unavailable.");
    w.button("refresh").click();
    await w.settle();
    expect(w.root.querySelector("img")?.getAttribute("src")).toBe(photo);
    expect(w.invoke).toHaveBeenCalledTimes(2);
  });

  it("stops without rendering a late response after the card is detached", async () => {
    let finish!: (result: Result) => void;
    const w = setup(
      () =>
        new Promise<Result>((resolve) => {
          finish = resolve;
        }),
    );
    w.show(TASK);
    await vi.advanceTimersByTimeAsync(5_000);
    w.root.remove();
    finish({ structuredContent: answered });
    await w.settle();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(w.invoke).toHaveBeenCalledTimes(1);
    expect(w.root.querySelector("img")).toBeNull();
  });
});

it("does not poll an MCP task until the host finishes initialization", async () => {
  vi.useFakeTimers();
  const host = vi.fn(() => ({ structuredContent: TASK }));
  const w = boot({ clock: true, initialize: false, host });
  w.show(TASK);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(host).not.toHaveBeenCalled();
  w.reply({ jsonrpc: "2.0", id: 1, result: {} });
  await w.settle();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(host).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: "tools/call",
      params: { name: "get_task", arguments: { task_id: "t1" } },
    }),
  );
});

it.each([
  [true, "Yes", "Yes"],
  [false, " no. ", "No"],
  [true, "YES!", "Yes"],
  [true, "Yes, the side entrance is open.", "Yes Yes, the side entrance is open."],
  [false, "Opens tomorrow", "No Opens tomorrow"],
  [null, "Yes", "Yes"],
])("renders boolean %s and text %s without repeating the answer", (answer_bool, answer_text, expected) => {
  const w = boot();
  w.show({ ...TASK, status: "needs_review", answer: { ...ANSWER, answer_bool, answer_text } });
  expect(w.root.querySelector(".ui-card__answer")?.textContent?.trim()).toBe(expected);
});

it("inlines the script and the call helper in the HTML resource", () => {
  expect(WIDGET_HTML).toContain(WIDGET_SCRIPT);
  expect(WIDGET_HTML).toContain('"tools/call"');
  expect(WIDGET_HTML).toContain("window.openai.callTool");
});
