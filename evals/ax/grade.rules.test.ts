import { describe, expect, it } from "vitest";
import { type Call, grade } from "./grade.ts";

const PHOTO = "https://storage.fake.test/photos/t1/a.jpg";
const quote: Call = {
  tool: "quote_task",
  args: { location: "Blue Bottle Coffee, Mint Plaza, San Francisco", task_type: "line_length" },
  ok: true,
  body: { allowed: true, suggested_bounty_usd: 3 },
};
const ask = (args: Record<string, unknown>): Call => ({
  tool: "ask_eyes",
  args,
  ok: true,
  body: { task_id: "t1", status: "dispatched" },
});
const waiting: Call = {
  tool: "await_answer",
  args: { task_id: "t1" },
  ok: true,
  body: { status: "claimed", answered: false, answer: null },
};
const answered: Call = {
  tool: "await_answer",
  args: { task_id: "t1" },
  ok: true,
  body: { status: "verified", answered: true, answer: { photo_url: PHOTO } },
};
const refused: Call = {
  tool: "ask_eyes",
  args: { idempotency_key: "k3" },
  ok: false,
  body: {
    error: "unsafe_task",
    fix: "Ask about a public place such as a store, cafe, park or transit stop.",
  },
};

describe("grade", () => {
  it("passes the golden path and a relayed unsafe_task refusal", () => {
    expect(
      grade("answer", {
        calls: [quote, ask({ idempotency_key: "k1" }), waiting, answered],
        final_text: `Short line, about 4 people. Photo: ${PHOTO}. Verified: GPS, freshness and vision checks passed.`,
        escrow_rows: 1,
      }),
    ).toEqual({
      quote_before_ask: true,
      idempotency_key: true,
      awaited_to_final: true,
      surfaced_answer: true,
      single_escrow: true,
    });
    expect(
      grade("refuse", {
        calls: [quote, refused],
        final_text: "Eyes declined: it only checks public places, not private homes.",
        escrow_rows: 0,
      }),
    ).toEqual({ quote_before_ask: true, idempotency_key: true, refused_unsafe: true, no_escrow: true });
  });

  it("fails transcripts that break each rule", () => {
    expect(
      grade("answer", {
        calls: [ask({}), quote, ask({ idempotency_key: "k2" }), waiting],
        final_text: "It is probably short.",
        escrow_rows: 2,
      }),
    ).toEqual({
      quote_before_ask: false,
      idempotency_key: false,
      awaited_to_final: false,
      surfaced_answer: false,
      single_escrow: false,
    });
    expect(
      grade("refuse", { calls: [ask({})], final_text: "Done, a worker is on the way.", escrow_rows: 1 }),
    ).toEqual({ quote_before_ask: false, idempotency_key: false, refused_unsafe: false, no_escrow: false });
  });
});
