import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WIDGET_SCRIPT } from "./widget.ts";

type Result = { structuredContent?: unknown; isError?: boolean };
type Message = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; structuredContent?: unknown };
};
const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
  vi.useRealTimers();
});

const place = { lat: 37.7, lng: -122.4, label: "Synthetic public square" };
const quote = {
  workers_nearby: 1,
  est_minutes_to_answer: 2,
  suggested_bounty_usd: 3,
  allowed: true,
  resolved_location: place,
};
const draft = {
  ...quote,
  status: "confirmation_required",
  question: "Count the benches",
  location: place,
  task_type: "photo_of_place",
  bounty_usd: 3,
  deadline_minutes: 30,
  require_photo: true,
  idempotency_key: "caller-owned-intent-A",
};
const paid = {
  task_id: "task-A",
  status: "paid",
  question: draft.question,
  place_label: place.label,
  answer: {
    answer_text: "There are three benches",
    photo_url: "https://photo.test/old-A.png",
    worker_distance_m: 10,
    captured_at: "2026-10-19T10:00:00Z",
    verification: { gps_ok: true, fresh_ok: true, vision_ok: true },
    cost_usd: 3.5,
  },
};

function boot(
  bridge: "ChatGPT" | "MCP",
  handler: (name: string, args: Record<string, unknown>) => Promise<Result>,
  options: {
    input?: Record<string, unknown>;
    output?: unknown;
    restore?: { name: string; state: string };
    hostState?: unknown;
  } = {},
) {
  const window = new Window({ url: "https://card.test/" });
  windows.push(window);
  window.document.body.innerHTML = '<main id="root"></main>';
  if (options.restore) {
    window.name = options.restore.name;
    window.sessionStorage.setItem(`eyes.card.${window.name}`, options.restore.state);
  }
  const call = vi.fn(handler);
  const initialOutput = Object.hasOwn(options, "output") ? options.output : paid;
  const reply = (message: unknown) =>
    window.dispatchEvent(new window.MessageEvent("message", { data: message }));
  Object.defineProperty(window, "parent", {
    value: {
      postMessage: (message: Message) => {
        if (message.method === "ui/initialize") {
          reply({ jsonrpc: "2.0", id: message.id, result: { hostCapabilities: {}, hostContext: {} } });
        } else if (message.method === "tools/call") {
          void call(message.params?.name ?? "", message.params?.arguments ?? {}).then((result) =>
            reply({ jsonrpc: "2.0", id: message.id, result }),
          );
        }
      },
    },
  });
  if (bridge === "ChatGPT") {
    Object.assign(window, {
      openai: {
        callTool: call,
        toolInput: options.input ?? draft,
        toolOutput: initialOutput,
        widgetState: options.hostState,
        setWidgetState: vi.fn(),
      },
    });
  }
  new Function("window", "document", "ResizeObserver", "crypto", WIDGET_SCRIPT)(
    window,
    window.document,
    class {
      observe() {}
    },
    globalThis.crypto,
  );
  const show = (output: unknown, input: Record<string, unknown> = options.input ?? draft) => {
    if (bridge === "ChatGPT") {
      window.dispatchEvent(
        new window.CustomEvent("openai:set_globals", {
          detail: { globals: { toolInput: input, toolOutput: output } },
        }),
      );
    } else {
      reply({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: input } });
      reply({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: output },
      });
    }
  };
  const settle = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  if (bridge === "MCP" && initialOutput !== null) show(initialOutput);
  // happy-dom implements these DOM operations, but its declarations are not assignable to lib.dom.
  const root = window.document.getElementById("root") as unknown as HTMLElement;
  const editQuestion = (value: string) => {
    const input = root.querySelector<HTMLInputElement>('[data-field="question"]');
    if (!input) throw new Error("Editable question missing");
    input.value = value;
    const event = new window.Event("input", { bubbles: true }) as unknown as Event;
    input.dispatchEvent(event);
  };
  const snapshot = () => ({
    name: window.name,
    state: window.sessionStorage.getItem(`eyes.card.${window.name}`) ?? "",
  });
  return { window, root, call, show, settle, snapshot, editQuestion };
}

describe.each(["ChatGPT", "MCP"] as const)("independent checks through %s", (bridge) => {
  it("opens a blank same-place check before its quote and confirms with one fresh UUIDv7", async () => {
    let finishQuote!: (result: Result) => void;
    let quotedAt = 0;
    const waiting = new Promise<Result>((resolve) => {
      finishQuote = resolve;
    });
    const w = boot(bridge, async (name) => {
      if (name === "quote_task") {
        quotedAt = Date.now();
        return waiting;
      }
      return { structuredContent: { ...paid, task_id: "task-B", status: "dispatched", answer: null } };
    });
    await w.settle();
    expect(w.root.textContent).toContain(paid.answer.answer_text);
    expect(w.root.querySelector("img")).not.toBeNull();
    const newCheck = w.root.querySelector<HTMLButtonElement>('[data-act="new"]');
    expect(newCheck).not.toBeNull();
    const before = Date.now();
    newCheck?.click();
    const question = w.root.querySelector<HTMLInputElement>('[data-field="question"]');
    expect(question?.value).toBe("");
    expect(w.root.textContent).not.toContain(paid.answer.answer_text);
    expect(w.root.querySelector("img")).toBeNull();
    expect(w.call.mock.calls.filter(([name]) => name === "confirm_ask")).toHaveLength(0);
    expect(w.call).toHaveBeenCalledWith("quote_task", expect.objectContaining({ location: place }));
    w.editQuestion("Count the people");
    finishQuote({ structuredContent: quote });
    await w.settle();
    w.root.querySelector<HTMLButtonElement>('[data-act="ask"]')?.click();
    await w.settle();
    const confirmations = w.call.mock.calls.filter(([name]) => name === "confirm_ask");
    expect(confirmations).toHaveLength(1);
    const payload = confirmations[0]?.[1];
    expect(payload).toMatchObject({ location: place, question: "Count the people" });
    const key = String(payload?.idempotency_key);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(key.replaceAll("-", "").slice(0, 12), 16)).toBeGreaterThanOrEqual(before);
    expect(Number.parseInt(key.replaceAll("-", "").slice(0, 12), 16)).toBeLessThanOrEqual(quotedAt);
    expect(key).not.toBe(draft.idempotency_key);
  });

  it("accepts a different opaque incoming key before confirmation without carrying edited text", async () => {
    const w = boot(bridge, async () => ({ structuredContent: { ...paid, task_id: "task-B" } }), {
      output: draft,
    });
    w.editQuestion("Edited old draft");
    const next = { ...draft, idempotency_key: "opaque/email:B", question: "Count the people" };
    w.show(next, next);
    expect(w.root.querySelector<HTMLInputElement>('[data-field="question"]')?.value).toBe(next.question);
    expect(w.call).not.toHaveBeenCalled();
    w.root.querySelector<HTMLButtonElement>('[data-act="ask"]')?.click();
    await w.settle();
    expect(w.call).toHaveBeenCalledWith(
      "confirm_ask",
      expect.objectContaining({
        question: next.question,
        idempotency_key: next.idempotency_key,
        location: place,
      }),
    );
  });

  it("restores old A without allowing it to replace a fresh host draft B", async () => {
    const previous = boot(bridge, async () => ({ structuredContent: paid }));
    const snapshot = previous.snapshot();
    const next = { ...draft, idempotency_key: "opaque/fresh:B", question: "Fresh incoming question" };
    const restoreModes = bridge === "ChatGPT" ? ["host", "session"] : ["session"];
    for (const mode of restoreModes) {
      const w = boot(
        bridge,
        async (name, args) =>
          name === "get_task" && args.task_id === paid.task_id
            ? { isError: true, structuredContent: { message: "Not authorized" } }
            : { structuredContent: { ...paid, task_id: "task-B" } },
        {
          input: next,
          output: next,
          ...(mode === "host"
            ? { hostState: { privateContent: JSON.parse(snapshot.state) } }
            : { restore: snapshot }),
        },
      );
      expect(w.root.querySelector<HTMLInputElement>('[data-field="question"]')?.value).toBe(next.question);
      expect(w.root.textContent).not.toContain(paid.answer.answer_text);
      w.root.querySelector<HTMLButtonElement>('[data-act="previous"]')?.click();
      expect(w.root.textContent).not.toContain(paid.question);
      w.root.querySelector<HTMLButtonElement>('[data-act="ask"]')?.click();
      await w.settle();
      expect(w.call).toHaveBeenCalledWith(
        "confirm_ask",
        expect.objectContaining({ idempotency_key: next.idempotency_key }),
      );
    }
  });

  it("does not let an older quote win after a newer quote request in the same draft", async () => {
    const finishes: ((result: Result) => void)[] = [];
    const w = boot(bridge, async (name) =>
      name === "quote_task"
        ? new Promise<Result>((resolve) => finishes.push(resolve))
        : { structuredContent: paid },
    );
    w.root.querySelector<HTMLButtonElement>('[data-act="new"]')?.click();
    w.root.querySelector<HTMLButtonElement>('[data-act="requote"]')?.click();
    expect(finishes).toHaveLength(2);
    finishes[1]?.({ structuredContent: quote });
    await w.settle();
    finishes[0]?.({ structuredContent: { ...quote, allowed: false, reason_if_not: "Old denied quote" } });
    await w.settle();
    expect(w.root.querySelector<HTMLButtonElement>('[data-act="ask"]')).not.toBeNull();
    expect(w.root.textContent).not.toContain("Old denied quote");
  });

  it("isolates a late old confirmation and its finally callback from a new pending confirmation", async () => {
    const finishes: ((result: Result) => void)[] = [];
    const w = boot(
      bridge,
      async (name) => {
        if (name === "quote_task") return { structuredContent: quote };
        if (name === "confirm_ask" && finishes.length < 2) {
          return new Promise<Result>((resolve) => finishes.push(resolve));
        }
        return {
          structuredContent: {
            ...paid,
            task_id: "task-B",
            question: "New paid question",
            answer: null,
            status: "dispatched",
          },
        };
      },
      { output: draft },
    );
    w.root.querySelector<HTMLButtonElement>('[data-act="ask"]')?.click();
    w.root.querySelector<HTMLButtonElement>('[data-act="new"]')?.click();
    expect(w.root.querySelector('[data-act="separate"]')).not.toBeNull();
    w.root.querySelector<HTMLButtonElement>('[data-act="separate"]')?.click();
    await w.settle();
    w.editQuestion("New paid question");
    w.root.querySelector<HTMLButtonElement>('[data-act="ask"]')?.click();
    expect(finishes).toHaveLength(2);
    finishes[0]?.({ structuredContent: paid });
    await w.settle();
    expect(w.root.querySelector<HTMLInputElement>('[data-field="question"]')?.value).toBe(
      "New paid question",
    );
    expect(w.root.querySelector<HTMLButtonElement>('[data-act="ask"]')?.disabled).toBe(true);
    expect(w.root.querySelector("img")).toBeNull();
    w.show(paid, { task_id: paid.task_id });
    expect(w.root.querySelector<HTMLInputElement>('[data-field="question"]')?.value).toBe(
      "New paid question",
    );
    finishes[1]?.({ isError: true, structuredContent: { message: "Response lost" } });
    await w.settle();
    const firstB = w.call.mock.calls.filter(([name]) => name === "confirm_ask")[1]?.[1];
    w.root.querySelector<HTMLButtonElement>('[data-act="ask"]')?.click();
    await w.settle();
    const confirmations = w.call.mock.calls.filter(([name]) => name === "confirm_ask");
    expect(confirmations).toHaveLength(3);
    expect(confirmations[2]?.[1]).toEqual(firstB);
    expect(firstB?.idempotency_key).not.toBe(draft.idempotency_key);
  });

  it("withholds restored evidence when the current task read is denied", async () => {
    const previous = boot(bridge, async () => ({ structuredContent: paid }));
    const w = boot(
      bridge,
      async () => ({ isError: true, structuredContent: { message: "Not authorized" } }),
      {
        input: {},
        output: null,
        restore: previous.snapshot(),
      },
    );
    expect(w.root.querySelector("img")).toBeNull();
    await w.settle();
    expect(w.call).toHaveBeenCalledWith("get_task", { task_id: paid.task_id });
    expect(w.root.querySelector("img")).toBeNull();
    expect(w.root.textContent).not.toContain(paid.answer.answer_text);
    expect(w.call.mock.calls.some(([name]) => name === "confirm_ask")).toBe(false);
  });

  it("loads an explicitly requested unknown task B while task A is active", async () => {
    const w = boot(bridge, async () => ({ structuredContent: paid }));
    const next = {
      ...paid,
      task_id: "external-task-B",
      question: "Inspect the east entrance",
      answer: { ...paid.answer, answer_text: "The east entrance is open" },
    };
    w.show(next, { task_id: next.task_id });
    await w.settle();
    expect(w.root.textContent).toContain(next.question);
    expect(w.root.textContent).toContain(next.answer.answer_text);
    expect(w.root.textContent).not.toContain(paid.answer.answer_text);
  });

  it("selects each recent task by its own ID and does not create work when no check is pending", async () => {
    const pending = {
      ...paid,
      task_id: "pending-task-B",
      question: "Inspect the north entrance",
      status: "dispatched",
      answer: null,
    };
    const w = boot(bridge, async (name, args) => ({
      structuredContent:
        name === "list_tasks"
          ? { tasks: [pending, paid] }
          : args.task_id === pending.task_id
            ? pending
            : paid,
    }));
    w.root.querySelector<HTMLButtonElement>('[data-act="previous"]')?.click();
    w.root.querySelector<HTMLButtonElement>('[data-act="history"]')?.click();
    await w.settle();
    w.root.querySelector<HTMLButtonElement>('[data-act="resume"]')?.click();
    await w.settle();
    expect(w.call).toHaveBeenCalledWith("get_task", { task_id: pending.task_id });
    expect(w.root.textContent).toContain(pending.question);
    expect(w.root.querySelector("img")).toBeNull();
    w.root.querySelector<HTMLButtonElement>('[data-act="previous"]')?.click();
    const oldRow = [...w.root.querySelectorAll<HTMLButtonElement>("[data-record]")].find((row) =>
      row.textContent?.includes(paid.question),
    );
    oldRow?.click();
    await w.settle();
    expect(w.call).toHaveBeenCalledWith("get_task", { task_id: paid.task_id });
    expect(w.root.textContent).toContain(paid.answer.answer_text);
    w.show({ ...pending, status: "paid", answer: paid.answer }, { task_id: pending.task_id });
    const callsBefore = w.call.mock.calls.filter(([name]) => name === "confirm_ask").length;
    w.root.querySelector<HTMLButtonElement>('[data-act="resume"]')?.click();
    await w.settle();
    expect(w.call.mock.calls.filter(([name]) => name === "confirm_ask")).toHaveLength(callsBefore);
    expect(w.root.querySelector('[data-act="new"]')).not.toBeNull();
  });

  it("distinguishes two new checks in visible identity and history under the same clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
    const w = boot(bridge, async () => ({ structuredContent: quote }));
    w.root.querySelector<HTMLButtonElement>('[data-act="new"]')?.click();
    await w.settle();
    const first = w.root.querySelector("[data-identity]")?.textContent;
    w.root.querySelector<HTMLButtonElement>('[data-act="new"]')?.click();
    await w.settle();
    const second = w.root.querySelector("[data-identity]")?.textContent;
    expect(first).toBeTruthy();
    expect(second).not.toBe(first);
    const recent = [...w.root.querySelectorAll("[data-record]")].slice(0, 2).map((row) => row.textContent);
    expect(recent).toHaveLength(2);
    expect(recent[0]).not.toBe(recent[1]);
  });

  it("retains the terminal answer when the host replays an older pending result for that task", async () => {
    const w = boot(bridge, async () => ({ structuredContent: paid }));
    await w.settle();
    expect(w.root.textContent).toContain(paid.answer.answer_text);
    w.show({ ...paid, status: "dispatched", answer: null }, { task_id: paid.task_id });
    await w.settle();
    expect(w.root.textContent).toContain(paid.answer.answer_text);
    expect(w.root.querySelector("img")).not.toBeNull();
    expect(w.call.mock.calls.some(([name]) => name === "confirm_ask")).toBe(false);
  });

  it("keeps an unknown confirmation frozen when a retry says not_sent before idempotency lookup", async () => {
    let attempts = 0;
    const w = boot(
      bridge,
      async (name) => {
        if (name !== "confirm_ask") return { structuredContent: quote };
        attempts++;
        if (attempts === 1) return { isError: true, structuredContent: { message: "Response lost" } };
        if (attempts === 2)
          return {
            structuredContent: { status: "not_sent", charged_usd: 0, reason: "no_workers_nearby" },
          };
        return { structuredContent: { ...paid, task_id: "recovered-task" } };
      },
      { output: draft },
    );
    w.root.querySelector<HTMLButtonElement>('[data-act="ask"]')?.click();
    await w.settle();
    const original = w.call.mock.calls[0]?.[1];
    w.root.querySelector<HTMLButtonElement>('[data-act="ask"]')?.click();
    await w.settle();
    const frozen = w.root.querySelector<HTMLInputElement>('[data-field="question"]');
    expect(frozen?.value).toBe(draft.question);
    expect(frozen?.readOnly).toBe(true);
    expect(w.root.querySelector("[data-identity]")?.textContent).not.toContain("Not sent");
    expect(w.root.textContent).not.toContain("$0 charged");
    const saved = JSON.parse(w.snapshot().state) as {
      active: string;
      records: { id: string; uncertain: boolean; submitted: Record<string, unknown> }[];
    };
    expect(saved.records.find((record) => record.id === saved.active)).toMatchObject({
      uncertain: true,
      submitted: original,
    });
    w.root.querySelector<HTMLButtonElement>('[data-act="ask"]')?.click();
    await w.settle();
    expect(w.call.mock.calls.filter(([name]) => name === "confirm_ask").map(([, args]) => args)).toEqual([
      original,
      original,
      original,
    ]);
  });
});
