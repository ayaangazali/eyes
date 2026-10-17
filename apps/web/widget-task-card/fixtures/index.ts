import type { CardData, CardState } from "../src/types.ts";
import answered from "./answered.json" with { type: "json" };
import cached from "./cached.json" with { type: "json" };
import claimed from "./claimed.json" with { type: "json" };
import dispatched from "./dispatched.json" with { type: "json" };
import error from "./error.json" with { type: "json" };
import expired_refunded from "./expired_refunded.json" with { type: "json" };
import needs_review from "./needs_review.json" with { type: "json" };
import quote from "./quote.json" with { type: "json" };
import rejected_safety from "./rejected_safety.json" with { type: "json" };
import verifying from "./verifying.json" with { type: "json" };

export const FIXTURES = {
  quote,
  cached,
  dispatched,
  claimed,
  verifying,
  answered,
  needs_review,
  expired_refunded,
  rejected_safety,
  error,
} as Record<CardState, CardData>;

export const DEMO = [quote, dispatched, claimed, verifying, answered] as CardData[];
