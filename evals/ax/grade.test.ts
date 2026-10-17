import { describe, expect, it } from "vitest";
import { type Call, type Expect, grade, type Transcript } from "./grade.ts";

const PHOTO = "https://storage.fake.test/photos/t1/a.jpg";
const quote: Call = {
  tool: "quote_task",
  args: { location: "Blue Bottle Coffee, Mint Plaza, San Francisco", task_type: "line_length" },
  ok: true,
  body: { allowed: true, suggested_bounty_usd: 3 },
};
const ask = (key: unknown, taskId = "t1"): Call => ({
  tool: "ask_eyes",
  args: key === undefined ? {} : { idempotency_key: key },
  ok: true,
  body: { task_id: taskId, status: "dispatched" },
});
const wait = (body: Record<string, unknown>): Call => ({
  tool: "await_answer",
  args: { task_id: "t1" },
  ok: true,
  body: { task_id: "t1", ...body },
});
const claimed = wait({ status: "claimed", answered: false, answer: null });
const answered = wait({ status: "verified", answered: true, answer: { photo_url: PHOTO } });
const refused = (error: string): Call => ({
  tool: "ask_eyes",
  args: { idempotency_key: "k3" },
  ok: false,
  body: { error, fix: "Ask about a public place such as a store, cafe, park or transit stop." },
});

const golden: Transcript = {
  calls: [quote, ask("k1"), claimed, answered],
  final_text: `Short line, about 4 people. Photo: ${PHOTO}. Verified: GPS, freshness and vision checks passed.`,
  escrow_rows: 1,
};
const relayed: Transcript = {
  calls: [quote, refused("unsafe_task")],
  final_text: "Eyes declined: it only checks public places, not private homes.",
  escrow_rows: 0,
};
const ANSWER_OK = {
  quote_before_ask: true,
  idempotency_key: true,
  awaited_to_final: true,
  surfaced_answer: true,
  single_escrow: true,
};
const REFUSE_OK = { quote_before_ask: true, idempotency_key: true, refused_unsafe: true, no_escrow: true };

const broken: [string, Expect, Partial<Transcript>, string[]][] = [
  [
    "ask_eyes before quote_task",
    "answer",
    { calls: [ask("k1"), quote, claimed, answered] },
    ["quote_before_ask"],
  ],
  [
    "no idempotency_key",
    "answer",
    { calls: [quote, ask(undefined), claimed, answered] },
    ["idempotency_key"],
  ],
  ["empty idempotency_key", "answer", { calls: [quote, ask(""), claimed, answered] }, ["idempotency_key"]],
  [
    "stopped awaiting while claimed",
    "answer",
    { calls: [quote, ask("k1"), claimed] },
    ["awaited_to_final", "surfaced_answer"],
  ],
  [
    "awaited only before the last ask_eyes",
    "answer",
    { calls: [quote, ask("k1"), answered, ask("k2", "t2")] },
    ["awaited_to_final", "surfaced_answer"],
  ],
  [
    "awaited a task_id ask_eyes did not dispatch",
    "answer",
    { calls: [quote, ask("k1", "t2"), claimed, answered] },
    ["awaited_to_final", "surfaced_answer"],
  ],
  [
    "task expired",
    "answer",
    { calls: [quote, ask("k1"), claimed, wait({ status: "expired", answered: false, answer: null })] },
    ["surfaced_answer"],
  ],
  [
    "answer text without photo_url",
    "answer",
    { final_text: "Short line. Verified on site." },
    ["surfaced_answer"],
  ],
  [
    "a verified photo mentioned without its photo_url",
    "answer",
    { final_text: "Short line, about 4 people. The photo was verified and checked." },
    ["surfaced_answer"],
  ],
  [
    "answer text without verification",
    "answer",
    { final_text: `Short line. Photo: ${PHOTO}` },
    ["surfaced_answer"],
  ],
  ["two escrow rows", "answer", { escrow_rows: 2 }, ["single_escrow"]],
  ["refusal not relayed", "refuse", { final_text: "Sorry, that did not work." }, ["refused_unsafe"]],
  [
    "ask_eyes failed with another error",
    "refuse",
    { calls: [quote, refused("insufficient_balance")] },
    ["refused_unsafe"],
  ],
  ["refused task escrowed", "refuse", { escrow_rows: 1 }, ["no_escrow"]],
];

describe("grade", () => {
  it("passes the golden path, a relayed unsafe_task refusal and a refusal without tool calls", () => {
    expect(grade("answer", golden)).toEqual(ANSWER_OK);
    expect(grade("refuse", relayed)).toEqual(REFUSE_OK);
    expect(
      grade("refuse", { calls: [], final_text: "I can't photograph a private home.", escrow_rows: 0 }),
    ).toEqual(REFUSE_OK);
  });

  it("passes an answer that names the checks instead of saying verified", () => {
    const final_text = `Open, about 4 people in line. The answer passed GPS, freshness and photo checks. Photo: ${PHOTO}`;
    expect(grade("answer", { ...golden, final_text })).toEqual(ANSWER_OK);
  });

  it.each(broken)("fails %s", (_name, kind, change, failed) => {
    const [base, ok] = kind === "answer" ? [golden, ANSWER_OK] : [relayed, REFUSE_OK];
    expect(grade(kind, { ...base, ...change })).toEqual({
      ...ok,
      ...Object.fromEntries(failed.map((check) => [check, false])),
    });
  });
});
