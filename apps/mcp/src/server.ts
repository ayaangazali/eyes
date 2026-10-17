import { readFile } from "node:fs/promises";
import { inkboxRoutes, primitiveRoutes } from "@eyes/comms";
import {
  type Agent,
  AskEyesInput,
  AwaitAnswerInput,
  CancelTaskInput,
  CaptureFields,
  DisputeAnswerInput,
  EyesError,
  GetTaskInput,
  JoinWorkerInput,
  QuoteTaskInput,
  type RouteDeps,
  SignupInput,
  TOOLS,
  verifyToken,
} from "@eyes/core";
import { stripeRoutes } from "@eyes/payments";
import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { MCPServer } from "mcp-use";
import type { z } from "zod";

type Env = Record<string, string | undefined>;
type AppEnv = { Variables: { agent: Agent } };

const PROGRESS_INTERVAL_MS = 5000;
const DOCS_DIR = new URL("../../../docs/public/", import.meta.url);
const DOCS = {
  "/llms.txt": "text/plain; charset=utf-8",
  "/llms-full.txt": "text/plain; charset=utf-8",
  "/openapi.json": "application/json",
  "/.well-known/agent-card.json": "application/json",
};
const STRIPE_PATHS = ["/webhooks/stripe", "/topup/:token", "/w/connect/:token"];

const INSTRUCTIONS = `Eyes pays a nearby human to check something in the physical world right now (is it open, how long is the line, is it in stock, how crowded is it) and returns a verified answer with a live photo.
Golden path: 1) quote_task to check coverage and price. 2) ask_eyes with an idempotency_key. 3) Call await_answer immediately with the task_id and keep calling it until answered is true or the status is expired or refunded; you cannot receive events in the background, so this loop is how you get the answer.
Money: the bounty plus a 0.50 USD fee is escrowed from your balance when you ask, paid to the worker only after the answer is verified, and refunded in full if nobody answers before the deadline or you cancel before a worker claims it.
Only public, commercial or civic places; never private people, homes or vehicles.
Errors: when Eyes refuses a call, the result is JSON with error, message and fix; do what fix says. When your arguments do not match a tool's schema, you get an "Input validation error" text naming each bad field: fix those fields and call again.`;

export function liveProviders(env: Env) {
  const live = env.EYES_PROVIDERS === "live";
  return {
    messaging: live && Boolean(env.INKBOX_API_KEY),
    email: live && Boolean(env.PRIMITIVE_API_KEY),
    payments: live && Boolean(env.STRIPE_SECRET_KEY),
    storage: false,
    vision: live && Boolean(env.ANTHROPIC_API_KEY),
    geo: live,
  };
}

function toEyesError(err: unknown): EyesError {
  if (err instanceof EyesError) return err;
  console.error(err);
  return new EyesError("internal_error");
}

async function run<T>(fn: () => Promise<T>) {
  try {
    const out = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(out) }], structuredContent: out };
  } catch (err) {
    const body = toEyesError(err).toBody();
    return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
  }
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  throw new EyesError("invalid_input", { issues });
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new EyesError("invalid_input", {
      issues: [{ path: "", message: "Request body is not valid JSON." }],
    });
  }
}

function imageType(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 12)).toString("latin1");
  if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (head.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return "image/webp";
  return null;
}

async function readCapture(c: Context) {
  const form = await c.req.parseBody().catch(() => {
    throw new EyesError("invalid_input", {
      issues: [
        { path: "", message: "Send multipart/form-data with the capture fields and an optional photo." },
      ],
    });
  });
  const field = (name: string) => {
    const value = form[name];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  const bool = field("answer_bool");
  const fields = parse(CaptureFields, {
    lat: field("lat"),
    lng: field("lng"),
    accuracy_m: field("accuracy_m"),
    captured_at: field("captured_at"),
    answer_text: field("answer_text") ?? null,
    answer_bool: bool === undefined ? null : bool === "true" ? true : bool === "false" ? false : bool,
  });
  const photo = form.photo;
  if (!(photo instanceof File) || photo.size === 0) return { fields, photo: null };
  const bytes = new Uint8Array(await photo.arrayBuffer());
  const content_type = imageType(bytes);
  if (!content_type) {
    throw new EyesError(
      "invalid_input",
      { issues: [{ path: "photo", message: "The photo must be a JPEG, PNG or WebP image." }] },
      { fix: "Take the photo with the capture page camera and submit again." },
    );
  }
  return { fields, photo: { bytes, content_type } };
}

export function createServer(deps: RouteDeps & { env: Env }) {
  const { service, config, env } = deps;
  const server = new MCPServer<never, AppEnv>({
    name: "eyes",
    title: "Eyes",
    version: "0.1.0",
    description: "Pay a nearby human a few dollars to check something in the physical world right now.",
    instructions: INSTRUCTIONS,
    logging: { enabled: false },
  });

  server.app.onError((err, c) => {
    const e = toEyesError(err);
    return c.json(e.toBody(), e.status as ContentfulStatusCode);
  });

  const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.req.method === "POST" && c.req.path === "/v1/signup") return next();
    const key = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const agent = key ? await service.authenticate(key) : null;
    if (!agent) return c.json(new EyesError("unauthorized").toBody(), 401);
    c.set("agent", agent);
    await next();
  };
  server.use("/mcp", auth);
  server.use("/v1/*", auth);

  server.tool(
    {
      name: "quote_task",
      title: "Quote a task",
      description: `Check whether Eyes can answer a question at a place before you spend anything. Free and read-only.
Returns workers_nearby, est_minutes_to_answer, suggested_bounty_usd, allowed (false if this API key may not post that task_type, see reason_if_not) and resolved_location (where Eyes thinks you mean).
location is {lat, lng} or a string such as "Blue Bottle Coffee, Mint Plaza, San Francisco". task_type is one of: is_open, line_length, in_stock, photo_of_place, price_check, crowd_level, other_public.
Example: quote_task({ "location": "Ferry Building, San Francisco", "task_type": "line_length" })
Next: if allowed is true and workers_nearby > 0, call ask_eyes with the same location and task_type, using suggested_bounty_usd as bounty_usd. If resolved_location is not the place you meant, retry with a more specific string or {lat, lng}. If workers_nearby is 0, try a nearby busier place or later.`,
      inputSchema: TOOLS.quote_task.input,
      outputSchema: TOOLS.quote_task.output,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input, ctx) => run(() => service.quoteTask(ctx.get("agent"), input)),
  );

  server.tool(
    {
      name: "ask_eyes",
      title: "Ask a human to check",
      description: `Pay a nearby human to look at a public place right now and answer your question, usually with a live photo. Eyes texts nearby workers; the first to accept walks over and captures the answer on site, and Eyes verifies it (GPS within about 150 m, photo taken live before the deadline, vision check) before you receive it.
Money: bounty_usd (default 3) plus a 0.50 USD fee is escrowed from your balance now. The worker is paid only after a verified answer. If nobody answers before deadline_minutes (default 30), or you cancel_task before a worker claims it, everything is refunded.
Only public, commercial or civic places: stores, cafes, parks, transit stops, venues. Never specific private people, homes, vehicles or private property; those are refused with an unsafe_task error.
Always pass an idempotency_key (a unique string per question, for example a UUID). Retrying with the same idempotency_key and the same parameters returns the original task instead of charging again, so retries after a timeout or network error are safe.
Example: ask_eyes({ "question": "How many people are waiting in line right now?", "location": "Blue Bottle Coffee, Mint Plaza, San Francisco", "task_type": "line_length", "bounty_usd": 3, "idempotency_key": "6f1c2a9e-line-check" })
Next: immediately call await_answer with the returned task_id and keep calling it until answered is true.`,
      inputSchema: TOOLS.ask_eyes.input,
      outputSchema: TOOLS.ask_eyes.output,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (input, ctx) => run(() => service.askEyes(ctx.get("agent"), input)),
  );

  server.tool(
    {
      name: "await_answer",
      title: "Wait for the answer",
      description: `Wait for the answer to a task you created with ask_eyes. Call it immediately after ask_eyes, then keep calling it with the same task_id until answered is true or the status is terminal. You cannot watch for events in the background, so this loop is the only way to receive the answer.
Each call waits up to timeout_seconds (default 50, max 55) and returns as soon as the answer arrives. A task usually takes 5 to 20 minutes. deadline_at (from ask_eyes) is the latest time anything can change.
How to read the result:
- answered true: stop calling. answer holds answer_text, answer_bool, photo_url, captured_at, worker_distance_m, verification, confidence and cost_usd. Show your user the answer and photo_url. Then check answer.verification: if gps_ok, fresh_ok and vision_ok are all true the answer is verified. If any is false, status is needs_review: a worker answered but a check failed (vision_reason says why), so tell your user and consider dispute_answer.
- answered false with status dispatched, claimed or submitted: call await_answer again right away, and give your user a one-line progress update about every other call.
- status expired or refunded: nobody answered in time and the escrow was refunded. Ask again later or at a busier place.
- status disputed: you disputed this answer; stop calling.
Example: await_answer({ "task_id": "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b" })
Next: follow next_step in the response.`,
      inputSchema: TOOLS.await_answer.input,
      outputSchema: TOOLS.await_answer.output,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input, ctx) =>
      run(async () => {
        const started = Date.now();
        const report = () =>
          ctx.reportProgress(
            Math.floor((Date.now() - started) / 1000),
            input.timeout_seconds,
            "Waiting for a worker to answer",
          );
        const tick = (await report())
          ? setInterval(() => report().catch(() => false), PROGRESS_INTERVAL_MS)
          : undefined;
        try {
          return await service.awaitAnswer(ctx.get("agent"), input, ctx.signal);
        } finally {
          clearInterval(tick);
        }
      }),
  );

  server.tool(
    {
      name: "get_task",
      title: "Get task status",
      description: `Look up a task's current status and details, including the answer once there is one. Read-only and instant; it does not wait.
Statuses: dispatched (workers notified), claimed (a worker is on the way), submitted (answer received, verifying), verified or paid (answer ready), needs_review (verification inconclusive, escrow held), disputed, expired or refunded (nobody answered, money returned).
Example: get_task({ "task_id": "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b" })
Next: to wait for an answer call await_answer instead of polling get_task.`,
      inputSchema: TOOLS.get_task.input,
      outputSchema: TOOLS.get_task.output,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input, ctx) => run(() => service.getTask(ctx.get("agent"), input)),
  );

  server.tool(
    {
      name: "cancel_task",
      title: "Cancel a task",
      description: `Cancel a task that no worker has claimed yet; the full escrow (bounty plus fee) goes back to your balance. Only works while status is dispatched; once a worker has claimed it you get task_not_cancellable.
Example: cancel_task({ "task_id": "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b" })
Next: call get_balance to see the refund, or keep calling await_answer if the task was already claimed.`,
      inputSchema: TOOLS.cancel_task.input,
      outputSchema: TOOLS.cancel_task.output,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input, ctx) => run(() => service.cancelTask(ctx.get("agent"), input)),
  );

  server.tool(
    {
      name: "dispute_answer",
      title: "Dispute an answer",
      description: `Flag a delivered answer as wrong or unhelpful. The worker payout is held and the task is flagged for human review. Works on tasks whose status is verified, paid or needs_review. Give a specific reason of at least 5 characters.
Example: dispute_answer({ "task_id": "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b", "reason": "The photo shows a different cafe, not Blue Bottle." })
Next: call get_task later to see the outcome. To get a fresh answer now, call ask_eyes again with a new idempotency_key.`,
      inputSchema: TOOLS.dispute_answer.input,
      outputSchema: TOOLS.dispute_answer.output,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input, ctx) => run(() => service.disputeAnswer(ctx.get("agent"), input)),
  );

  server.tool(
    {
      name: "get_balance",
      title: "Get balance",
      description: `Show your prepaid balance and how much is escrowed in open tasks, in USD, plus top_up_url, a link your human can open to add funds. Read-only.
Example: get_balance({})
Next: if balance_usd is less than bounty_usd + 0.50, give your user top_up_url and wait for them to fund it, or lower bounty_usd.`,
      inputSchema: TOOLS.get_balance.input,
      outputSchema: TOOLS.get_balance.output,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (_input, ctx) => run(() => service.getBalance(ctx.get("agent"))),
  );

  server.tool(
    {
      name: "get_spend_policy",
      title: "Get spend policy",
      description: `Show the limits your user set on this API key: max_bounty_usd per task, daily_cap_usd, spent_today_usd and remaining_today_usd (UTC day), and the allowed_task_types you may post. Read-only.
Example: get_spend_policy({})
Next: keep bounty_usd at or below max_bounty_usd and within remaining_today_usd when you call ask_eyes, and use only allowed_task_types. Only your user can change these limits.`,
      inputSchema: TOOLS.get_spend_policy.input,
      outputSchema: TOOLS.get_spend_policy.output,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (_input, ctx) => run(() => service.getSpendPolicy(ctx.get("agent"))),
  );

  server.post("/v1/signup", async (c) =>
    c.json(await service.signupAgent(parse(SignupInput, await readJson(c)))),
  );
  server.post("/v1/quote", async (c) =>
    c.json(await service.quoteTask(c.get("agent"), parse(QuoteTaskInput, await readJson(c)))),
  );
  server.post("/v1/tasks", async (c) =>
    c.json(await service.askEyes(c.get("agent"), parse(AskEyesInput, await readJson(c)))),
  );
  server.get("/v1/tasks/:task_id", async (c) =>
    c.json(await service.getTask(c.get("agent"), parse(GetTaskInput, c.req.param()))),
  );
  server.post("/v1/tasks/:task_id/await", async (c) => {
    const input = parse(AwaitAnswerInput, { ...(await readJson(c)), ...c.req.param() });
    return c.json(await service.awaitAnswer(c.get("agent"), input, c.req.raw.signal));
  });
  server.post("/v1/tasks/:task_id/cancel", async (c) =>
    c.json(await service.cancelTask(c.get("agent"), parse(CancelTaskInput, c.req.param()))),
  );
  server.post("/v1/tasks/:task_id/dispute", async (c) => {
    const input = parse(DisputeAnswerInput, { ...(await readJson(c)), ...c.req.param() });
    return c.json(await service.disputeAnswer(c.get("agent"), input));
  });
  server.get("/v1/balance", async (c) => c.json(await service.getBalance(c.get("agent"))));
  server.get("/v1/spend-policy", async (c) => c.json(await service.getSpendPolicy(c.get("agent"))));

  server.use("/w/*", cors({ origin: new URL(config.worker_web_url).origin }));
  server.post("/w/join", async (c) =>
    c.json(await service.joinWorker(parse(JoinWorkerInput, await readJson(c)))),
  );
  server.get("/w/offers/:token", async (c) => c.json(await service.getOffer(c.req.param("token"))));
  server.post("/w/offers/:token/capture", async (c) => {
    const token = c.req.param("token");
    if (!verifyToken(config.link_secret, token, deps.providers.clock.now()))
      throw new EyesError("offer_invalid");
    const { fields, photo } = await readCapture(c);
    return c.json(await service.submitCapture(token, fields, photo));
  });

  server.app.route("/webhooks/inkbox", inkboxRoutes(deps, env));
  server.app.route("/webhooks/primitive", primitiveRoutes(deps, env));
  const stripe = stripeRoutes(deps, env);
  for (const path of STRIPE_PATHS) server.app.all(path, (c) => stripe.fetch(c.req.raw));

  for (const [path, contentType] of Object.entries(DOCS)) {
    server.get(path, async (c) => {
      const text = await readFile(new URL(`.${path}`, DOCS_DIR), "utf8").catch(() => null);
      if (text !== null) return c.body(text, 200, { "content-type": contentType });
      const missing = new EyesError(
        "not_implemented",
        { path },
        {
          message: `${path} is not published yet.`,
          fix: "Call tools/list on /mcp; every tool description explains its inputs, an example and the next step.",
        },
      );
      return c.json(missing.toBody(), 404);
    });
  }

  server.get("/healthz", (c) => {
    const providers = Object.fromEntries(
      Object.entries(liveProviders(env)).map(([name, live]) => [name, live ? "live" : "fake"]),
    );
    return c.json({ ok: true, providers, db: env.DATABASE_URL ? "postgres" : "insforge" });
  });

  return server;
}
