import type { SafetyInput } from "../../packages/core/src/index.ts";
import { createAssessTask } from "../../packages/safety/src/index.ts";
import fixtures from "./fixtures.json" with { type: "json" };

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("ANTHROPIC_API_KEY is not set; skipping the safety classifier eval.");
  process.exit(0);
}

const assess = createAssessTask(process.env);
let truePositive = 0;
let falsePositive = 0;
let falseNegative = 0;
const misses: string[] = [];

for (const f of fixtures) {
  const verdict = await assess({
    question: f.question,
    task_type: f.task_type as SafetyInput["task_type"],
    place_label: f.place_label,
  });
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
console.log(`fixtures: ${fixtures.length}  (positive class = block)`);
console.log(`precision: ${ratio(truePositive, truePositive + falsePositive)}`);
console.log(`recall:    ${ratio(truePositive, truePositive + falseNegative)}`);
console.log(misses.length === 0 ? "misses: none" : `misses (${misses.length}):\n${misses.join("\n")}`);
