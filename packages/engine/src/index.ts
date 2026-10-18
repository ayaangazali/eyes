import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Agent,
  type Answer,
  agentEmailAddress,
  CaptureFields,
  centsToUsd,
  type DisputeOutcome,
  distanceMeters,
  type EngineDeps,
  ERRORS,
  EyesError,
  type EyesService,
  JoinWorkerInput,
  type LatLng,
  type LedgerType,
  OwnerPolicyInput,
  parseMapLink,
  type ReplyIntent,
  type ResolvedLocation,
  SignupInput,
  type Submission,
  signToken,
  type Task,
  type TaskStatus,
  type TaskType,
  TOOLS,
  usdToCents,
  verifyToken,
  type Worker,
  type WorkerEarnings,
  WorkerLocationInput,
} from "@eyes/core";
import { createRpc, type RpcArgs } from "@eyes/db";
import { z } from "zod";

type Detail = { task: Task; submission: Submission | null; worker_rating: number | null };
type Nearby = { worker_id: string; phone: string; distance_m: number };
type Posted = { task: Task; created: boolean; workers_notified: number };
type Payee = Worker & { stripe_account_id: string };
type Summary = {
  balance_cents: number;
  escrowed_cents: number;
  spent_today_cents: number;
  daily_cap_cents: number;
  max_bounty_cents: number;
  allowed_task_types: Agent["allowed_task_types"];
};
type ConsoleRow = Summary & {
  agent_name: string;
  tasks: {
    task_id: string;
    question: string;
    place_label: string;
    status: TaskStatus;
    bounty_cents: number;
    created_at: string;
  }[];
  ledger: { type: LedgerType; amount_cents: number; task_id: string | null; created_at: string }[];
};
type EarningsRow = {
  paid_cents: number;
  pending_cents: number;
  payouts_set_up: boolean;
  tasks: {
    task_id: string;
    question: string;
    task_type: TaskType;
    place_label: string;
    status: TaskStatus;
    bounty_cents: number;
    claimed_at: string;
    released: boolean;
    paid_at: string | null;
  }[];
};

const ANSWERED: TaskStatus[] = ["verified", "paid", "needs_review"];
const FINAL: TaskStatus[] = ["expired", "refunded", "disputed"];
const WALK_METERS_PER_MINUTE = 80;
const CAPTURE_MINUTES = 3;
const POLL_MS = 1000;
const WORKER_LINK_MS = 7 * 24 * 60 * 60 * 1000;
const PAYOUT_BATCH = 25;
// RFC 2606 and RFC 6761 reserved names: example.com/.org/.net and the .example, .test, .invalid, .localhost TLDs.
const RESERVED_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)\.?$/i;
const HERE_LINK_MS = 30 * 60 * 1000;
const DEVICE_LINK_EXPIRED = {
  message: "This install link is invalid or has expired.",
  fix: "Text HELP to the Eyes number for a fresh link.",
};
// The setup page's code (ADR-028) is the earnings token, which START and HELP renew.
const SETUP_LINK_INVALID = {
  message: "This link is invalid or has expired.",
  fix: "Text HELP to the Eyes number for a fresh link.",
};
const HOUR_MS = 3_600_000;
const PING_MAX = 5;
const PING_WAIT_MS = 30_000;
const PING_IN_INPUT = /Eyes ping ([0-9a-f]{8})/i;

const ResolveInput = z.object({
  task_id: z.uuid(),
  decision: z.enum(["refund", "release"]),
  note: z.string().trim().min(1),
});

type Ticket = { id: number | string; worker_id: string; task_id: string };
const ResolveTicketInput = z.object({
  ticket_id: z.number().int().positive(),
  outcome: z.enum(["release", "refund", "close"]),
  note: z.string().trim().min(1),
});
const DisputeDecision = z.object({
  ticket_id: z.number().int().positive(),
  note: z.string().trim().min(1).max(500),
});
type DisputeTicket = Ticket & {
  dispute_status: "open" | "upheld" | "rejected" | null;
  reversal_owed_cents: number | string | null;
};
// bigint columns may arrive as strings, so amounts are read with Number().
type FraudRow = {
  ticket: DisputeTicket;
  already: boolean;
  refund_cents: number | string | null;
  transfer_id: string | null;
  payout_cents: number | string | null;
};
const TICKET_OUTCOME: Record<z.output<typeof ResolveTicketInput>["outcome"], string> = {
  release: "Your answer was approved and you are being paid.",
  refund: "Your answer was not approved, so this task is not paid.",
  close: "",
};

const AWAIT_NEXT_STEP: Record<TaskStatus, string> = {
  dispatched:
    "No worker has claimed the task yet. Call await_answer again now with the same task_id, and keep calling until answered is true.",
  claimed:
    "A worker claimed the task and is on the way. Call await_answer again now with the same task_id, and keep calling until answered is true.",
  submitted: "A worker submitted an answer and it is being verified. Call await_answer again now.",
  verified:
    "Answered and verified. Use answer.answer_text and answer.photo_url. If the answer is wrong, call dispute_answer with a reason.",
  paid: "Answered, verified and the worker is paid. Use answer.answer_text and answer.photo_url. If the answer is wrong, call dispute_answer with a reason.",
  needs_review:
    "A worker answered but automatic verification did not pass (see answer.verification). Use the answer with care; your escrow is held until review. Call dispute_answer if it is wrong.",
  expired:
    "No worker answered before the deadline, so the full cost was refunded to your balance. Call ask_eyes again, perhaps with a higher bounty_usd or a longer deadline_minutes.",
  refunded: "This task was cancelled and refunded. Call ask_eyes to ask again.",
  disputed:
    "You disputed this answer and it is flagged for human review. Call get_task later to see the outcome.",
};

const REPLY_TEXT: Record<"no" | "released", string> = {
  no: "No problem, we will text you the next task nearby.",
  released: "Got it, the task is released. Thanks.",
};
const SIMULATED_PAY = "This is a test server and payouts are simulated, so no real money is paid.";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (s: string) => new Date(s).toISOString();
const errorName = (err: unknown) => (err instanceof Error ? err.name : typeof err);
// The payout label rule (ADR-020), shared by the earnings and setup pages so they never disagree.
const payoutOf = (
  t: EarningsRow["tasks"][number],
  payoutsSetUp: boolean,
): WorkerEarnings["tasks"][number]["payout"] =>
  t.paid_at ? "paid" : !t.released ? null : payoutsSetUp ? "pending" : "waiting_for_payout_setup";

function logFailedOffers(taskId: string, sent: PromiseSettledResult<unknown>[]) {
  for (const s of sent) {
    if (s.status === "rejected") console.error(`offer for task ${taskId} failed: ${errorName(s.reason)}`);
  }
}
const dollars = (cents: number) => `$${centsToUsd(cents).toFixed(2)}`;

const policyOf = (s: Summary) => ({
  max_bounty_usd: centsToUsd(s.max_bounty_cents),
  daily_cap_usd: centsToUsd(s.daily_cap_cents),
  spent_today_usd: centsToUsd(s.spent_today_cents),
  remaining_today_usd: centsToUsd(Math.max(0, s.daily_cap_cents - s.spent_today_cents)),
  allowed_task_types: s.allowed_task_types,
});

const MIN_BOUNTY_CENTS = 100;
const FROZEN =
  "Your user froze spending on this API key by setting its daily cap to 0, so waiting for the daily reset will not help. Do not retry; ask your user to raise daily_cap_usd in their Eyes owner console.";

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new EyesError("invalid_input", {
    issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

function answerOf({ task, submission, worker_rating }: Detail): Answer | null {
  if (!submission) return null;
  const fallback = submission.answer_bool === null ? "See photo_url." : submission.answer_bool ? "Yes" : "No";
  return {
    task_id: task.id,
    answer_text: submission.answer_text ?? fallback,
    answer_bool: submission.answer_bool,
    // A photo that failed moderation (vision_ok false) is never delivered; ops still sees it.
    photo_url: submission.vision_ok ? submission.photo_url : null,
    captured_at: iso(submission.captured_at),
    worker_distance_m: Math.round(distanceMeters(task, submission)),
    verification: {
      gps_ok: submission.gps_ok,
      fresh_ok: submission.fresh_ok,
      vision_ok: submission.vision_ok,
      vision_reason: submission.vision_reason,
    },
    confidence: submission.confidence,
    worker_rating: worker_rating ?? 0,
    cost_usd: centsToUsd(task.bounty_cents + task.fee_cents),
  };
}

export function createEyesService(deps: EngineDeps): EyesService {
  const { providers, config } = deps;
  const { messaging, payments } = providers;
  const rpc = createRpc(deps.db);
  const now = () => providers.clock.now();
  const nowIso = () => now().toISOString();
  const maybe = async <T>(fn: string, args: RpcArgs) => (await rpc<T>(fn, args))[0];
  const one = async <T>(fn: string, args: RpcArgs) => (await rpc<T>(fn, args))[0] as T;
  const simulatedPay = config.live_payouts ? "" : ` ${SIMULATED_PAY}`;

  const topUpUrl = (agentId: string) =>
    `${config.public_api_url}/topup/${signToken(config.link_secret, `t:${agentId}`)}`;
  const connectUrl = (workerId: string) =>
    `${config.public_api_url}/w/connect/${signToken(config.link_secret, `c:${workerId}`, new Date(now().getTime() + WORKER_LINK_MS))}`;
  const earningsUrl = (workerId: string) =>
    `${config.public_api_url}/w/earnings/${signToken(config.link_secret, `e:${workerId}`, new Date(now().getTime() + WORKER_LINK_MS))}`;
  // The setup page (ADR-028) takes the same "e:" token, in the fragment so no server logs it.
  const meUrl = (workerId: string) =>
    `${config.worker_web_url}/me#c=${signToken(config.link_secret, `e:${workerId}`, new Date(now().getTime() + WORKER_LINK_MS))}`;
  const captureUrl = (task: Task, workerId: string) =>
    `${config.worker_web_url}/capture.html?t=${signToken(config.link_secret, `o:${task.id}:${workerId}`, new Date(task.deadline_at))}`;
  const hereUrl = (workerId: string) =>
    `${config.worker_web_url}/here.html?t=${signToken(config.link_secret, `l:${workerId}`, new Date(now().getTime() + HERE_LINK_MS))}`;
  const maxAge = `${config.location_max_age_h} hours`;
  // A location code for one device: adds a code, the 5 newest work (the RPC name is from when it
  // replaced the one code). Returns the code so it can be texted once; only its hash is stored.
  const mintLocationCode = async (workerId: string) => {
    const code = randomBytes(32).toString("base64url");
    await one("eyes_rotate_location_token", { p_worker_id: workerId, p_token_hash: sha256(code) });
    return code;
  };
  // The code rides in the URL fragment, so no server (ours or a CDN) ever logs it. /app opens or
  // connects the app and falls back to TestFlight; without TestFlight, /install (ad hoc, T6.31).
  const installUrl = (code: string) => `${config.worker_web_url}/install#c=${code}`;
  const appUrl = (code: string) =>
    config.testflight_url ? `${config.worker_web_url}/app#c=${code}` : installUrl(code);
  // The hub text (START, HELP): links for everything, so YES and STOP are the only words to remember.
  // One step is a plain line, two are numbered, none is "You're all set".
  const hubText = (workerId: string, steps: string[]) =>
    [
      `${steps.length ? "You're in." : "You're all set."} Eyes texts you paid photo tasks near you.`,
      ...(steps.length === 1 ? steps : steps.map((s, i) => `${i + 1}. ${s}`)),
      ...(config.live_payouts ? [] : [SIMULATED_PAY]),
      `Your setup: ${meUrl(workerId)}`,
      "When a task comes, reply YES to take it. Reply STOP anytime to pause.",
    ].join("\n");
  // ponytail: in memory (one server instance); a restart allows one extra code on the next START.
  const appLinkSentAt = new Map<string, number>();
  // Steps left: the app until it sent a spot in the last 24 h, payouts until set up (none when simulated).
  const hubSteps = async (worker: Worker & { location_source?: string | null }) => {
    const steps: string[] = [];
    const appAt = worker.location_source === "app" && worker.location_at ? Date.parse(worker.location_at) : 0;
    if (now().getTime() - appAt > 24 * HOUR_MS) {
      // A second START or HELP within the hour mints no second code (each one evicts an older
      // device's); the setup page has the app button.
      const last = appLinkSentAt.get(worker.id);
      const fresh = last === undefined || now().getTime() - last >= HOUR_MS;
      if (fresh) appLinkSentAt.set(worker.id, now().getTime());
      const link = fresh ? appUrl(await mintLocationCode(worker.id)) : meUrl(worker.id);
      steps.push(`Get the app (keeps your spot fresh): ${link}`);
    }
    if (config.live_payouts) {
      const e = await maybe<EarningsRow>("eyes_worker_earnings", { p_worker_id: worker.id });
      if (!e?.payouts_set_up) steps.push(`Set up payouts: ${connectUrl(worker.id)}`);
    }
    return steps;
  };

  const newApiKey = () =>
    `${config.test_mode ? "eyes_test_" : "eyes_live_"}${randomBytes(32).toString("base64url")}`;

  const ownerUrl = (agentId: string) =>
    `${config.public_api_url}/owner/${signToken(config.link_secret, `p:${agentId}`)}`;

  function tokenPayload(token: string, kind: "t" | "c" | "o" | "p" | "e" | "l" | "d"): string | null {
    const payload = verifyToken(config.link_secret, token, now());
    return payload?.startsWith(`${kind}:`) ? payload.slice(kind.length + 1) : null;
  }

  function ownerAgentId(token: string): string {
    const agentId = tokenPayload(token, "p");
    if (!agentId) throw new EyesError("owner_link_invalid");
    return agentId;
  }

  // Names the failure for the log. The recipient and the control link stay out: error text can echo them.
  function describeSendError(err: unknown): string {
    if (!(err instanceof Error)) return "unknown";
    const status = "status" in err && err.status !== undefined ? ` status ${String(err.status)}` : "";
    return `${err.name}${status}: ${err.message.replace(/https?:\/\/\S+|\S+@\S+/g, "<redacted>").slice(0, 200)}`;
  }

  async function emailOwner(to: string, agentId: string, subject: string, intro: string): Promise<boolean> {
    // RFC 2606/6761 names never reach a mailbox (smoke and test agents sign up with them): don't try.
    if (RESERVED_EMAIL_DOMAIN.test(to.split("@").pop() ?? "")) {
      console.debug(`owner email for agent ${agentId} skipped: reserved test domain`);
      return false;
    }
    try {
      await providers.email.send({
        to,
        subject,
        text: [
          intro,
          "Eyes lets AI agents pay a nearby person a few dollars to check something in the real world right now, such as whether a store is open or how long a line is. Each task is paid from the agent's prepaid balance.",
          `Your private control link:\n${ownerUrl(agentId)}`,
          "There you can see the balance and every task, set the most the agent may pay per task, set a daily spending cap (a cap of 0 stops all spending), choose which kinds of tasks it may post, and add funds.",
          "Keep this link secret, and do not give it to your agent: anyone who has it can change these limits. The first person who pays for this agent also gets this link.",
        ].join("\n\n"),
      });
      return true;
    } catch (err) {
      if (err instanceof Error && "status" in err && err.status === 403 && /recipient/i.test(err.message)) {
        console.warn(
          `owner email for agent ${agentId} not sent: the email provider refused the recipient domain (403, outside the sending account's allowed recipients)`,
        );
      } else {
        console.error(`owner email for agent ${agentId} failed: ${describeSendError(err)}`);
      }
      return false;
    }
  }

  async function resolve(location: LatLng | string): Promise<ResolvedLocation> {
    if (typeof location !== "string") return { ...location, label: `${location.lat},${location.lng}` };
    const place = await providers.geo.geocode(location);
    if (!place) throw new EyesError("location_not_found", { location });
    return place;
  }

  const nearby = (place: LatLng, limit: number | null) =>
    rpc<Nearby>("eyes_nearby_workers", {
      p_lat: place.lat,
      p_lng: place.lng,
      p_radius_m: config.dispatch_radius_m,
      p_limit: limit,
      p_max_age: maxAge,
      p_now: nowIso(),
    });

  async function sendOffers(task: Task, workers: Nearby[]): Promise<number> {
    const sent = await Promise.allSettled(
      workers.map((w) =>
        messaging.sendOffer(w.phone, {
          task_id: task.id,
          task_type: task.task_type,
          question: task.question,
          place_label: task.place_label,
          bounty_cents: task.bounty_cents,
          distance_m: Math.round(w.distance_m),
          deadline_at: iso(task.deadline_at),
          live_payouts: config.live_payouts,
        }),
      ),
    );
    logFailedOffers(task.id, sent);
    return sent.filter((s) => s.status === "fulfilled").length;
  }

  // Too few fresh workers nearby: text the nearest stale ones a ping. Their Message automation on
  // "Eyes ping" (automation.html) or a tap on the HERE link sends a fresh fix.
  async function pingStale(place: LatLng, taskId: string | null): Promise<number> {
    const stale = await rpc<Nearby>("eyes_ping_candidates", {
      p_lat: place.lat,
      p_lng: place.lng,
      p_radius_m: config.dispatch_radius_m,
      p_limit: PING_MAX,
      p_max_age: maxAge,
      p_now: nowIso(),
    });
    if (stale.length === 0) return 0;
    const pings = stale.map((w) => ({
      nonce: randomBytes(4).toString("hex"),
      worker_id: w.worker_id,
      task_id: taskId,
    }));
    await rpc("eyes_record_pings", { p_pings: pings, p_now: nowIso() });
    const sent = await Promise.allSettled(
      stale.map((w, i) =>
        messaging.sendText(
          w.phone,
          `Eyes ping ${pings[i]?.nonce}: a paid task may be near you. Tap to update your spot: ${hereUrl(w.worker_id)}`,
        ),
      ),
    );
    for (const s of sent) if (s.status === "rejected") console.error(`ping failed: ${errorName(s.reason)}`);
    return sent.filter((s) => s.status === "fulfilled").length;
  }

  async function offerMore(task: Task) {
    const more = await rpc<Nearby>("eyes_offer_more", {
      p_task_id: task.id,
      p_radius_m: config.dispatch_radius_m,
      p_limit: config.dispatch_max_workers,
      p_max_age: maxAge,
      p_now: nowIso(),
    });
    await sendOffers(task, more);
  }

  type Fix = { lat: number; lng: number; accuracy_m?: number; source: string; captured_at?: string };
  function storeFix(workerId: string, fix: Fix, pingNonce: string | null) {
    return one<"stored" | "rate_limited" | "not_found">("eyes_store_location", {
      p_worker_id: workerId,
      p_lat: fix.lat,
      p_lng: fix.lng,
      p_accuracy_m: fix.accuracy_m ?? null,
      p_source: fix.source,
      p_captured_at: fix.captured_at ?? null,
      p_ping_nonce: pingNonce,
      p_min_interval_s: config.location_min_interval_s,
      p_daily_max: config.location_daily_max,
      p_now: nowIso(),
    });
  }

  async function detail(agent: Agent, taskId: string): Promise<Detail> {
    const found = await maybe<Detail>("eyes_task_detail", { p_task_id: taskId });
    if (!found || found.task.agent_id !== agent.id)
      throw new EyesError("task_not_found", { task_id: taskId });
    return found;
  }

  async function offer(token: string) {
    const [taskId, workerId] = tokenPayload(token, "o")?.split(":") ?? [];
    const found = taskId && (await maybe<Detail>("eyes_task_detail", { p_task_id: taskId }));
    if (!found || !workerId) throw new EyesError("offer_invalid");
    return { task: found.task, workerId };
  }

  function agentFacing(err: unknown, agentId: string): unknown {
    if (!(err instanceof EyesError)) return err;
    if (err.code === "insufficient_balance") {
      const c = err.context as { balance_cents: number; needed_cents: number };
      return new EyesError("insufficient_balance", {
        balance_usd: centsToUsd(c.balance_cents),
        needed_usd: centsToUsd(c.needed_cents),
        max_affordable_bounty_usd: centsToUsd(Math.max(0, c.balance_cents - config.fee_cents)),
        top_up_url: topUpUrl(agentId),
      });
    }
    if (err.code === "daily_cap_exceeded") {
      const c = err.context as { daily_cap_cents: number; spent_today_cents: number };
      return new EyesError(
        "daily_cap_exceeded",
        {
          daily_cap_usd: centsToUsd(c.daily_cap_cents),
          spent_today_usd: centsToUsd(c.spent_today_cents),
          remaining_today_usd: centsToUsd(Math.max(0, c.daily_cap_cents - c.spent_today_cents)),
        },
        { fix: c.daily_cap_cents === 0 ? FROZEN : undefined },
      );
    }
    return err;
  }

  async function claim(worker: Worker) {
    const result = await maybe<{ outcome: "won" | "lost" | "already_yours"; task: Task }>("eyes_claim", {
      p_worker_id: worker.id,
      p_now: nowIso(),
    });
    if (!result) {
      await messaging.sendText(
        worker.phone,
        "There is no open task for you right now. We will text you when one comes up nearby.",
      );
      return;
    }
    const { outcome, task } = result;
    if (outcome === "lost") {
      await messaging.sendAlreadyClaimed(worker.phone, { place_label: task.place_label });
      return;
    }
    await messaging.sendCaptureLink(worker.phone, {
      task_id: task.id,
      place_label: task.place_label,
      capture_url: captureUrl(task, worker.id),
      deadline_at: iso(task.deadline_at),
    });
  }

  async function textWorker(worker: Worker, taskId: string, send: () => Promise<unknown>) {
    if (!worker.opted_in) return;
    await send().catch((err) =>
      console.error(`text to the worker for task ${taskId} failed: ${errorName(err)}`),
    );
  }

  const notifyPaid = (task: Task, worker: Worker) =>
    textWorker(worker, task.id, () =>
      messaging.sendPaid(worker.phone, {
        task_id: task.id,
        place_label: task.place_label,
        amount_cents: task.bounty_cents,
        earnings_url: earningsUrl(worker.id),
        live_payouts: config.live_payouts,
      }),
    );

  async function payOut(task: Task, worker: Payee): Promise<Task> {
    let paid: Task | undefined;
    try {
      const lease = await maybe<{ stripe_ref: string }>("eyes_payout_begin", { p_task_id: task.id });
      if (!lease) return task;
      const end = () => rpc("eyes_payout_end", { p_task_id: task.id, p_key: lease.stripe_ref });
      try {
        const { transfer_id } = await payments.payoutWorker({
          account_id: worker.stripe_account_id,
          amount_cents: task.bounty_cents,
          task_id: task.id,
          idempotency_key: lease.stripe_ref,
        });
        paid = await maybe<Task>("eyes_record_payout", {
          p_task_id: task.id,
          p_transfer_id: transfer_id,
          p_now: nowIso(),
        });
      } catch (err) {
        if (!(err as { outcome_unknown?: boolean }).outcome_unknown) await end();
        throw err;
      }
      await end();
    } catch (err) {
      console.error(`payout for task ${task.id} failed`, err);
    }
    if (!paid) return task;
    await notifyPaid(paid, worker);
    return paid;
  }

  async function settle(task: Task, worker: Worker): Promise<Task> {
    if (task.status !== "verified") return task;
    const { stripe_account_id } = worker;
    if (stripe_account_id) return payOut(task, { ...worker, stripe_account_id });
    if (!config.live_payouts) {
      await notifyPaid(task, worker);
      return task;
    }
    await textWorker(worker, task.id, () =>
      messaging.sendText(
        worker.phone,
        `Your ${dollars(task.bounty_cents)} for this task is waiting. Set up payouts here: ${connectUrl(worker.id)}`,
      ),
    );
    return task;
  }

  const payoutsDue = (accountId: string | null, limit: number | null, after: string | null = null) =>
    rpc<{ task: Task; worker: Payee }>("eyes_payouts_due", {
      p_account_id: accountId,
      p_limit: limit,
      p_after: after,
    });
  let retryAfter: string | null = null;

  async function resolveTask(task_id: string, decision: "refund" | "release", note: string) {
    const input = parse(ResolveInput, { task_id, decision, note });
    const resolved = await one<Task>("eyes_resolve_task", {
      p_task_id: input.task_id,
      p_decision: input.decision,
      p_note: input.note,
      p_now: nowIso(),
    });
    const worker = await one<Worker>("eyes_worker", { p_worker_id: resolved.claimed_by, p_phone: null });
    const settled = await settle(resolved, worker);
    return { task_id: settled.id, status: settled.status };
  }

  async function disputeOf(task: Task) {
    const t = await maybe<DisputeTicket>("eyes_task_dispute", { p_task_id: task.id });
    if (!t?.dispute_status) return null;
    const upheld = t.dispute_status === "upheld";
    return {
      status: t.dispute_status,
      refunded_usd: upheld ? centsToUsd(task.bounty_cents + task.fee_cents) : null,
    };
  }

  return {
    async authenticate(apiKey) {
      return (await maybe<Agent>("eyes_agent_by_key_hash", { p_api_key_hash: sha256(apiKey) })) ?? null;
    },

    async signupAgent(input) {
      const { name, owner_email } = parse(SignupInput, input);
      const apiKey = newApiKey();
      const agent = await one<Agent>("eyes_signup", {
        p_name: name,
        p_api_key_hash: sha256(apiKey),
        p_grant_cents: config.test_mode ? config.signup_grant_cents : 0,
        p_now: nowIso(),
      });
      const top_up_url = topUpUrl(agent.id);
      const email_address = config.email_domain
        ? agentEmailAddress(config.link_secret, agent.id, config.email_domain)
        : null;
      const byEmail = email_address
        ? ` You can also email questions to ${email_address} and get the answer as a threaded reply; keep this address private, it works like the api_key.`
        : "";
      const owner = !owner_email
        ? ""
        : (await emailOwner(
              owner_email,
              agent.id,
              "Your AI agent's Eyes spending controls",
              `An AI agent (Eyes agent id ${agent.id}) signed up for Eyes and listed this address as its owner.`,
            ))
          ? config.email_delivery
            ? ` We emailed your user at ${owner_email} a private control link to set your spend limits and add funds; only they can change your limits.`
            : ` Owner email delivery is not set up on this server, so nothing was sent to ${owner_email}. Your user can get their private control link from the Eyes operator, who creates it with pnpm owner-link ${agent.id}; only they can change your limits.`
          : ` We could not email your user at ${owner_email}; they can ask the Eyes operator for their control link.`;
      return {
        agent_id: agent.id,
        api_key: apiKey,
        email_address,
        balance_usd: centsToUsd(agent.balance_cents),
        top_up_url,
        next_step: `Save api_key now; it is shown only once. Send it as the header Authorization: Bearer <api_key>. Ask your user to add funds at ${top_up_url}, then call quote_task or ask_eyes.${byEmail}${owner}`,
      };
    },

    async agentById(agentId) {
      if (!z.uuid().safeParse(agentId).success) return null;
      return (await maybe<Agent>("eyes_agent", { p_agent_id: agentId })) ?? null;
    },

    async quoteTask(agent, input) {
      const { location, task_type } = parse(TOOLS.quote_task.input, input);
      const place = await resolve(location);
      const verdict = await deps.assessTask({
        question: "", // no question yet: rules only; ask_eyes runs the classifier on the real one
        task_type,
        place_label: place.label,
      });
      const workers = await nearby(place, null);
      const nearest = workers[0];
      const s = await one<Summary>("eyes_agent_summary", { p_agent_id: agent.id, p_now: nowIso() });
      const fee = config.fee_cents;
      const left = Math.max(0, s.daily_cap_cents - s.spent_today_cents);
      const least = MIN_BOUNTY_CENTS + fee;
      const reset = new Date(now());
      reset.setUTCHours(24, 0, 0, 0);
      const reasons = [
        verdict.allowed
          ? ""
          : [verdict.reason, verdict.fix].filter(Boolean).join(" ") || ERRORS.unsafe_task.message,
        s.allowed_task_types.includes(task_type)
          ? ""
          : `This API key may not post ${task_type} tasks; its allowed_task_types are ${s.allowed_task_types.join(", ") || "none"}. Use one of those, or ask your user to allow ${task_type}.`,
        s.max_bounty_cents >= MIN_BOUNTY_CENTS
          ? ""
          : `This API key's max_bounty_usd is ${centsToUsd(s.max_bounty_cents)}, below the ${centsToUsd(MIN_BOUNTY_CENTS)} USD minimum bounty, so it cannot post tasks. Ask your user to raise max_bounty_usd.`,
        left >= least
          ? ""
          : s.daily_cap_cents === 0
            ? FROZEN
            : `Only ${centsToUsd(left)} USD of today's spend cap is left, less than the minimum bounty plus fee (${centsToUsd(least)} USD). Wait until the cap resets at ${reset.toISOString()} (midnight UTC), or ask your user to raise daily_cap_usd.`,
        s.balance_cents >= least
          ? ""
          : `Your balance of ${centsToUsd(s.balance_cents)} USD is less than the minimum bounty plus fee (${centsToUsd(least)} USD). Ask your user to top up at ${topUpUrl(agent.id)}, then call get_balance before asking.`,
      ].filter(Boolean);
      const bounty = Math.max(
        MIN_BOUNTY_CENTS,
        Math.min(config.default_bounty_cents, s.max_bounty_cents, left - fee, s.balance_cents - fee),
      );
      return {
        workers_nearby: workers.length,
        est_minutes_to_answer: nearest
          ? Math.ceil(nearest.distance_m / WALK_METERS_PER_MINUTE) + CAPTURE_MINUTES
          : null,
        suggested_bounty_usd: centsToUsd(bounty),
        allowed: reasons.length === 0,
        reason_if_not: reasons.join(" ") || null,
        resolved_location: place,
      };
    },

    async askEyes(agent, input) {
      const ask = parse(TOOLS.ask_eyes.input, input);
      const assess = async (place_label: string) => {
        const verdict = await deps.assessTask({
          question: ask.question,
          task_type: ask.task_type,
          place_label,
        });
        if (!verdict.allowed) {
          throw new EyesError(
            "unsafe_task",
            { category: verdict.category, reason: verdict.reason },
            { fix: verdict.fix ?? undefined },
          );
        }
      };
      const place = await resolve(ask.location).catch(async (err) => {
        if (typeof ask.location === "string") await assess(ask.location);
        throw err;
      });
      await assess(place.label);
      if (!agent.allowed_task_types.includes(ask.task_type)) {
        throw new EyesError("task_type_not_allowed", {
          task_type: ask.task_type,
          allowed_task_types: agent.allowed_task_types,
        });
      }
      const bountyCents = usdToCents(ask.bounty_usd);
      if (bountyCents > agent.max_bounty_cents) {
        throw new EyesError("bounty_exceeds_max", {
          bounty_usd: ask.bounty_usd,
          max_bounty_usd: centsToUsd(agent.max_bounty_cents),
        });
      }
      const workers = await nearby(place, config.dispatch_max_workers);
      const ping = config.location_ping && workers.length < config.dispatch_max_workers;
      const pinged = (taskId: string | null) =>
        pingStale(place, taskId).catch((err) => {
          console.error(`location pings failed: ${errorName(err)}`);
          return 0;
        });
      const posted = await one<Posted>("eyes_post_task", {
        p_agent_id: agent.id,
        p_question: ask.question,
        p_task_type: ask.task_type,
        p_place_label: place.label,
        p_lat: place.lat,
        p_lng: place.lng,
        p_radius_m: config.verify_radius_m,
        p_bounty_cents: bountyCents,
        p_fee_cents: config.fee_cents,
        p_require_photo: ask.require_photo,
        p_deadline_minutes: ask.deadline_minutes,
        p_idempotency_key: ask.idempotency_key,
        p_worker_ids: workers.map((w) => w.worker_id),
        p_now: nowIso(),
      }).catch(async (err) => {
        if (err instanceof EyesError && err.code === "no_workers_nearby") {
          const needed_cents = bountyCents + config.fee_cents;
          const s = await one<Summary>("eyes_agent_summary", { p_agent_id: agent.id, p_now: nowIso() });
          if (s.balance_cents < needed_cents)
            throw agentFacing(
              new EyesError("insufficient_balance", { balance_cents: s.balance_cents, needed_cents }),
              agent.id,
            );
          // Pinged workers who answer are fresh for the agent's retry.
          if (ping) await pinged(null);
        }
        throw agentFacing(err, agent.id);
      });
      const { task } = posted;
      let notified = posted.workers_notified;
      if (posted.created) {
        notified = await sendOffers(task, workers);
        if (ping && (await pinged(task.id)) > 0) {
          // ponytail: in-process timer, so a restart in these 30 s loses the re-offer; persist due
          // re-offers (a column on worker_pings) if that ever matters.
          setTimeout(
            () =>
              offerMore(task).catch((err) =>
                console.error(`re-offer for task ${task.id} failed: ${errorName(err)}`),
              ),
            PING_WAIT_MS,
          ).unref();
        }
      }
      return {
        task_id: task.id,
        status: "dispatched",
        workers_notified: notified,
        escrowed_usd: centsToUsd(task.bounty_cents + task.fee_cents),
        deadline_at: iso(task.deadline_at),
        next_step: `Call await_answer with task_id "${task.id}" now, and keep calling it until answered is true or the status is expired, refunded or disputed. Each call waits up to 50 seconds.`,
      };
    },

    async awaitAnswer(agent, input, signal) {
      const { task_id, timeout_seconds } = parse(TOOLS.await_answer.input, input);
      const until = Date.now() + timeout_seconds * 1000;
      for (;;) {
        const found = await detail(agent, task_id);
        const { status } = found.task;
        const answered = ANSWERED.includes(status);
        if (answered || FINAL.includes(status) || Date.now() >= until || signal?.aborted) {
          return { task_id, status, answered, answer: answerOf(found), next_step: AWAIT_NEXT_STEP[status] };
        }
        await sleep(Math.min(POLL_MS, until - Date.now()), undefined, { signal }).catch(() => {});
      }
    },

    async getTask(agent, input) {
      const { task_id } = parse(TOOLS.get_task.input, input);
      const found = await detail(agent, task_id);
      const { task } = found;
      return {
        task_id: task.id,
        status: task.status,
        question: task.question,
        task_type: task.task_type,
        place_label: task.place_label,
        bounty_usd: centsToUsd(task.bounty_cents),
        fee_usd: centsToUsd(task.fee_cents),
        deadline_at: iso(task.deadline_at),
        created_at: iso(task.created_at),
        claimed_at: task.claimed_at && iso(task.claimed_at),
        answer: answerOf(found),
        dispute: await disputeOf(task),
      };
    },

    async listTasks(agent, input) {
      const { status, limit } = parse(TOOLS.list_tasks.input, input);
      const rows = await rpc<Task>("eyes_list_tasks", {
        p_agent_id: agent.id,
        p_status: status ?? null,
        p_limit: limit,
      });
      return {
        tasks: rows.map((t) => ({
          task_id: t.id,
          status: t.status,
          question: t.question,
          place_label: t.place_label,
          bounty_usd: centsToUsd(t.bounty_cents),
          created_at: iso(t.created_at),
          deadline_at: iso(t.deadline_at),
          answered: ANSWERED.includes(t.status),
        })),
        next_step: rows.length
          ? "Resume instead of asking again: for a task with status dispatched, claimed or submitted, call await_answer with its task_id; for a task where answered is true, call get_task to read the answer and photo_url. Call ask_eyes only if no task here covers your question."
          : status
            ? `You have no tasks with status ${status}. Call list_tasks without status to see all your tasks.`
            : "You have no tasks yet. Call quote_task, then ask_eyes to create one.",
      };
    },

    async cancelTask(agent, input) {
      const { task_id } = parse(TOOLS.cancel_task.input, input);
      const task = await one<Task>("eyes_cancel_task", {
        p_agent_id: agent.id,
        p_task_id: task_id,
        p_now: nowIso(),
      });
      return { task_id, status: "refunded", refunded_usd: centsToUsd(task.bounty_cents + task.fee_cents) };
    },

    async disputeAnswer(agent, input) {
      const { task_id, reason } = parse(TOOLS.dispute_answer.input, input);
      await rpc("eyes_dispute", { p_agent_id: agent.id, p_task_id: task_id, p_reason: reason });
      return {
        task_id,
        status: "disputed",
        next_step:
          "Recorded. A person reviews the dispute; an unpaid payout is held meanwhile. If the answer was fake, the full bounty and fee are refunded to your balance. Call get_task later: dispute.status is open, upheld (refunded) or rejected (the answer stands).",
      };
    },

    async getBalance(agent) {
      const s = await one<Summary>("eyes_agent_summary", { p_agent_id: agent.id, p_now: nowIso() });
      return {
        balance_usd: centsToUsd(s.balance_cents),
        escrowed_usd: centsToUsd(s.escrowed_cents),
        top_up_url: topUpUrl(agent.id),
      };
    },

    async getSpendPolicy(agent) {
      return policyOf(await one<Summary>("eyes_agent_summary", { p_agent_id: agent.id, p_now: nowIso() }));
    },

    async topupCheckoutUrl(token, amount_cents = 2000) {
      const agentId = tokenPayload(token, "t");
      if (!agentId) {
        throw new EyesError(
          "unauthorized",
          {},
          {
            message: "This top-up link is invalid.",
            fix: "Ask your AI agent for a new top-up link. It can get one from Eyes at any time.",
          },
        );
      }
      const { url } = await payments.createTopupCheckout({
        agent_id: agentId,
        amount_cents,
        success_url: `${config.public_api_url}/topup/done`,
        cancel_url: `${config.public_api_url}/topup/cancel`,
      });
      return url;
    },

    async creditTopup({ agent_id, amount_cents, stripe_ref, payer_email }) {
      const { first_paid } = await one<{ first_paid: boolean }>("eyes_credit_paid_topup", {
        p_agent_id: agent_id,
        p_amount_cents: amount_cents,
        p_stripe_ref: stripe_ref,
        p_now: nowIso(),
      });
      if (!payer_email || !first_paid) return;
      await emailOwner(
        payer_email,
        agent_id,
        `You added ${dollars(amount_cents)} to your AI agent's Eyes balance`,
        `Thank you for adding ${dollars(amount_cents)} to the Eyes balance of your AI agent (Eyes agent id ${agent_id}). You are the first person to pay for it, so you also get its owner controls.`,
      );
    },

    async ownerConsole(token) {
      const agentId = ownerAgentId(token);
      const c = await maybe<ConsoleRow>("eyes_owner_console", { p_agent_id: agentId, p_now: nowIso() });
      if (!c) throw new EyesError("owner_link_invalid");
      return {
        agent_id: agentId,
        agent_name: c.agent_name,
        balance_usd: centsToUsd(c.balance_cents),
        escrowed_usd: centsToUsd(c.escrowed_cents),
        policy: policyOf(c),
        tasks: c.tasks.map((t) => ({
          task_id: t.task_id,
          question: t.question,
          place_label: t.place_label,
          status: t.status,
          bounty_usd: centsToUsd(t.bounty_cents),
          created_at: iso(t.created_at),
        })),
        ledger: c.ledger.map((l) => ({
          type: l.type,
          amount_usd: centsToUsd(l.amount_cents),
          task_id: l.task_id,
          created_at: iso(l.created_at),
        })),
        top_up_url: topUpUrl(agentId),
      };
    },

    async updateSpendPolicy(token, input) {
      const agentId = ownerAgentId(token);
      const policy = parse(OwnerPolicyInput, input);
      const s = await maybe<Summary>("eyes_update_spend_policy", {
        p_agent_id: agentId,
        p_max_bounty_cents: usdToCents(policy.max_bounty_usd),
        p_daily_cap_cents: usdToCents(policy.daily_cap_usd),
        p_allowed_task_types: [...new Set(policy.allowed_task_types)],
        p_now: nowIso(),
      });
      if (!s) throw new EyesError("owner_link_invalid");
      return policyOf(s);
    },

    async rotateApiKey(token) {
      const agentId = ownerAgentId(token);
      const api_key = newApiKey();
      const rotated = await maybe("eyes_rotate_api_key", {
        p_agent_id: agentId,
        p_api_key_hash: sha256(api_key),
      });
      if (!rotated) throw new EyesError("owner_link_invalid");
      return { api_key };
    },

    async joinWorker(input) {
      const join = parse(JoinWorkerInput, input);
      await rpc("eyes_join_worker", {
        p_name: join.name,
        p_phone: join.phone,
        p_lat: join.lat,
        p_lng: join.lng,
        p_now: nowIso(),
      });
      return {
        opt_in_instructions: `Text START to the Eyes number to start getting paid tasks near you${config.live_payouts ? "; we reply with your payout setup link" : ""}. When a task text arrives, reply YES to claim it. Text STOP any time to pause.${simulatedPay}`,
        inkbox_number: null,
        connect_url: null,
      };
    },

    async workerConnectUrl(token) {
      const workerId = tokenPayload(token, "c");
      if (!workerId)
        throw new EyesError(
          "offer_invalid",
          {},
          {
            message: "This payout setup link is invalid or has expired.",
            fix: "Text START to the Eyes number for a fresh payout setup link.",
          },
        );
      const worker = await one<Worker>("eyes_worker", { p_worker_id: workerId, p_phone: null });
      let accountId = worker.stripe_account_id;
      if (!accountId) {
        const created = await payments.createWorkerAccount({
          worker_id: worker.id,
          phone: worker.phone,
          name: worker.name,
        });
        const stored = await one<Worker>("eyes_set_worker_stripe_account", {
          p_worker_id: worker.id,
          p_account_id: created.account_id,
        });
        accountId = stored.stripe_account_id ?? created.account_id;
      }
      const { url } = await payments.createOnboardingLink({
        account_id: accountId,
        refresh_url: `${config.public_api_url}/w/connect/${token}`,
        return_url: `${config.public_api_url}/w/connect/done`,
      });
      return url;
    },

    async markWorkerOnboarded(account_id) {
      for (const { task, worker } of await payoutsDue(account_id, null)) await payOut(task, worker);
    },

    async handleWorkerReply({ phone, intent, text }) {
      const worker = await maybe<Worker>("eyes_worker", { p_worker_id: null, p_phone: phone });
      if (!worker) {
        if (intent === "stop") return;
        await messaging.sendText(
          phone,
          `You are not signed up for Eyes yet. Join at ${config.worker_web_url} to get paid tasks near you.${simulatedPay}`,
        );
        return;
      }
      if (worker.banned) {
        // Banned after confirmed fraud (ADR-026): no tasks, no rejoining with this phone.
        if (intent === "start") await messaging.sendText(phone, "This number can't take Eyes tasks.");
        return;
      }
      if (!worker.opted_in && intent !== "start") return;
      const reply: Record<ReplyIntent, () => Promise<unknown>> = {
        start: async () => {
          await rpc("eyes_set_worker_opt_in", { p_phone: phone, p_opted_in: true });
          await messaging.sendText(phone, hubText(worker.id, await hubSteps(worker)));
        },
        stop: async () => {
          await rpc("eyes_set_worker_opt_in", { p_phone: phone, p_opted_in: false });
          appLinkSentAt.delete(worker.id); // STOP deleted every code, so the next START sends a fresh one
          await messaging.sendText(
            phone,
            "Eyes: you're opted out and won't get task texts. Text START to rejoin.",
          );
        },
        yes: () => claim(worker),
        no: async () => {
          const released = await maybe<Task>("eyes_release_claim", {
            p_worker_id: worker.id,
            p_now: nowIso(),
          });
          await messaging.sendText(phone, released ? REPLY_TEXT.released : REPLY_TEXT.no);
          if (!released) return;
          const idle = await rpc<Worker & LatLng>("eyes_reoffer", {
            p_task_id: released.id,
            p_released_by: worker.id,
            p_now: nowIso(),
            p_max_age: maxAge,
          });
          await sendOffers(
            released,
            idle.map((w) => ({ worker_id: w.id, phone: w.phone, distance_m: distanceMeters(released, w) })),
          );
        },
        here: () =>
          messaging.sendText(
            phone,
            `Eyes: tap to update your spot (the link works for 30 minutes): ${hereUrl(worker.id)}`,
          ),
        location_share: () =>
          messaging.sendText(
            phone,
            `Thanks! iMessage locations don't reach us, so tap this to update your spot: ${hereUrl(worker.id)}`,
          ),
        app: async () => {
          appLinkSentAt.set(worker.id, now().getTime());
          await messaging.sendText(phone, `Get the Eyes app: ${appUrl(await mintLocationCode(worker.id))}`);
        },
        install: () => reply.app(),
        // ADR-027: the live capture link again. Newest claim first; a claim past its deadline
        // stays 'claimed' until the sweep expires it, so the deadline is checked here.
        task: async () => {
          const earnings = await maybe<EarningsRow>("eyes_worker_earnings", { p_worker_id: worker.id });
          const claimed = earnings?.tasks.find((t) => t.status === "claimed");
          const found = claimed && (await maybe<Detail>("eyes_task_detail", { p_task_id: claimed.task_id }));
          const open = found && new Date(found.task.deadline_at) > now() ? found.task : null;
          await messaging.sendText(
            phone,
            open
              ? `Eyes: here is the link for your task: ${captureUrl(open, worker.id)}`
              : "You have no open task right now. We'll text you when one is near.",
          );
        },
        shortcut: async () => {
          const code = await mintLocationCode(worker.id);
          await messaging.sendText(
            phone,
            `Eyes: your location code is in the next text. Set up automatic location with these steps and paste the code where they say: ${config.worker_web_url}/automation.html Use one code per device; your earlier codes keep working (the 5 newest do). Text STOP to delete your location and turn all codes off.`,
          );
          await messaging.sendText(phone, code);
        },
        help: async () => {
          const ticket = await maybe<Ticket>("eyes_open_ticket", {
            p_worker_id: worker.id,
            p_message: text,
            p_now: nowIso(),
          });
          await messaging.sendText(
            phone,
            ticket
              ? `Eyes: ticket #${ticket.id} opened. Someone will check your answer by hand and text you the outcome. Reply here to add details.`
              : hubText(worker.id, await hubSteps(worker)),
          );
        },
        unknown: async () => {
          const spot = parseMapLink(text);
          if (spot === "short_link") {
            return messaging.sendText(
              phone,
              `Eyes: short map links can't be read, so tap this to update your spot (the link works for 30 minutes): ${hereUrl(worker.id)}`,
            );
          }
          if (spot) {
            const outcome = await storeFix(worker.id, { ...spot, source: "map_link" }, null);
            if (outcome === "stored") {
              await messaging.sendText(
                phone,
                `Spot updated: near ${spot.lat.toFixed(2)}, ${spot.lng.toFixed(2)}.`,
              );
            } else if (outcome === "rate_limited") {
              await messaging.sendText(
                phone,
                `Eyes: your spot was updated less than ${config.location_min_interval_s} seconds ago. Send the link again in a minute.`,
              );
            }
            return;
          }
          const ticket = await maybe<Ticket>("eyes_append_ticket", {
            p_worker_id: worker.id,
            p_message: text,
          });
          await messaging.sendText(
            phone,
            ticket
              ? `Eyes: added to ticket #${ticket.id}. We will text you the outcome.`
              : `Didn't catch that. Reply YES to take a task or STOP to pause. Your setup: ${meUrl(worker.id)}`,
          );
        },
      };
      await reply[intent]();
    },

    async workerEarnings(token) {
      const workerId = tokenPayload(token, "e");
      const e = workerId && (await maybe<EarningsRow>("eyes_worker_earnings", { p_worker_id: workerId }));
      if (!e) {
        throw new EyesError(
          "offer_invalid",
          {},
          {
            message: "This earnings link is invalid or has expired.",
            fix: "Text HELP to the Eyes number for a fresh link.",
          },
        );
      }
      return {
        paid_usd: centsToUsd(e.paid_cents),
        pending_usd: centsToUsd(e.pending_cents),
        tasks: e.tasks.map((t) => ({
          task_id: t.task_id,
          question: t.question,
          task_type: t.task_type,
          place_label: t.place_label,
          status: t.status,
          bounty_usd: centsToUsd(t.bounty_cents),
          payout: payoutOf(t, e.payouts_set_up),
          claimed_at: iso(t.claimed_at),
          paid_at: t.paid_at && iso(t.paid_at),
        })),
      };
    },

    async workerSetup(token) {
      const workerId = tokenPayload(token, "e");
      const [w, e] = workerId
        ? await Promise.all([
            maybe<Worker & { location_source: string | null }>("eyes_worker", {
              p_worker_id: workerId,
              p_phone: null,
            }),
            maybe<EarningsRow>("eyes_worker_earnings", { p_worker_id: workerId }),
          ])
        : [];
      if (!w || !e) throw new EyesError("unauthorized", {}, SETUP_LINK_INVALID);
      // Same spot rule as START: a fix, or the sign-up location until the first fix.
      const at = w.lat === null ? null : iso(w.location_at ?? w.created_at);
      const fresh = at !== null && now().getTime() - Date.parse(at) <= config.location_max_age_h * 3_600_000;
      const app = w.location_source === "app";
      return {
        opted_in: w.opted_in,
        spot: { at, fresh, max_age_h: config.location_max_age_h },
        app: { last_at: app ? at : null, sending: app && fresh },
        payouts: {
          set_up: e.payouts_set_up,
          live: config.live_payouts,
          setup_url: config.live_payouts && !e.payouts_set_up ? connectUrl(w.id) : null,
        },
        here_url: hereUrl(w.id),
        earnings_url: earningsUrl(w.id),
        tasks: e.tasks.slice(0, 5).map((t) => ({
          question: t.question,
          place_label: t.place_label,
          status: t.status,
          bounty_usd: centsToUsd(t.bounty_cents),
          payout: payoutOf(t, e.payouts_set_up),
          claimed_at: iso(t.claimed_at),
        })),
      };
    },

    async workerInstallLink(token) {
      const workerId = tokenPayload(token, "e");
      const w = workerId
        ? await maybe<Worker>("eyes_worker", { p_worker_id: workerId, p_phone: null })
        : undefined;
      // Codes only work for an opted-in worker (eyes_rotate_location_token skips the others).
      if (!w?.opted_in) throw new EyesError("unauthorized", {}, SETUP_LINK_INVALID);
      const code = await mintLocationCode(w.id);
      return {
        install_url: appUrl(code),
      };
    },

    async getOffer(token) {
      const { task, workerId } = await offer(token);
      return {
        task_id: task.id,
        question: task.question,
        task_type: task.task_type,
        place_label: task.place_label,
        lat: task.lat,
        lng: task.lng,
        radius_m: task.radius_m,
        bounty_usd: centsToUsd(task.bounty_cents),
        deadline_at: iso(task.deadline_at),
        require_photo: task.require_photo,
        status: task.status,
        claimed_by_you: task.claimed_by === workerId,
      };
    },

    async submitCapture(token, fields, photo) {
      const { task, workerId } = await offer(token);
      if (task.claimed_by !== workerId) throw new EyesError("task_already_claimed");
      if (task.status !== "claimed") throw new EyesError("offer_invalid", { status: task.status });
      const capture = parse(CaptureFields, fields);
      if (task.require_photo && !photo) {
        throw new EyesError(
          "invalid_input",
          { issues: [{ path: "photo", message: "This task requires a live photo." }] },
          { fix: "Take a photo with the capture page camera and submit again." },
        );
      }
      const key = `${task.id}/${randomUUID()}.jpg`;
      const photo_url = photo
        ? (
            await providers.storage.putPhoto({
              key,
              bytes: photo.bytes,
              content_type: photo.content_type,
            })
          ).url
        : null;
      let faces = false;
      const v = await deps.verifySubmission({
        task,
        submission: {
          lat: capture.lat,
          lng: capture.lng,
          accuracy_m: capture.accuracy_m,
          captured_at: capture.captured_at,
          received_at: nowIso(),
          photo_url,
          answer_text: capture.answer_text,
          answer_bool: capture.answer_bool,
        },
        vision: {
          judge: async (i) => {
            const verdict = await providers.vision.judge(i);
            faces = verdict.prominent_faces;
            return verdict;
          },
        },
      });
      const dropPhoto = () =>
        providers.storage
          .deletePhoto({ key })
          .catch(() => console.error(`photo delete for task ${task.id} failed`));
      if (faces) await dropPhoto();
      const submitted = await one<Task>("eyes_submit", {
        p_task_id: task.id,
        p_worker_id: workerId,
        p_photo_url: faces ? null : photo_url,
        p_answer_text: capture.answer_text,
        p_answer_bool: capture.answer_bool,
        p_lat: capture.lat,
        p_lng: capture.lng,
        p_captured_at: capture.captured_at,
        p_gps_ok: v.gps_ok,
        p_fresh_ok: v.fresh_ok,
        p_vision_ok: v.vision_ok,
        p_vision_reason: v.vision_reason,
        p_confidence: v.confidence,
        p_auto_approve: v.auto_approve,
        p_now: nowIso(),
      }).catch(async (err: unknown) => {
        const lost =
          err instanceof EyesError && (err.code === "task_already_claimed" || err.code === "offer_invalid");
        if (lost && photo_url && !faces) await dropPhoto();
        throw err;
      });
      await storeFix(workerId, { ...capture, source: "capture" }, null).catch((err) =>
        console.error(`location from capture for task ${task.id} failed: ${errorName(err)}`),
      );
      const worker = await one<Worker>("eyes_worker", { p_worker_id: workerId, p_phone: null });
      const settled = await settle(submitted, worker);
      const amount = dollars(settled.bounty_cents);
      const message =
        settled.status === "needs_review"
          ? `Thanks, we got it. Your answer needs a quick manual check (${v.vision_reason}). ${config.live_payouts ? "You will be paid once it is approved." : SIMULATED_PAY} To request a manual review, reply HELP to the Eyes text.`
          : !config.live_payouts
            ? `Verified. ${SIMULATED_PAY}`
            : settled.status === "paid"
              ? `Verified and paid. ${amount} is on its way to your account. Thank you!`
              : worker.stripe_account_id
                ? `Your ${amount} payout did not go through yet; it will be retried.`
                : worker.opted_in
                  ? `We texted you a link to set up payouts; your ${amount} is sent automatically once that is done.`
                  : `To get your ${amount}, set up payouts here: ${connectUrl(worker.id)}`;
      return {
        task_id: settled.id,
        status: settled.status,
        verification: {
          gps_ok: v.gps_ok,
          fresh_ok: v.fresh_ok,
          vision_ok: v.vision_ok,
          vision_reason: v.vision_reason,
        },
        message,
      };
    },

    async updateWorkerLocation(token, input) {
      const fix = parse(WorkerLocationInput, input);
      const workerId = token.includes(".")
        ? tokenPayload(token, "l")
        : (await maybe<Worker>("eyes_worker_by_location_token", { p_token_hash: sha256(token) }))?.id;
      const outcome = workerId
        ? await storeFix(workerId, fix, PING_IN_INPUT.exec(fix.input ?? "")?.[1]?.toLowerCase() ?? null)
        : "not_found";
      if (outcome === "not_found") {
        throw new EyesError(
          "unauthorized",
          {},
          {
            message: "This location link or code is invalid or has expired.",
            fix: "Text HELP to the Eyes number for a fresh link.",
          },
        );
      }
      if (outcome === "rate_limited") {
        const wait = config.location_min_interval_s;
        throw new EyesError(
          "rate_limited",
          { retry_after_s: wait },
          { fix: `Wait ${wait} seconds and send again.` },
        );
      }
    },

    async workerDevice(code) {
      const workerId = (await maybe<Worker>("eyes_worker_by_location_token", { p_token_hash: sha256(code) }))
        ?.id;
      if (!workerId) throw new EyesError("unauthorized", {}, DEVICE_LINK_EXPIRED);
      const devices = await rpc<{ released_at: string | null }>("eyes_worker_devices", {
        p_worker_id: workerId,
      });
      const ticket = signToken(
        config.link_secret,
        `d:${workerId}`,
        new Date(now().getTime() + HERE_LINK_MS * 2),
      );
      return {
        profile_url: `${config.public_api_url}/w/device/profile/${ticket}`,
        registered: devices.length > 0,
        ready: devices.some((d) => d.released_at !== null),
      };
    },

    async addWorkerDevice(ticket, device) {
      const workerId = tokenPayload(ticket, "d");
      if (!workerId) throw new EyesError("unauthorized", {}, DEVICE_LINK_EXPIRED);
      await rpc("eyes_add_worker_device", {
        p_worker_id: workerId,
        p_udid: device.udid,
        p_product: device.product,
        p_os_version: device.version,
      });
    },

    async expireOverdue() {
      return { expired: (await rpc("eyes_expire_overdue", { p_now: nowIso() })).length };
    },

    async retryPayouts() {
      const due = await payoutsDue(null, PAYOUT_BATCH, retryAfter);
      retryAfter = due.length === PAYOUT_BATCH ? (due.at(-1)?.task.id ?? null) : null;
      let paid = 0;
      for (const { task, worker } of due) {
        if ((await payOut(task, worker)).status === "paid") paid += 1;
      }
      return { paid };
    },

    resolveTask,

    async resolveTicket(input) {
      const { ticket_id, outcome, note } = parse(ResolveTicketInput, input);
      const ticket = await one<Ticket>("eyes_resolve_ticket", {
        p_ticket_id: ticket_id,
        p_note: note,
        p_now: nowIso(),
      });
      const worker = await one<Worker>("eyes_worker", { p_worker_id: ticket.worker_id, p_phone: null });
      const body = [`Eyes: ticket #${ticket.id} is resolved.`, TICKET_OUTCOME[outcome], `Note: ${note}`];
      await textWorker(worker, ticket.task_id, () =>
        messaging.sendText(worker.phone, body.filter(Boolean).join(" ")),
      );
      return { ticket_id: Number(ticket.id), task_id: ticket.task_id, status: "resolved" };
    },

    async confirmFraud(input) {
      const { ticket_id, note } = parse(DisputeDecision, input);
      const r = await one<FraudRow>("eyes_confirm_fraud", {
        p_ticket_id: ticket_id,
        p_note: note,
        p_now: nowIso(),
      });
      const { ticket } = r;
      let owed = ticket.reversal_owed_cents === null ? null : Number(ticket.reversal_owed_cents);
      let reversal: DisputeOutcome["reversal"] = owed ? "owed" : "none";
      if (!r.already && r.transfer_id && r.payout_cents) {
        try {
          await payments.reverseTransfer({
            transfer_id: r.transfer_id,
            amount_cents: Number(r.payout_cents),
            idempotency_key: `reverse-${ticket.task_id}`,
          });
          reversal = "reversed";
        } catch (err) {
          // Usually balance_insufficient: the worker already moved the money out. Recorded as owed.
          const code = err instanceof Error && "code" in err ? String(err.code) : errorName(err);
          console.error(`transfer reversal for task ${ticket.task_id} failed: ${code}`);
          owed = Number(r.payout_cents);
          reversal = "owed";
          await rpc("eyes_record_reversal", { p_ticket_id: ticket_id, p_owed_cents: owed });
        }
      }
      return {
        ticket_id: Number(ticket.id),
        task_id: ticket.task_id,
        dispute_status: "upheld",
        agent_refund_cents: r.already ? 0 : Number(r.refund_cents ?? 0),
        reversal,
        reversal_owed_cents: owed,
        worker_banned: true,
        already_resolved: r.already,
      };
    },

    async rejectDispute(input) {
      const { ticket_id, note } = parse(DisputeDecision, input);
      const r = await one<{ ticket: DisputeTicket; already: boolean }>("eyes_reject_dispute", {
        p_ticket_id: ticket_id,
        p_note: note,
        p_now: nowIso(),
      });
      if (!r.already) await resolveTask(r.ticket.task_id, "release", `dispute rejected: ${note}`);
      return {
        ticket_id: Number(r.ticket.id),
        task_id: r.ticket.task_id,
        dispute_status: "rejected",
        agent_refund_cents: 0,
        reversal: "none",
        reversal_owed_cents: null,
        worker_banned: false,
        already_resolved: r.already,
      };
    },
  };
}
