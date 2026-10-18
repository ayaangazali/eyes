import { type EngineDeps, EyesError, type RouteDeps } from "@eyes/core";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createSandboxService, keylessAgents, SANDBOX } from "./sandbox.ts";

type Fn = (...args: never[]) => unknown;
type Messaging = { sendOffer: Fn; sendCaptureLink: Fn };
type Deps = { providers: { messaging: Messaging } };
const engine = vi.hoisted(() => ({ deps: undefined as Deps | undefined, service: {} as Record<string, Fn> }));
vi.mock("@eyes/engine", () => ({
  createEyesService: (deps: Deps) => {
    engine.deps = deps;
    return engine.service;
  },
}));

const SANDBOX_PHONE = "+1415555010";
const REAL_PHONE = "+14158671234";
const agent = { id: "a1" } as never;
const where = { lat: 1, lng: 2 };

function setup(service: Record<string, Fn>) {
  engine.service = service;
  const messaging = {
    sendOffer: vi.fn(async () => "offer-sent"),
    sendCaptureLink: vi.fn(async () => "link-sent"),
  };
  const sandbox = createSandboxService({
    providers: { messaging, clock: { now: () => new Date(0) } },
  } as unknown as EngineDeps);
  const wrapped = engine.deps?.providers.messaging as EngineDeps["providers"]["messaging"];
  return { sandbox, wrapped };
}

const quote = (workers_nearby: number, allowed = true) => ({
  allowed,
  workers_nearby,
  est_minutes_to_answer: 9,
  resolved_location: where,
});

describe("createSandboxService", () => {
  let errors: MockInstance<typeof console.error>;
  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("claims offers only for sandbox numbers and logs claim failures", async () => {
    const handleWorkerReply = vi.fn(async () => undefined);
    const { wrapped } = setup({ handleWorkerReply });

    expect(await wrapped.sendOffer(REAL_PHONE as never, {} as never)).toBe("offer-sent");
    expect(handleWorkerReply).not.toHaveBeenCalled();

    expect(await wrapped.sendOffer(`${SANDBOX_PHONE}0` as never, {} as never)).toBe("offer-sent");
    expect(handleWorkerReply).toHaveBeenCalledWith({
      phone: `${SANDBOX_PHONE}0`,
      intent: "yes",
      text: "YES",
    });

    handleWorkerReply.mockRejectedValueOnce(
      new EyesError("rate_limited", { retry_after_s: 1 }, { fix: "wait" }),
    );
    await wrapped.sendOffer(`${SANDBOX_PHONE}1` as never, {} as never);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^sandbox claim failed: .*rate_limited$/));
  });

  it("submits a simulated capture for sandbox numbers after the delay", async () => {
    vi.useFakeTimers();
    const getOffer = vi.fn(async () => ({ lat: 3, lng: 4, task_type: "is_open" }));
    const submitCapture = vi.fn(async () => undefined);
    const { wrapped } = setup({ getOffer, submitCapture });

    expect(
      await wrapped.sendCaptureLink(REAL_PHONE as never, { capture_url: "http://x/c?t=no" } as never),
    ).toBe("link-sent");
    await wrapped.sendCaptureLink(`${SANDBOX_PHONE}2` as never, { capture_url: "http://x/c?t=tok" } as never);
    await vi.advanceTimersByTimeAsync(5000);

    expect(getOffer).toHaveBeenCalledTimes(1);
    expect(getOffer).toHaveBeenCalledWith("tok");
    expect(submitCapture).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        lat: 3,
        lng: 4,
        answer_text: "Simulated sandbox answer, nobody went: Open right now.",
      }),
      expect.objectContaining({ content_type: "image/jpeg" }),
    );
  });

  it("logs capture failures by error name", async () => {
    vi.useFakeTimers();
    const getOffer = vi.fn().mockRejectedValueOnce(new TypeError("boom")).mockRejectedValueOnce("nope");
    const { wrapped } = setup({ getOffer });

    await wrapped.sendCaptureLink(`${SANDBOX_PHONE}3` as never, { capture_url: "http://x/c" } as never);
    await wrapped.sendCaptureLink(`${SANDBOX_PHONE}4` as never, { capture_url: "http://x/c" } as never);
    await vi.advanceTimersByTimeAsync(5000);

    expect(getOffer).toHaveBeenCalledWith("");
    expect(errors).toHaveBeenCalledWith("sandbox capture failed: TypeError");
    expect(errors).toHaveBeenCalledWith("sandbox capture failed: string");
  });

  it("reports at least one worker on allowed quotes", async () => {
    const quoteTask = vi
      .fn()
      .mockResolvedValueOnce(quote(0))
      .mockResolvedValueOnce(quote(2))
      .mockResolvedValueOnce(quote(0, false));
    const { sandbox } = setup({ quoteTask });

    expect(await sandbox.quoteTask(agent, {} as never)).toMatchObject({
      workers_nearby: 1,
      est_minutes_to_answer: 1,
    });
    expect(await sandbox.quoteTask(agent, {} as never)).toMatchObject({
      workers_nearby: 2,
      est_minutes_to_answer: 9,
    });
    expect(await sandbox.quoteTask(agent, {} as never)).toMatchObject({ workers_nearby: 0, allowed: false });
  });

  it("hires sandbox workers until one is nearby, then asks and marks the result", async () => {
    const quoteTask = vi.fn().mockResolvedValueOnce(quote(0)).mockResolvedValueOnce(quote(1));
    const joinWorker = vi.fn(async (_worker: { phone: string }) => undefined);
    const handleWorkerReply = vi.fn(async () => undefined);
    const askEyes = vi.fn(async () => ({ task_id: "t1", next_step: "Call await_answer." }));
    const awaitAnswer = vi.fn(async () => ({ status: "verified", next_step: "Done." }));
    const { sandbox } = setup({ quoteTask, joinWorker, handleWorkerReply, askEyes, awaitAnswer });

    const asked = await sandbox.askEyes(agent, { location: where, task_type: "is_open" } as never);
    expect(asked.next_step).toContain(SANDBOX);
    expect(asked.next_step).toMatch(/Call await_answer\.$/);
    expect(joinWorker).toHaveBeenCalledTimes(1);
    const phone = joinWorker.mock.calls[0]?.[0].phone ?? "";
    expect(phone).toMatch(/^\+1[2-9]\d{2}55501\d{2}$/);
    expect(handleWorkerReply).toHaveBeenCalledWith({ phone, intent: "start", text: "START" });

    const answered = await sandbox.awaitAnswer(agent, { task_id: "t1" } as never, undefined as never);
    expect(answered.next_step).toContain(SANDBOX);
  });

  it("stops hiring after three tries and still asks when hiring fails", async () => {
    const quoteTask = vi.fn(async () => quote(0));
    const joinWorker = vi.fn(async () => undefined);
    const askEyes = vi.fn(async () => ({ next_step: "x" }));
    const { sandbox } = setup({ quoteTask, joinWorker, handleWorkerReply: async () => undefined, askEyes });

    await sandbox.askEyes(agent, { location: where, task_type: "is_open" } as never);
    expect(joinWorker).toHaveBeenCalledTimes(3);

    quoteTask.mockRejectedValueOnce(new Error("down"));
    await expect(
      sandbox.askEyes(agent, { location: where, task_type: "is_open" } as never),
    ).resolves.toBeDefined();
    expect(askEyes).toHaveBeenCalledTimes(2);
  });

  it("times out a stuck ask and rejects asks beyond the queue limit", async () => {
    vi.useFakeTimers();
    const askEyes = vi.fn(() => new Promise<never>(() => {}));
    const { sandbox } = setup({ quoteTask: async () => quote(1), askEyes });

    const asks = Array.from({ length: 50 }, () =>
      sandbox.askEyes(agent, { location: where, task_type: "is_open" } as never),
    );
    const settled = asks.map((p) => p.catch((err: unknown) => err));
    await expect(sandbox.askEyes(agent, { location: where } as never)).rejects.toMatchObject({
      code: "rate_limited",
      message: "The sandbox already has 50 asks waiting.",
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(await settled[0]).toMatchObject({
      code: "rate_limited",
      message: "The sandbox ask took too long.",
    });
  });
});

describe("keylessAgents", () => {
  let now = 0;
  const make = (service: Record<string, Fn>) =>
    keylessAgents({
      service,
      config: { link_secret: "sandbox-unit-link-secret-0123456789" },
      providers: { clock: { now: () => new Date(now) } },
    } as unknown as RouteDeps);
  const fakeService = () => {
    let n = 0;
    return {
      signupAgent: vi.fn(async () => {
        n += 1;
        return { agent_id: `a${n}`, api_key: `k${n}` };
      }),
      updateSpendPolicy: vi.fn(async () => undefined),
      authenticate: vi.fn(async (key: string) => ({ id: key, balance_cents: 0 })),
      creditTopup: vi.fn(async () => undefined),
    };
  };
  beforeEach(() => {
    now = 1_000_000_000;
  });

  it("creates and reuses one agent per address, topping up low balances", async () => {
    const service = fakeService();
    const keyless = make(service);

    expect(await keyless("1.1.1.1")).toMatchObject({ id: "k1" });
    expect(service.updateSpendPolicy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ max_bounty_usd: 10, daily_cap_usd: 1000 }),
    );
    expect(service.creditTopup).toHaveBeenCalledWith(
      expect.objectContaining({ agent_id: "k1", amount_cents: 100_000 }),
    );

    service.authenticate.mockResolvedValueOnce({ id: "k1", balance_cents: 100_000 });
    expect(await keyless("1.1.1.1")).toMatchObject({ id: "k1" });
    expect(service.signupAgent).toHaveBeenCalledTimes(1);
    expect(service.creditTopup).toHaveBeenCalledTimes(1);
  });

  it("forgets keys that no longer authenticate or failed to create", async () => {
    const service = fakeService();
    const keyless = make(service);

    service.authenticate.mockResolvedValueOnce(null as never).mockResolvedValueOnce(null as never);
    expect(await Promise.all([keyless("2.2.2.2"), keyless("2.2.2.2")])).toEqual([null, null]);
    expect(await keyless("2.2.2.2")).toMatchObject({ id: "k2" });

    service.signupAgent.mockRejectedValueOnce(new Error("db down"));
    await expect(keyless("3.3.3.3")).rejects.toThrow("db down");
    expect(await keyless("3.3.3.3")).toMatchObject({ id: "k3" });
  });

  it("evicts agents older than an hour", async () => {
    const service = fakeService();
    const keyless = make(service);

    await keyless("4.4.4.4");
    now += 60 * 60 * 1000 + 1;
    expect(await keyless("4.4.4.4")).toMatchObject({ id: "k2" });
    expect(service.signupAgent).toHaveBeenCalledTimes(2);
  });

  it("rate limits new keyless agents per minute", async () => {
    const service = fakeService();
    const keyless = make(service);

    for (let i = 0; i < 30; i++) await keyless(`10.0.0.${i}`);
    now += 20_000;
    await expect(keyless("10.0.1.1")).rejects.toMatchObject({
      code: "rate_limited",
      context: { retry_after_s: 40 },
    });

    now += 40_001;
    expect(await keyless("10.0.1.1")).toMatchObject({ id: "k31" });
  });
});
