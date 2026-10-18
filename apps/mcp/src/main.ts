import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInkboxMessaging, createPrimitiveEmail } from "@eyes/comms";
import { AppConfig, type DbConfig, fakeProviders, type Providers } from "@eyes/core";
import { createInsforgeStorage, createRpc } from "@eyes/db";
import { createEyesService } from "@eyes/engine";
import { createStripePayments } from "@eyes/payments";
import { createAssessTask } from "@eyes/safety";
import { createClaudeVision, createClefVision, verifySubmission } from "@eyes/verify";
import {
  captureConsole,
  clickHouseConfig,
  createClickHouseSink,
  createEventLog,
  mirrorTriggerEvents,
} from "@eyes/web-dashboard";
import { z } from "zod";
import { createNominatimGeo } from "./geo.ts";
import { toNodeListener } from "./http.ts";
import { instrumentAssess, instrumentProviders, instrumentService } from "./instrument.ts";
import { createServer, liveProviders } from "./server.ts";

const EXPIRE_EVERY_MS = 30_000;

function exit(message: string): never {
  console.error(message);
  process.exit(1);
}

const env = process.env;

const live = liveProviders(env);

const parsed = AppConfig.safeParse({
  public_api_url: env.EYES_PUBLIC_API_URL,
  worker_web_url: env.EYES_WORKER_WEB_URL,
  link_secret: env.EYES_LINK_SECRET,
  test_mode: env.EYES_TEST_MODE ? env.EYES_TEST_MODE === "true" : undefined,
  dispatch_radius_m: env.EYES_DISPATCH_RADIUS_M ? Number(env.EYES_DISPATCH_RADIUS_M) : undefined,
  location_max_age_h: env.EYES_LOCATION_MAX_AGE_H ? Number(env.EYES_LOCATION_MAX_AGE_H) : undefined,
  location_ping: env.EYES_LOCATION_PING ? env.EYES_LOCATION_PING === "true" : undefined,
  location_min_interval_s: env.EYES_LOCATION_MIN_INTERVAL_S
    ? Number(env.EYES_LOCATION_MIN_INTERVAL_S)
    : undefined,
  location_daily_max: env.EYES_LOCATION_DAILY_MAX ? Number(env.EYES_LOCATION_DAILY_MAX) : undefined,
  testflight_url: env.EYES_TESTFLIGHT_URL || undefined,
  email_domain: env.PRIMITIVE_DOMAIN || undefined,
  email_delivery: live.email,
  live_payouts: live.payments,
});
if (!parsed.success) exit(`Invalid EYES_* environment (see .env.example):\n${z.prettifyError(parsed.error)}`);
const config = parsed.data;

const clef = Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
if (env.EYES_PROVIDERS === "live" && !clef && !env.ANTHROPIC_API_KEY) {
  exit(
    "EYES_PROVIDERS=live needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (clef) or ANTHROPIC_API_KEY: without one the safety classifier and photo verification are off. Set them, or run with EYES_PROVIDERS=fake.",
  );
}
if (env.EYES_PROVIDERS === "live" && Boolean(env.INSFORGE_BASE_URL) !== Boolean(env.INSFORGE_API_KEY)) {
  exit(
    "Live photo storage needs both INSFORGE_BASE_URL and INSFORGE_API_KEY. Set both, or unset both to keep fake storage.",
  );
}
if (env.EYES_OPS_KEY && env.EYES_OPS_KEY.length < 32) {
  exit(
    "EYES_OPS_KEY must be at least 32 random characters. Leave it empty to turn off the break-glass ops link.",
  );
}
const port = env.PORT ? Number(env.PORT) : 3000;
if ((env.PORT && !/^\d+$/.test(env.PORT)) || port > 65535) {
  exit(`PORT must be an integer from 0 to 65535, got "${env.PORT}".`);
}

const db: DbConfig = env.DATABASE_URL
  ? { kind: "postgres", url: env.DATABASE_URL }
  : env.INSFORGE_BASE_URL && env.INSFORGE_API_KEY
    ? { kind: "insforge", base_url: env.INSFORGE_BASE_URL, api_key: env.INSFORGE_API_KEY }
    : exit("Set DATABASE_URL, or INSFORGE_BASE_URL and INSFORGE_API_KEY.");

const fakes = fakeProviders();
const providers: Providers = {
  messaging: live.messaging ? createInkboxMessaging(env) : fakes.messaging,
  email: live.email ? createPrimitiveEmail(env) : fakes.email,
  payments: live.payments ? createStripePayments(env) : fakes.payments,
  storage: live.storage ? createInsforgeStorage(env) : fakes.storage,
  vision: live.vision ? (clef ? createClefVision(env) : createClaudeVision(env)) : fakes.vision,
  geo: live.geo ? createNominatimGeo() : fakes.geo,
  clock: { now: () => new Date() },
};
for (const name of Object.keys(live) as (keyof typeof live)[])
  console.log(`provider ${name}: ${providers[name] === fakes[name] ? "FAKE" : "live"}`);
console.log(`db: ${db.kind}`);

const rpc = createRpc(db);
const chConfig = clickHouseConfig(env);
const clickhouse = chConfig ? createClickHouseSink(chConfig) : undefined;
if (clickhouse) mirrorTriggerEvents(rpc, clickhouse.push);
console.log(`clickhouse: ${chConfig ? `${chConfig.url} (${chConfig.database})` : "off"}`);
const events = createEventLog(rpc, 500, 2000, clickhouse ? [clickhouse.push] : []);
captureConsole(events.log);
const logged = instrumentProviders(providers, events.log);

const engine = createEyesService({
  db,
  providers: logged,
  assessTask: instrumentAssess(createAssessTask(env), events.log),
  verifySubmission,
  config,
});
const service = instrumentService(engine, events.log);

setInterval(() => {
  service.expireOverdue().catch((err) => console.error("expireOverdue failed", err));
  service.retryPayouts().catch((err) => console.error("retryPayouts failed", err));
}, EXPIRE_EVERY_MS);

const server = createServer({ service, providers: logged, config, env, rpc, events, clickhouse });
const host = env.HOST || "0.0.0.0";
const http = createHttpServer(toNodeListener(server.fetch));
http.listen(port, host, () => {
  const bound = (http.address() as AddressInfo).port;
  console.log(`Eyes MCP listening on http://${host}:${bound}/mcp`);
});
