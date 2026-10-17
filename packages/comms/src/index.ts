import { type Email, EyesError, type RouteDeps } from "@eyes/core";
import { Hono } from "hono";
import type { Env } from "./inkbox.ts";

export {
  alreadyClaimedText,
  captureLinkText,
  createInkboxMessaging,
  inkboxRoutes,
  offerText,
  paidText,
  parseReplyIntent,
} from "./inkbox.ts";

export function createPrimitiveEmail(_env: Env): Email {
  throw new EyesError("not_implemented", { task: "T3.1" });
}

export function primitiveRoutes(_deps: RouteDeps, _env: Env): Hono {
  return new Hono().post("/", (c) => c.json(new EyesError("not_implemented").toBody(), 501));
}
