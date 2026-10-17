import { randomInt, randomUUID } from "node:crypto";
import {
  type Agent,
  type EngineDeps,
  EyesError,
  type EyesService,
  FAKE_PLACES,
  type LatLng,
  type RouteDeps,
  signToken,
  TaskType,
  type ToolInput,
} from "@eyes/core";
import { createEyesService } from "@eyes/engine";

const CAPTURE_DELAY_MS = 5000;
const ANSWER_IN = `A simulated worker answers each task in about ${CAPTURE_DELAY_MS / 1000} seconds.`;
export const SANDBOX = "Sandbox: keyless, simulated worker, no real people or money.";
export const SANDBOX_NOTICE = `${SANDBOX} Call /mcp or /v1 with no Authorization header to get a sandbox agent with play money. ${ANSWER_IN} quote_task counts the worker ask_eyes adds when none is free nearby, so workers_nearby is at least 1. Place names resolve only for ${Object.values(
  FAKE_PLACES,
)
  .map((place) => `"${place.label}"`)
  .join(", ")}; pass {lat, lng} for any other place.`;

const SANDBOX_PHONE = /^\+1[2-9]\d{2}55501\d{2}$/;
const ASK_TIMEOUT_MS = 15_000;
const ASK_QUEUE_MAX = 10;
const ASK_RETRY_S = 15;
const HIRE_TRIES = 3;
const KEYLESS_TTL_MS = 60 * 60 * 1000;
const KEYLESS_MAX = 10_000;
const KEYLESS_PER_MINUTE = 30;
const MINUTE_MS = 60_000;
const SANDBOX_FLOOR_CENTS = 10_000;
const SANDBOX_CREDIT_CENTS = 100_000;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const ANSWERS: Record<TaskType, string> = {
  is_open: "Open right now.",
  line_length: "About 4 people in line.",
  in_stock: "In stock, a full shelf.",
  photo_of_place: "Photo of the entrance attached.",
  price_check: "$4.99 on the shelf tag.",
  crowd_level: "Moderately busy, about 20 people.",
  other_public: "Checked, nothing unusual right now.",
};

const errorName = (err: unknown) =>
  err instanceof EyesError ? `${err.name} ${err.code}` : err instanceof Error ? err.name : typeof err;

const sandboxed = <T extends { next_step: string }>(out: T): T => ({
  ...out,
  next_step: `${SANDBOX} ${ANSWER_IN} ${out.next_step}`,
});

export function createSandboxService(deps: EngineDeps): EyesService {
  const { messaging, clock } = deps.providers;
  let queue: Promise<unknown> = Promise.resolve();
  let queued = 0;
  const busy = (message: string) =>
    new EyesError(
      "rate_limited",
      { retry_after_s: ASK_RETRY_S },
      { message, fix: `Wait ${ASK_RETRY_S} seconds and call ask_eyes again with the same idempotency_key.` },
    );
  const serial = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (queued >= ASK_QUEUE_MAX) throw busy(`The sandbox already has ${ASK_QUEUE_MAX} asks waiting.`);
    queued += 1;
    const run = queue
      .then(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(busy("The sandbox ask took too long.")), ASK_TIMEOUT_MS);
        });
        return Promise.race([fn(), late]).finally(() => clearTimeout(timer));
      })
      .finally(() => {
        queued -= 1;
      });
    queue = run.catch(() => undefined);
    return run;
  };

  async function capture(captureUrl: string) {
    const token = new URL(captureUrl).searchParams.get("t") ?? "";
    try {
      const offer = await service.getOffer(token);
      await service.submitCapture(
        token,
        {
          lat: offer.lat,
          lng: offer.lng,
          accuracy_m: 5,
          captured_at: clock.now().toISOString(),
          answer_text: `Simulated sandbox answer, nobody went: ${ANSWERS[offer.task_type]}`,
          answer_bool: null,
        },
        { bytes: JPEG, content_type: "image/jpeg" },
      );
    } catch (err) {
      console.error(`sandbox capture failed: ${errorName(err)}`);
    }
  }

  const service: EyesService = createEyesService({
    ...deps,
    providers: {
      ...deps.providers,
      messaging: {
        ...messaging,
        sendOffer: async (to, offer) => {
          const sent = await messaging.sendOffer(to, offer);
          if (!SANDBOX_PHONE.test(to)) return sent;
          await service
            .handleWorkerReply({ phone: to, intent: "yes", text: "YES" })
            .catch((err) => console.error(`sandbox claim failed: ${errorName(err)}`));
          return sent;
        },
        sendCaptureLink: async (to, link) => {
          const sent = await messaging.sendCaptureLink(to, link);
          if (SANDBOX_PHONE.test(to)) setTimeout(() => capture(link.capture_url), CAPTURE_DELAY_MS);
          return sent;
        },
      },
    },
  });

  async function hire(place: LatLng) {
    const phone = `+1${randomInt(200, 1000)}55501${String(randomInt(100)).padStart(2, "0")}`;
    await service.joinWorker({ name: "Sandbox worker", phone, lat: place.lat, lng: place.lng });
    await service.handleWorkerReply({ phone, intent: "start", text: "START" });
  }

  async function hireIfNone(agent: Agent, input: ToolInput<"quote_task">) {
    let quote = await service.quoteTask(agent, input);
    for (let tries = 0; quote.allowed && quote.workers_nearby === 0 && tries < HIRE_TRIES; tries++) {
      await hire(quote.resolved_location);
      quote = await service.quoteTask(agent, input);
    }
  }

  return {
    ...service,
    quoteTask: async (agent, input) => {
      const quote = await service.quoteTask(agent, input);
      return quote.allowed && quote.workers_nearby === 0
        ? { ...quote, workers_nearby: 1, est_minutes_to_answer: 1 }
        : quote;
    },
    askEyes: (agent, input) =>
      serial(async () => {
        await hireIfNone(agent, { location: input.location, task_type: input.task_type }).catch(
          () => undefined,
        );
        return sandboxed(await service.askEyes(agent, input));
      }),
    awaitAnswer: async (agent, input, signal) => sandboxed(await service.awaitAnswer(agent, input, signal)),
  };
}

export function keylessAgents({ service, config, providers }: RouteDeps) {
  const held = new Map<string, { key: Promise<string>; at: number }>();
  let created: number[] = [];

  async function create() {
    const { agent_id, api_key } = await service.signupAgent({ name: "sandbox agent" });
    await service.updateSpendPolicy(signToken(config.link_secret, `p:${agent_id}`), {
      max_bounty_usd: 10,
      daily_cap_usd: 1000,
      allowed_task_types: TaskType.options,
    });
    return api_key;
  }

  return async (address: string) => {
    const now = providers.clock.now().getTime();
    for (const [stale, entry] of held) {
      if (entry.at > now - KEYLESS_TTL_MS && held.size < KEYLESS_MAX) break;
      held.delete(stale);
    }
    let key = held.get(address)?.key;
    held.delete(address);
    if (!key) {
      created = created.filter((at) => at > now - MINUTE_MS);
      if (created.length >= KEYLESS_PER_MINUTE) {
        const retry_after_s = Math.ceil(((created[0] ?? now) + MINUTE_MS - now) / 1000);
        throw new EyesError(
          "rate_limited",
          { retry_after_s },
          {
            fix: `The sandbox makes at most ${KEYLESS_PER_MINUTE} new keyless agents a minute. Wait ${retry_after_s} seconds and try again, or send Authorization: Bearer <api_key> from POST /v1/signup.`,
          },
        );
      }
      created.push(now);
      key = create();
      key.catch(() => held.delete(address));
    }
    held.set(address, { key, at: now });
    const agent = await service.authenticate(await key);
    if (!agent) {
      if (held.get(address)?.key === key) held.delete(address);
      return null;
    }
    if (agent.balance_cents < SANDBOX_FLOOR_CENTS) {
      await service.creditTopup({
        agent_id: agent.id,
        amount_cents: SANDBOX_CREDIT_CENTS,
        stripe_ref: `sandbox:${randomUUID()}`,
      });
    }
    return agent;
  };
}
