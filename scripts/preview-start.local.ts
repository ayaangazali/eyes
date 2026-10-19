// One-off (not committed): texts "[Preview] " + the real START reply to the opted-in worker whose
// phone ends in 98, through the live Inkbox sender with short links. Prints no phone, code or link.
import { createInkboxMessaging } from "@eyes/comms";
import { AppConfig, fakeProviders } from "@eyes/core";
import { createRpc, type Rpc } from "@eyes/db";
import { createEyesService } from "@eyes/engine";
import { withShortLinks } from "../apps/mcp/src/short-links.ts";

const env = process.env;
const base = env.INSFORGE_BASE_URL ?? "";
const key = env.INSFORGE_API_KEY ?? "";
const config = AppConfig.parse({
  public_api_url: env.EYES_PUBLIC_API_URL,
  worker_web_url: env.EYES_WORKER_WEB_URL,
  link_secret: env.EYES_LINK_SECRET,
  test_mode: env.EYES_TEST_MODE === "true",
  location_max_age_h: env.EYES_LOCATION_MAX_AGE_H ? Number(env.EYES_LOCATION_MAX_AGE_H) : undefined,
  testflight_url: env.EYES_TESTFLIGHT_URL || undefined,
  live_payouts: true,
});
const res = await fetch(
  `${base}/api/database/records/workers?select=id,phone,opted_in,banned&opted_in=eq.true&phone=like.*98`,
  { headers: { authorization: `Bearer ${key}` } },
);
const rows = (await res.json()) as { id: string; phone: string; banned: boolean }[];
console.log(`lookup ${res.status}: ${rows.length} opted-in worker(s) ending in 98`);
if (rows.length !== 1 || rows[0]?.banned) process.exit(1);
const phone = rows[0]?.phone ?? "";

const dbRpc = createRpc({ kind: "insforge", base_url: base, api_key: key });
// The worker is already in: skip the opt-in write so the preview changes nothing but a new app code.
const rpc: Rpc = async (fn, args) => (fn === "eyes_set_worker_opt_in" ? [] : dbRpc(fn, args));
const now = () => new Date();
const inner = withShortLinks(createInkboxMessaging(env), rpc, config, now);
let sent = "";
const fakes = fakeProviders();
const messaging = {
  ...fakes.messaging,
  sendText: async (to: string, body: string) => {
    if (to !== phone) throw new Error("preview only goes to the operator");
    sent = `[Preview] ${body}`;
    return inner.sendText(to, sent);
  },
};
const service = createEyesService({
  db: { kind: "insforge", base_url: base, api_key: key },
  providers: { ...fakes, messaging, clock: { now } },
  assessTask: async () => ({ allowed: true }) as never,
  verifySubmission: async () => ({}) as never,
  config,
});
void rpc;
await service.handleWorkerReply({ phone, intent: "start", text: "START" });
console.log(`sent at ${new Date().toISOString()}:`);
console.log(sent.replace(/https:\/\/\S+/g, "<link>"));
