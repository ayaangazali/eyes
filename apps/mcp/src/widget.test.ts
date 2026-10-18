import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";
import { WIDGET_CALLABLE, WIDGET_HTML, WIDGET_SCRIPT } from "./widget.ts";

type Msg = { jsonrpc: "2.0"; id?: number; method?: string; params?: Record<string, unknown> };
type Result = { structuredContent?: unknown; content?: { type: string; text: string }[]; isError?: boolean };
type HostResult = Result | { error: { message: string } };

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
  opts: { openai?: Record<string, unknown>; host?: (m: Msg) => HostResult | Promise<HostResult> } = {},
) {
  const happy = new Window({ url: "https://card.test/" });
  const win = happy as unknown as globalThis.Window & {
    openai?: unknown;
  };
  win.document.body.innerHTML = '<main id="root"></main>';
  const sent: Msg[] = [];
  const reply = (data: unknown) =>
    win.dispatchEvent(new happy.MessageEvent("message", { data }) as unknown as Event);
  Object.defineProperty(win, "parent", {
    value: {
      postMessage: (m: Msg) => {
        sent.push(m);
        if (m.id == null) return;
        if (m.method === "ui/initialize")
          return reply({ jsonrpc: "2.0", id: m.id, result: { hostContext: { theme: "dark" } } });
        const r = opts.host?.(m) ?? {};
        void Promise.resolve(r).then((result) =>
          reply({ jsonrpc: "2.0", id: m.id, ...("error" in result ? result : { result }) }),
        );
      },
    },
  });
  if (opts.openai) win.openai = opts.openai;
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
  return { win, root, sent, show, button, settle };
}

describe("widget call bridge (MCP Apps host)", () => {
  it("handshakes, then Ask Eyes sends tools/call ask_eyes with the quote and renders the task", async () => {
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
        name: "ask_eyes",
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
    const pending = Promise.withResolvers<Result>();
    const w = setup(() => pending.promise);
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
    pending.resolve({ content: [{ type: "text", text: JSON.stringify(accepted) }] });
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
      if (name === "ask_eyes") return args.classifier_report_id ? { structuredContent: TASK } : failed;
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
    expect(w.invoke.mock.calls.filter(([name]) => name === "ask_eyes")).toHaveLength(1);
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
    expect(w.invoke).toHaveBeenNthCalledWith(4, "ask_eyes", { ...original, classifier_report_id: "42" });
    expect(w.root.textContent).toContain("Finding a worker");
  });

  it("retries report failures with the same report key, without retrying or charging the ask", async () => {
    let attempts = 0;
    const w = setup((name) =>
      name === "ask_eyes"
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
    expect(w.invoke.mock.calls.filter(([name]) => name === "ask_eyes")).toHaveLength(1);
    expect(w.report("submit")).toBeNull();
  });

  it.each(["rejected", "expired", "consumed"])(
    "shows review status %s without creating another task",
    async (status) => {
      const w = setup((name) => {
        if (name === "ask_eyes") return failed;
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
      expect(w.invoke.mock.calls.filter(([name]) => name === "ask_eyes")).toHaveLength(1);
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
