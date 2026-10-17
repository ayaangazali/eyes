import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AskEyesInput,
  AwaitAnswerInput,
  agentEmailAddress,
  agentIdFromEmailAddress,
  distanceMeters,
  ERRORS,
  EyesError,
  FAKE_STRIPE_SIGNATURE,
  fakePayments,
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
    expect(schemas).toMatchSnapshot();
  });

  it("apply the documented ask_eyes defaults", () => {
    const parsed = AskEyesInput.parse({
      question: "Is it open?",
      location: "Ferry Building",
      task_type: "is_open",
    });
    expect(parsed).toMatchObject({ bounty_usd: 3, deadline_minutes: 30, require_photo: true });
  });

  it("cap await_answer below client and gateway timeouts", () => {
    expect(AwaitAnswerInput.parse({ task_id: crypto.randomUUID() }).timeout_seconds).toBe(50);
    expect(() => AwaitAnswerInput.parse({ task_id: crypto.randomUUID(), timeout_seconds: 120 })).toThrow();
  });
});

describe("error catalog", () => {
  it("gives every code a status, message and fix", () => {
    for (const [code, e] of Object.entries(ERRORS)) {
      expect(e.status, code).toBeGreaterThanOrEqual(400);
      expect(e.message.length, code).toBeGreaterThan(10);
      expect(e.fix.length, code).toBeGreaterThan(10);
    }
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
