import { liveProviders } from "../apps/mcp/src/server.ts";
import { createInkboxMessaging } from "../packages/comms/src/index.ts";
import { AppConfig, type DbConfig, EyesError, fakeProviders } from "../packages/core/src/index.ts";
import { createEyesService } from "../packages/engine/src/index.ts";
import { createStripePayments } from "../packages/payments/src/index.ts";
import { createAssessTask } from "../packages/safety/src/index.ts";
import { verifySubmission } from "../packages/verify/src/index.ts";

const [taskId = "", decision, note = ""] = process.argv.slice(2);
const env = process.env;

function exit(message: string): never {
  console.error(message);
  process.exit(1);
}

if (!taskId || (decision !== "refund" && decision !== "release") || !note.trim()) {
  exit(
    'Usage: node scripts/resolve-task.ts <task_id> refund|release "<note>"\nRun it with the same EYES_*, database, STRIPE_* and INKBOX_* env as the server.',
  );
}

const live = liveProviders(env);
if (!(live.payments && live.messaging) && env.EYES_PROVIDERS !== "fake") {
  exit(
    "Refusing to resolve with fake payments or messaging: a release would record a fake payout. Set EYES_PROVIDERS=live with STRIPE_SECRET_KEY and INKBOX_API_KEY as on the server, or EYES_PROVIDERS=fake for a local test database.",
  );
}

const db: DbConfig = env.DATABASE_URL
  ? { kind: "postgres", url: env.DATABASE_URL }
  : env.INSFORGE_BASE_URL && env.INSFORGE_API_KEY
    ? { kind: "insforge", base_url: env.INSFORGE_BASE_URL, api_key: env.INSFORGE_API_KEY }
    : exit("Set DATABASE_URL, or INSFORGE_BASE_URL and INSFORGE_API_KEY.");

const fakes = fakeProviders();
console.log(`payments: ${live.payments || "FAKE"}, messaging: ${live.messaging ? "live" : "FAKE"}`);

const service = createEyesService({
  db,
  providers: {
    ...fakes,
    messaging: live.messaging ? createInkboxMessaging(env) : fakes.messaging,
    payments: live.payments ? createStripePayments(env) : fakes.payments,
    clock: { now: () => new Date() },
  },
  assessTask: createAssessTask(env),
  verifySubmission,
  config: AppConfig.parse({
    public_api_url: env.EYES_PUBLIC_API_URL,
    worker_web_url: env.EYES_WORKER_WEB_URL,
    link_secret: env.EYES_LINK_SECRET,
    test_mode: env.EYES_TEST_MODE ? env.EYES_TEST_MODE === "true" : undefined,
    email_domain: env.PRIMITIVE_DOMAIN || undefined,
    live_payouts: live.payments === "live",
  }),
});

try {
  console.log(JSON.stringify(await service.resolveTask(taskId, decision, note)));
  process.exit(0);
} catch (err) {
  exit(err instanceof EyesError ? JSON.stringify(err.toBody()) : String(err));
}
