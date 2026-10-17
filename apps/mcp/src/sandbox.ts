import { randomInt, randomUUID } from "node:crypto";
import {
  type Agent,
  type EngineDeps,
  EyesError,
  type EyesService,
  type LatLng,
  type RouteDeps,
  signToken,
  TaskType,
  type ToolInput,
} from "@eyes/core";
import { createEyesService } from "@eyes/engine";

const CAPTURE_DELAY_MS = 5000;
const ANSWER_IN = `a simulated worker answers each task in about ${CAPTURE_DELAY_MS / 1000} seconds`;
export const SANDBOX = "Sandbox: keyless, simulated worker, no real people or money.";
export const SANDBOX_NOTICE = `${SANDBOX} Call /mcp or /v1 with no Authorization header to get a sandbox agent with play money; ${ANSWER_IN}.`;

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
  next_step: `${SANDBOX} Here ${ANSWER_IN}. ${out.next_step}`,
});

export function createSandboxService(deps: EngineDeps): EyesService {
  const { messaging, clock } = deps.providers;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn);
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
          await service
            .handleWorkerReply({ phone: to, intent: "yes", text: "YES" })
            .catch((err) => console.error(`sandbox claim failed: ${errorName(err)}`));
          return sent;
        },
        sendCaptureLink: async (to, link) => {
          const sent = await messaging.sendCaptureLink(to, link);
          setTimeout(() => capture(link.capture_url), CAPTURE_DELAY_MS);
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

  async function quoteWithWorker(agent: Agent, input: ToolInput<"quote_task">) {
    let quote = await service.quoteTask(agent, input);
    for (let tries = 0; quote.allowed && quote.workers_nearby === 0 && tries < HIRE_TRIES; tries++) {
      await hire(quote.resolved_location);
      quote = await service.quoteTask(agent, input);
    }
    return quote;
  }

  return {
    ...service,
    quoteTask: quoteWithWorker,
    askEyes: (agent, input) =>
      serial(async () => {
        await quoteWithWorker(agent, { location: input.location, task_type: input.task_type }).catch(
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
    if (agent && agent.balance_cents < SANDBOX_FLOOR_CENTS) {
      await service.creditTopup({
        agent_id: agent.id,
        amount_cents: SANDBOX_CREDIT_CENTS,
        stripe_ref: `sandbox:${randomUUID()}`,
      });
    }
    return agent;
  };
}
