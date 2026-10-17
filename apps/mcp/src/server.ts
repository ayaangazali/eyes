import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
const MAX_CAPTURE_UPLOADS = 4;
const HOUR_MS = 60 * 60 * 1000;
const PUBLIC_CALLS_PER_HOUR = 5;
const THROTTLE_MAX_KEYS = 10_000;
const DOCS_DIR = fileURLToPath(new URL("../../../docs/public/", import.meta.url));
const AGENT_CARD = "/.well-known/agent-card.json";
const DOCS = {
  "/llms.txt": "text/plain; charset=utf-8",
  "/llms-full.txt": "text/plain; charset=utf-8",
  "/openapi.json": "application/json",
  [AGENT_CARD]: "application/json",
  "/agents.md": "text/markdown; charset=utf-8",
  "/robots.txt": "text/plain; charset=utf-8",
};
const LINK = '</llms.txt>; rel="describedby", </openapi.json>; rel="service-desc"';
const HOME = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Eyes</title></head>
<body>
<h1>Eyes</h1>
<p>Pay a nearby human a few dollars to check something in the physical world right now.</p>
<p>Agents: <code>POST /mcp</code> with <code>Authorization: Bearer &lt;api_key&gt;</code>. No key yet? <code>POST /v1/signup</code>.</p>
<ul>
<li><a href="/llms.txt">llms.txt</a></li>
<li><a href="/openapi.json">openapi.json</a></li>
<li><a href="${AGENT_CARD}">agent-card.json</a></li>
<li><a href="/agents.md">agents.md</a></li>
</ul>
</body>
</html>
`;

const INSTRUCTIONS = `Eyes pays a nearby human to check something in the physical world right now (is it open, how long is the line, is it in stock, how crowded is it) and returns a verified answer with a live photo.
Golden path: 1) quote_task to check coverage and price. 2) ask_eyes with an idempotency_key. 3) Call await_answer immediately with the task_id and keep calling it until answered is true or the status is expired, refunded or disputed; you cannot receive events in the background, so this loop is how you get the answer.
Money: the bounty plus a 0.50 USD fee is escrowed from your balance when you ask, paid to the worker only after the answer is verified, and refunded in full if nobody answers before the deadline or you cancel before a worker claims it. An answer that fails a verification check (status needs_review) keeps the escrow held until a human review pays the worker or refunds you.
Final statuses: expired: nobody answered before the deadline; your escrow was refunded. refunded: you cancelled; your escrow was refunded. disputed: your dispute is under human review.
Only public, commercial or civic places; never private people, homes or vehicles.
Errors: when Eyes refuses a call, the result is JSON with error, message and fix; do what fix says. When your arguments do not match a tool's schema, you get an "Input validation error" text naming each bad field: fix those fields and call again.`;

export function liveProviders(env: Env) {
  const live = env.EYES_PROVIDERS === "live";
  return {
    messaging: live && Boolean(env.INKBOX_API_KEY),
    email: live && Boolean(env.PRIMITIVE_API_KEY),
    payments: live && Boolean(env.STRIPE_SECRET_KEY),
    storage: live && Boolean(env.INSFORGE_BASE_URL && env.INSFORGE_API_KEY),
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

  server.use("*", async (c, next) => {
    await next();
    if (c.res.status !== 404 || !c.res.headers.get("content-type")?.startsWith("text/plain")) return;
    const unknown = new EyesError(
      "invalid_input",
      { path: c.req.path },
      {
        message: "Unknown route.",
        fix: "See /openapi.json for the REST routes, or call tools/list on /mcp for the MCP tools.",
      },
    );
    c.res = c.json(unknown.toBody(), 404);
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
      description: `Wait for the answer to a task you created with ask_eyes. Call it immediately after ask_eyes, then keep calling it with the same task_id until answered is true or the status is expired, refunded or disputed. You cannot watch for events in the background, so this loop is the only way to receive the answer.
Each call waits up to timeout_seconds (default 50, max 55) and returns as soon as the answer arrives. A task usually takes 5 to 20 minutes. deadline_at (from ask_eyes) is the latest time a worker can still answer; a human review outcome can come later.
How to read the result:
- answered true: stop calling. answer holds answer_text, answer_bool, photo_url, captured_at, worker_distance_m, verification, confidence and cost_usd. Show your user the answer and photo_url. If confidence is below 0.7, hedge when you relay it.
- Then check answer.verification. If gps_ok, fresh_ok and vision_ok are all true, the answer is verified (status verified or paid). If any is false, status is needs_review: a worker answered but a check failed (vision_reason says why). Your escrow stays held until a human review settles it, either paid to the worker or refunded to you. Tell your user, check get_task later, and if the answer is wrong call dispute_answer to add your reason to that review.
- answered false with status dispatched, claimed or submitted: call await_answer again right away, and give your user a one-line progress update about every other call.
- status expired: nobody answered before the deadline; your escrow was refunded. Stop calling; ask again later, at a busier place or with a higher bounty_usd.
- status refunded: you cancelled the task and the escrow was refunded. Stop calling.
- status disputed: you disputed this answer and it is under human review. Stop calling and check get_task later.
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
Statuses: dispatched (workers notified), claimed (a worker is on the way), submitted (answer received, verifying), verified or paid (answer ready), needs_review (a worker answered but a check failed; escrow held until a human review pays the worker or refunds you), disputed (under human review), expired (nobody answered before the deadline; your escrow was refunded), refunded (you cancelled; escrow refunded).
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
      description: `Flag a delivered answer as wrong or unhelpful. If the worker has not been paid yet, the payout is held; either way the task goes to human review. Works on tasks whose status is verified, paid or needs_review. Give a specific reason of at least 5 characters.
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

  const hits = new Map<string, number[]>();
  const throttle = (c: Context) => {
    const now = deps.providers.clock.now().getTime();
    for (const [key, times] of hits) {
      if ((times.at(-1) ?? 0) > now - HOUR_MS && hits.size < THROTTLE_MAX_KEYS) break;
      hits.delete(key);
    }
    const client = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "";
    const key = `${c.req.path} ${client}`;
    const recent = (hits.get(key) ?? []).filter((at) => at > now - HOUR_MS);
    if (recent.length >= PUBLIC_CALLS_PER_HOUR) {
      const until = (recent[0] ?? now) + HOUR_MS;
      const retry_after_s = Math.ceil((until - now) / 1000);
      throw new EyesError(
        "rate_limited",
        { retry_after_s },
        {
          fix: `${c.req.path} allows ${PUBLIC_CALLS_PER_HOUR} calls per hour from one address. Wait ${retry_after_s} seconds (until ${new Date(until).toISOString()}) and try again.`,
        },
      );
    }
    hits.delete(key);
    hits.set(key, [...recent, now]);
  };

  server.post("/v1/signup", async (c) => {
    const input = parse(SignupInput, await readJson(c));
    throttle(c);
    return c.json(await service.signupAgent(input));
  });
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
  server.post("/w/join", async (c) => {
    const input = parse(JoinWorkerInput, await readJson(c));
    throttle(c);
    return c.json(await service.joinWorker(input));
  });
  server.get("/w/offers/:token", async (c) => c.json(await service.getOffer(c.req.param("token"))));
  const uploads = new Set<string>();
  server.post("/w/offers/:token/capture", async (c) => {
    const token = c.req.param("token");
    if (!verifyToken(config.link_secret, token, deps.providers.clock.now()))
      throw new EyesError("offer_invalid");
    const offer = await service.getOffer(token);
    if (!offer.claimed_by_you) throw new EyesError("task_already_claimed");
    if (offer.status !== "claimed") throw new EyesError("offer_invalid", { status: offer.status });
    if (uploads.size >= MAX_CAPTURE_UPLOADS || uploads.has(token)) {
      throw new EyesError("rate_limited", { retry_after_s: 5 }, { fix: "Wait 5 seconds and submit again." });
    }
    uploads.add(token);
    try {
      const { fields, photo } = await readCapture(c);
      return c.json(await service.submitCapture(token, fields, photo));
    } finally {
      uploads.delete(token);
    }
  });

  server.app.route("/webhooks/inkbox", inkboxRoutes(deps, env));
  server.app.route("/webhooks/primitive", primitiveRoutes(deps, env));
  server.app.route("/", stripeRoutes(deps, env));

  const docsDir = env.EYES_DOCS_DIR || DOCS_DIR;
  const absolute = (key: string, value: unknown) =>
    typeof value === "string" && value.startsWith("/") && (key === "url" || key.endsWith("Url"))
      ? new URL(value, config.public_api_url).href
      : value;
  const absoluteCard = (text: string) => {
    try {
      return JSON.stringify(JSON.parse(text, absolute), null, 2);
    } catch {
      console.error(`${AGENT_CARD} is not valid JSON; serving 404`);
      return null;
    }
  };
  server.get("/", (c) => c.html(HOME, 200, { link: LINK }));
  for (const [path, contentType] of Object.entries(DOCS)) {
    server.get(path, async (c) => {
      c.header("link", LINK);
      const text = await readFile(join(docsDir, path), "utf8").catch(() => null);
      const body = text !== null && path === AGENT_CARD ? absoluteCard(text) : text;
      if (body !== null) return c.body(body, 200, { "content-type": contentType });
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
