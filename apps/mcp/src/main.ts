import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInkboxMessaging, createPrimitiveEmail } from "@eyes/comms";
import { AppConfig, type DbConfig, fakeProviders, type Providers } from "@eyes/core";
import { createInsforgeStorage } from "@eyes/db";
import { createEyesService } from "@eyes/engine";
import { createStripePayments } from "@eyes/payments";
import { createAssessTask } from "@eyes/safety";
import { createClaudeVision, verifySubmission } from "@eyes/verify";
import { z } from "zod";
import { createNominatimGeo } from "./geo.ts";
import { toNodeListener } from "./http.ts";
import { createServer, liveProviders } from "./server.ts";

const EXPIRE_EVERY_MS = 30_000;

function exit(message: string): never {
  console.error(message);
  process.exit(1);
}

const env = process.env;

const parsed = AppConfig.safeParse({
  public_api_url: env.EYES_PUBLIC_API_URL,
  worker_web_url: env.EYES_WORKER_WEB_URL,
  link_secret: env.EYES_LINK_SECRET,
  test_mode: env.EYES_TEST_MODE ? env.EYES_TEST_MODE === "true" : undefined,
  email_domain: env.PRIMITIVE_DOMAIN || undefined,
});
if (!parsed.success) exit(`Invalid EYES_* environment (see .env.example):\n${z.prettifyError(parsed.error)}`);
const config = parsed.data;

if (env.EYES_PROVIDERS === "live" && !env.ANTHROPIC_API_KEY) {
  exit(
    "EYES_PROVIDERS=live needs ANTHROPIC_API_KEY: without it the safety classifier and photo verification are off. Set ANTHROPIC_API_KEY, or run with EYES_PROVIDERS=fake.",
  );
}
if (env.EYES_PROVIDERS === "live" && Boolean(env.INSFORGE_BASE_URL) !== Boolean(env.INSFORGE_API_KEY)) {
  exit(
    "Live photo storage needs both INSFORGE_BASE_URL and INSFORGE_API_KEY. Set both, or unset both to keep fake storage.",
  );
}

const db: DbConfig = env.DATABASE_URL
  ? { kind: "postgres", url: env.DATABASE_URL }
  : env.INSFORGE_BASE_URL && env.INSFORGE_API_KEY
    ? { kind: "insforge", base_url: env.INSFORGE_BASE_URL, api_key: env.INSFORGE_API_KEY }
    : exit("Set DATABASE_URL, or INSFORGE_BASE_URL and INSFORGE_API_KEY.");

const live = liveProviders(env);
const fakes = fakeProviders();
const providers: Providers = {
  messaging: live.messaging ? createInkboxMessaging(env) : fakes.messaging,
  email: live.email ? createPrimitiveEmail(env) : fakes.email,
  payments: live.payments ? createStripePayments(env) : fakes.payments,
  storage: live.storage ? createInsforgeStorage(env) : fakes.storage,
  vision: live.vision ? createClaudeVision(env) : fakes.vision,
  geo: live.geo ? createNominatimGeo() : fakes.geo,
  clock: { now: () => new Date() },
};
for (const [name, isLive] of Object.entries(live))
  console.log(`provider ${name}: ${isLive ? "live" : "FAKE"}`);
console.log(`db: ${db.kind}`);

const service = createEyesService({
  db,
  providers,
  assessTask: createAssessTask(env),
  verifySubmission,
  config,
});

setInterval(() => {
  service.expireOverdue().catch((err) => console.error("expireOverdue failed", err));
}, EXPIRE_EVERY_MS);

const server = createServer({ service, providers, config, env });
const host = env.HOST || "0.0.0.0";
const http = createHttpServer(toNodeListener(server.fetch));
http.listen(env.PORT ? Number(env.PORT) : 3000, host, () => {
  const { port } = http.address() as AddressInfo;
  console.log(`Eyes MCP listening on http://${host}:${port}/mcp`);
});
