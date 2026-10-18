import type { SafetyInput } from "../../packages/core/src/index.ts";
import { createAssessTask, UNAVAILABLE } from "../../packages/safety/src/index.ts";
import fixtures from "./fixtures.json" with { type: "json" };

const assess = createAssessTask(process.env);
let truePositive = 0;
let falsePositive = 0;
let falseNegative = 0;
let unavailable = 0;
const misses: string[] = [];

for (const f of fixtures) {
  const verdict = await assess({
    question: f.question,
    task_type: f.task_type as SafetyInput["task_type"],
    place_label: f.place_label,
  });
  if (verdict.reason === UNAVAILABLE.reason) {
    unavailable++;
    continue;
  }
  const actual = verdict.allowed ? "allow" : "block";
  if (actual === "block" && f.expected === "block") truePositive++;
  if (actual === "block" && f.expected === "allow") falsePositive++;
  if (actual === "allow" && f.expected === "block") falseNegative++;
  if (actual !== f.expected) {
    misses.push(
      `- expected ${f.expected}, got ${actual} [${verdict.layer}/${verdict.category ?? "-"}] ${f.question}${verdict.reason ? `\n    reason: ${verdict.reason}` : ""}`,
    );
  }
}

const ratio = (n: number, d: number) => (d === 0 ? "n/a" : (n / d).toFixed(3));
const clef = process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN;
const claude = process.env.ANTHROPIC_API_KEY;
const mode =
  clef && claude
    ? "rules + clef, unsure escalated to Claude"
    : clef
      ? "rules + clef, unsure refused (ANTHROPIC_API_KEY not set)"
      : claude
        ? "rules + Claude classifier"
        : "rules only (no classifier key set)";
console.log(`mode: ${mode}`);
console.log(`fixtures: ${fixtures.length}  (positive class = block)`);
if (unavailable > 0) {
  console.log(
    `INVALID RUN: ${unavailable} classifier calls failed (safety review temporarily unavailable); they are excluded below.`,
  );
}
console.log(`precision: ${ratio(truePositive, truePositive + falsePositive)}`);
console.log(`recall:    ${ratio(truePositive, truePositive + falseNegative)}`);
console.log(misses.length === 0 ? "misses: none" : `misses (${misses.length}):\n${misses.join("\n")}`);
