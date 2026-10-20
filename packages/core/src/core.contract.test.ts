import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AskEyesInput,
  AwaitAnswerInput,
  agentEmailAddress,
  agentIdFromEmailAddress,
  CaptureFields,
  distanceMeters,
  ERRORS,
  EyesError,
  FAKE_STRIPE_SIGNATURE,
  fakePayments,
  JoinWorkerInput,
  ReportClassifierInput,
  SignupInput,
  signToken,
  TOOLS,
  toErrorBody,
  usdToCents,
  verifyToken,
} from "./index.ts";

describe("tool schemas", () => {
  it("match the committed snapshot", () => {
    const schemas = Object.fromEntries(
      Object.entries(TOOLS).map(([name, t]) => [
        name,
        { input: z.toJSONSchema(t.input, { io: "input" }), output: z.toJSONSchema(t.output) },
      ]),
    );
    expect(
      JSON.parse(
        JSON.stringify(schemas, (key, value) =>
          key === "description" && typeof value === "string" ? undefined : value,
        ),
      ),
    ).toMatchSnapshot();
  });

  it("apply the documented ask_eyes defaults", () => {
    const parsed = AskEyesInput.parse({
      question: "Is it open?",
      location: "Ferry Building",
      task_type: "is_open",
      idempotency_key: "k1",
    });
    expect(parsed).toMatchObject({ bounty_usd: 3, deadline_minutes: 30, require_photo: true });
  });

  it("rejects NUL and lone surrogates without rejecting valid Unicode", () => {
    const input = {
      question: "Is the café open? ☕ 😀",
      location: "Café 😀, Paris",
      task_type: "is_open",
      idempotency_key: "café-😀",
    };
    expect(AskEyesInput.parse(input).question).toBe(input.question);
    for (const bad of ["\u0000", "\ud800", "\udfff", "\ud800x\udfff"]) {
      for (const field of ["question", "location", "idempotency_key"]) {
        const result = AskEyesInput.safeParse({ ...input, [field]: `prefix${bad}suffix` });
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.issues[0]?.path).toEqual([field]);
      }
    }
  });

  it("checks free-text fields in signup, worker capture, disputes and classifier reports", () => {
    for (const text of ["Café 😀", "Cafe\u0000", "Cafe\ud800", "Cafe\udfff"]) {
      const report = {
        question: "Is it open?",
        location: "Public Cafe",
        task_type: "is_open",
        idempotency_key: "report-key",
        ask_idempotency_key: "ask-key",
      };
      const cases = [
        [SignupInput, { name: text }, ["name"]],
        [JoinWorkerInput, { name: text, phone: "+15551234567", lat: 10, lng: 20 }, ["name"]],
        [
          CaptureFields,
          { lat: 10, lng: 20, accuracy_m: 1, captured_at: "2026-10-20T00:00:00Z", answer_text: text },
          ["answer_text"],
        ],
        [
          TOOLS.dispute_answer.input,
          { task_id: "00000000-0000-4000-8000-000000000001", reason: text },
          ["reason"],
        ],
        [
          ReportClassifierInput,
          { ...report, classifier_error: { error: "unsafe_task", message: text } },
          ["classifier_error", "message"],
        ],
        [
          ReportClassifierInput,
          { ...report, classifier_error: { error: "unsafe_task", fix: text } },
          ["classifier_error", "fix"],
        ],
      ] as const;
      for (const [schema, input, path] of cases) {
        const result = schema.safeParse(input);
        expect(result.success).toBe(text === "Café 😀");
        if (!result.success) expect(result.error.issues[0]?.path).toEqual(path);
      }
    }
  });

  it("validates coordinate strings before geocoding while accepting boundary coordinates", () => {
    for (const location of ["90,180", "-90,-180", " 37.5, -122.25 ", { lat: 90, lng: -180 }]) {
      expect(TOOLS.quote_task.input.safeParse({ location, task_type: "is_open" }).success).toBe(true);
    }
    for (const location of ["95,200", "-90.1,0", "0,-180.1", { lat: 91, lng: 0 }]) {
      expect(TOOLS.quote_task.input.safeParse({ location, task_type: "is_open" }).success).toBe(false);
    }
  });

  it("cap await_answer below client and gateway timeouts", () => {
    expect(AwaitAnswerInput.parse({ task_id: crypto.randomUUID() }).timeout_seconds).toBe(50);
    expect(() => AwaitAnswerInput.parse({ task_id: crypto.randomUUID(), timeout_seconds: 120 })).toThrow();
  });
});

describe("error catalog", () => {
  it("matches the public error contract", () => {
    expect(
      Object.fromEntries(Object.entries(ERRORS).map(([code, error]) => [code, error.status])),
    ).toMatchSnapshot();
  });

  it("renders fix placeholders from context into the agent-facing body", () => {
    const body = new EyesError("insufficient_balance", {
      balance_usd: 1.2,
      needed_usd: 3.5,
      top_up_url: "https://x.test/topup",
      max_affordable_bounty_usd: 0.7,
    }).toBody();
    expect(body).toMatchObject({ error: "insufficient_balance", balance_usd: 1.2, needed_usd: 3.5 });
    expect(body.fix).toBe(
      "Ask your user to top up at https://x.test/topup, or lower bounty_usd to 0.7 or less.",
    );
  });

  it("never leaks unknown errors", () => {
    expect(toErrorBody(new Error("db password is hunter2"))).toMatchObject({ error: "internal_error" });
    expect(JSON.stringify(toErrorBody(new Error("hunter2")))).not.toContain("hunter2");
  });
});

describe("money, distance and tokens", () => {
  it("converts usd to integer cents without float drift", () => {
    expect(usdToCents(3.5)).toBe(350);
    expect(usdToCents(0.1 + 0.2)).toBe(30);
    expect(Number.isInteger(usdToCents(19.99))).toBe(true);
  });

  it("measures distance in meters", () => {
    const d = distanceMeters({ lat: 37.78246, lng: -122.40776 }, { lat: 37.79554, lng: -122.39377 });
    expect(d).toBeGreaterThan(1800);
    expect(d).toBeLessThan(2000);
  });

  it("signs, rejects tampering and expires link tokens", () => {
    const secret = "test-secret-at-least-16";
    const now = new Date("2026-10-17T19:00:00Z");
    const token = signToken(secret, "o:task:worker", new Date(now.getTime() + 60_000));
    expect(verifyToken(secret, token, now)).toBe("o:task:worker");
    expect(verifyToken("another-secret-16chars", token, now)).toBeNull();
    expect(verifyToken(secret, `${token}x`, now)).toBeNull();
    expect(verifyToken(secret, `${token}.x`, now)).toBeNull();
    expect(verifyToken(secret, `${token}.`, now)).toBeNull();
    expect(verifyToken(secret, token, new Date(now.getTime() + 61_000))).toBeNull();
  });
});

describe("fake payments", () => {
  it("rejects unsigned webhooks and keeps payouts idempotent", async () => {
    const p = fakePayments();
    await expect(p.parseWebhook("{}", "wrong")).rejects.toThrow();
    const ev = { type: "topup.completed", agent_id: "a", amount_cents: 2000, ref: "cs_1" };
    expect(await p.parseWebhook(JSON.stringify(ev), FAKE_STRIPE_SIGNATURE)).toEqual(ev);
    const payout = { account_id: "acct", amount_cents: 300, task_id: "t", idempotency_key: "payout:t" };
    const a = await p.payoutWorker(payout);
    const b = await p.payoutWorker(payout);
    expect(a).toEqual(b);
    expect(p.transfers).toHaveLength(1);
  });

  it("sends a top-up to our own done page marked simulated instead of an unreachable checkout", async () => {
    const { url } = await fakePayments().createTopupCheckout({
      agent_id: "a",
      amount_cents: 2000,
      success_url: "https://api.eyes.test/topup/done",
      cancel_url: "https://api.eyes.test/topup/cancel",
    });
    expect(url).toBe("https://api.eyes.test/topup/done?simulated=1");
  });
});

describe("agent email addresses", () => {
  it("round-trip to the agent id and reject forgeries", () => {
    const secret = "test-secret-at-least-16";
    const id = "0b5e6a52-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
    const address = agentEmailAddress(secret, id, "brave-otter.primitive.email");
    expect(address.split("@")[0]?.length).toBeLessThanOrEqual(64);
    expect(agentIdFromEmailAddress(secret, address)).toBe(id);
    expect(agentIdFromEmailAddress(secret, address.toUpperCase())).toBe(id);
    expect(agentIdFromEmailAddress("another-secret-16chars", address)).toBeNull();
    expect(agentIdFromEmailAddress(secret, address.replace(/-\w{16}@/, "-AAAAAAAAAAAAAAAA@"))).toBeNull();
    expect(agentIdFromEmailAddress(secret, "tasks@brave-otter.primitive.email")).toBeNull();
  });
});
