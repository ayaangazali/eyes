import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Agent,
  type Answer,
  agentEmailAddress,
  CaptureFields,
  centsToUsd,
  distanceMeters,
  type EngineDeps,
  ERRORS,
  EyesError,
  type EyesService,
  JoinWorkerInput,
  type LatLng,
  type LedgerType,
  OwnerPolicyInput,
  type ReplyIntent,
  type ResolvedLocation,
  SignupInput,
  type Submission,
  signToken,
  type Task,
  type TaskStatus,
  TOOLS,
  usdToCents,
  verifyToken,
  type Worker,
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

const ANSWERED: TaskStatus[] = ["verified", "paid", "needs_review"];
const FINAL: TaskStatus[] = ["expired", "refunded", "disputed"];
const WALK_METERS_PER_MINUTE = 80;
const CAPTURE_MINUTES = 3;
const POLL_MS = 1000;
const CONNECT_LINK_MS = 7 * 24 * 60 * 60 * 1000;
const PAYOUT_BATCH = 25;

const ResolveInput = z.object({
  task_id: z.uuid(),
  decision: z.enum(["refund", "release"]),
  note: z.string().trim().min(1),
});

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

const REPLY_TEXT: Record<"no" | "released" | "help" | "unknown", string> = {
  no: "No problem, we will text you the next task nearby.",
  released: "Got it, the task is released. Thanks.",
  help: "Eyes texts you paid tasks to check public places nearby. Reply YES to claim a task, STOP to opt out.",
  unknown: "Sorry, we did not get that. Reply YES to claim the task, NO to skip it, or HELP for help.",
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (s: string) => new Date(s).toISOString();
const dollars = (cents: number) => `$${centsToUsd(cents).toFixed(2)}`;

const policyOf = (s: Summary) => ({
  max_bounty_usd: centsToUsd(s.max_bounty_cents),
  daily_cap_usd: centsToUsd(s.daily_cap_cents),
  spent_today_usd: centsToUsd(s.spent_today_cents),
  remaining_today_usd: centsToUsd(Math.max(0, s.daily_cap_cents - s.spent_today_cents)),
  allowed_task_types: s.allowed_task_types,
});

const MIN_BOUNTY_CENTS = 100;

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
    photo_url: submission.photo_url,
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

  const topUpUrl = (agentId: string) =>
    `${config.public_api_url}/topup/${signToken(config.link_secret, `t:${agentId}`)}`;
  const connectUrl = (workerId: string) =>
    `${config.public_api_url}/w/connect/${signToken(config.link_secret, `c:${workerId}`, new Date(now().getTime() + CONNECT_LINK_MS))}`;
  const captureUrl = (task: Task, workerId: string) =>
    `${config.worker_web_url}/capture.html?t=${signToken(config.link_secret, `o:${task.id}:${workerId}`, new Date(task.deadline_at))}`;

  const newApiKey = () =>
    `${config.test_mode ? "eyes_test_" : "eyes_live_"}${randomBytes(32).toString("base64url")}`;

  const ownerUrl = (agentId: string) =>
    `${config.public_api_url}/owner/${signToken(config.link_secret, `p:${agentId}`)}`;

  function tokenPayload(token: string, kind: "t" | "c" | "o" | "p"): string | null {
    const payload = verifyToken(config.link_secret, token, now());
    return payload?.startsWith(`${kind}:`) ? payload.slice(kind.length + 1) : null;
  }

  function ownerAgentId(token: string): string {
    const agentId = tokenPayload(token, "p");
    if (!agentId) throw new EyesError("owner_link_invalid");
    return agentId;
  }

  async function emailOwner(to: string, agent: Agent, subject: string, intro: string): Promise<boolean> {
    try {
      await providers.email.send({
        to,
        subject,
        text: [
          intro,
          "Eyes lets AI agents pay a nearby person a few dollars to check something in the real world right now, such as whether a store is open or how long a line is. Each task is paid from the agent's prepaid balance.",
          `Your private control link:\n${ownerUrl(agent.id)}`,
          "There you can see the balance and every task, set the most the agent may pay per task, set a daily spending cap (a cap of 0 stops all spending), choose which kinds of tasks it may post, and add funds.",
          "Keep this link secret, and do not give it to your agent: anyone who has it can change these limits. Whoever pays for this agent also gets this link.",
        ].join("\n\n"),
      });
      return true;
    } catch (err) {
      console.error(
        `owner email for agent ${agent.id} failed: ${err instanceof Error ? err.name : "unknown"}`,
      );
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
    });

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
      return new EyesError("daily_cap_exceeded", {
        daily_cap_usd: centsToUsd(c.daily_cap_cents),
        spent_today_usd: centsToUsd(c.spent_today_cents),
        remaining_today_usd: centsToUsd(Math.max(0, c.daily_cap_cents - c.spent_today_cents)),
      });
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
    await send().catch(() => console.error(`text to the worker for task ${taskId} failed`));
  }

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
    const { id, place_label, bounty_cents } = paid;
    await textWorker(worker, id, () =>
      messaging.sendPaid(worker.phone, { task_id: id, place_label, amount_cents: bounty_cents }),
    );
    return paid;
  }

  async function settle(task: Task, worker: Worker): Promise<Task> {
    if (task.status !== "verified") return task;
    const { stripe_account_id } = worker;
    if (stripe_account_id) return payOut(task, { ...worker, stripe_account_id });
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
              agent,
              "Your AI agent's Eyes spending controls",
              `Your AI agent ${JSON.stringify(agent.name)} signed up for Eyes and listed this address as its owner.`,
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
        question: `${task_type.replaceAll("_", " ")} at ${place.label}`,
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
      const place = await resolve(ask.location);
      const verdict = await deps.assessTask({
        question: ask.question,
        task_type: ask.task_type,
        place_label: place.label,
      });
      if (!verdict.allowed) {
        throw new EyesError(
          "unsafe_task",
          { category: verdict.category, reason: verdict.reason },
          { fix: verdict.fix ?? undefined },
        );
      }
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
        p_idempotency_key: ask.idempotency_key ?? null,
        p_worker_ids: workers.map((w) => w.worker_id),
        p_now: nowIso(),
      }).catch((err) => {
        throw agentFacing(err, agent.id);
      });
      const { task } = posted;
      let notified = posted.workers_notified;
      if (posted.created) {
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
            }),
          ),
        );
        notified = sent.filter((s) => s.status === "fulfilled").length;
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
          "Recorded. The task is flagged for human review. If the worker payout has not been sent yet it is held; a payout already sent is not reversed automatically. Call get_task later to see the outcome.",
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
          { message: "This top-up link is invalid.", fix: "Call get_balance to get a fresh top_up_url." },
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
      const agent = await one<Agent>("eyes_credit_topup", {
        p_agent_id: agent_id,
        p_amount_cents: amount_cents,
        p_stripe_ref: stripe_ref,
        p_now: nowIso(),
      });
      if (!payer_email) return;
      await emailOwner(
        payer_email,
        agent,
        `You added ${dollars(amount_cents)} to your AI agent's Eyes balance`,
        `Thank you for adding ${dollars(amount_cents)} to the Eyes balance of your AI agent ${JSON.stringify(agent.name)}. Because you pay for it, you also get its owner controls.`,
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
      const worker = await one<Worker>("eyes_join_worker", {
        p_name: join.name,
        p_phone: join.phone,
        p_lat: join.lat,
        p_lng: join.lng,
        p_now: nowIso(),
      });
      return {
        worker_id: worker.id,
        opt_in_instructions:
          "Text START to the Eyes number to start getting paid tasks near you; we reply with your payout setup link. When a task text arrives, reply YES to claim it. Text STOP any time to pause.",
        inkbox_number: null,
        connect_url: null,
      };
    },

    async workerConnectUrl(token) {
      const workerId = tokenPayload(token, "c");
      if (!workerId)
        throw new EyesError("offer_invalid", {}, { message: "This payout setup link is invalid." });
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

    async handleWorkerReply({ phone, intent }) {
      const worker = await maybe<Worker>("eyes_worker", { p_worker_id: null, p_phone: phone });
      if (!worker) {
        if (intent === "stop") return;
        await messaging.sendText(
          phone,
          `You are not signed up for Eyes yet. Join at ${config.worker_web_url} to get paid tasks near you.`,
        );
        return;
      }
      if (!worker.opted_in && intent !== "start") return;
      const reply: Record<ReplyIntent, () => Promise<unknown>> = {
        start: async () => {
          await rpc("eyes_set_worker_opt_in", { p_phone: phone, p_opted_in: true });
          await messaging.sendText(
            phone,
            `You are in. Eyes will text you paid tasks nearby. Set up payouts here: ${connectUrl(worker.id)}`,
          );
        },
        stop: async () => {
          await rpc("eyes_set_worker_opt_in", { p_phone: phone, p_opted_in: false });
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
        },
        help: () => messaging.sendText(phone, `${REPLY_TEXT.help} More: ${config.worker_web_url}`),
        unknown: () => messaging.sendText(phone, REPLY_TEXT.unknown),
      };
      await reply[intent]();
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
      if (faces) {
        await providers.storage
          .deletePhoto({ key })
          .catch(() => console.error(`photo delete for task ${task.id} failed`));
      }
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
      });
      const worker = await one<Worker>("eyes_worker", { p_worker_id: workerId, p_phone: null });
      const settled = await settle(submitted, worker);
      const amount = dollars(settled.bounty_cents);
      const message =
        settled.status === "paid"
          ? `Verified and paid. ${amount} is on its way to your account. Thank you!`
          : settled.status === "needs_review"
            ? `Thanks, we got it. Your answer needs a quick manual check (${v.vision_reason}). You will be paid once it is approved.`
            : worker.stripe_account_id
              ? `Verified. Your ${amount} payout did not go through yet; it will be retried.`
              : worker.opted_in
                ? `Verified. We texted you a link to set up payouts; your ${amount} is sent automatically once that is done.`
                : `Verified. To get your ${amount}, set up payouts here: ${connectUrl(worker.id)}`;
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

    async resolveTask(task_id, decision, note) {
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
    },
  };
}
