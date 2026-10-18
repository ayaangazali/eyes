import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIPv6 } from "node:net";
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
  distanceMeters,
  ERRORS,
  EyesError,
  FAKE_PLACES,
  GetTaskInput,
  JoinWorkerInput,
  ListTasksInput,
  QuoteTaskInput,
  type RouteDeps,
  SignupInput,
  TOOLS,
  verifyToken,
  type WorkerLocationInput,
} from "@eyes/core";
import type { Rpc } from "@eyes/db";
import { PAGE_HEADERS, stripeRoutes } from "@eyes/payments";
import { PAGE_CSS, PAGE_HEADER } from "@eyes/ui/page";
import {
  buildSeries,
  type ClickHouseSink,
  PAGE as DASHBOARD,
  type EventLog,
  type Feed,
  fallbackRows,
  type LoggedEvent,
  OPS_PAGE,
  readClickHouseSeries,
  readFeed,
  redact,
  summarize,
} from "@eyes/web-dashboard";
import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { MCPServer } from "mcp-use";
import { z } from "zod";
import { oauthRoutes } from "./oauth.ts";
import { type Operator, opsAuth } from "./ops-auth.ts";
import { WIDGET_HTML, WIDGET_MIME, WIDGET_URI, widgetResourceMeta, widgetToolMeta } from "./widget.ts";

type Env = Record<string, string | undefined>;
type AppEnv = { Variables: { agent: Agent; operator: Operator } };

const PROGRESS_INTERVAL_MS = 5000;
const HOUR_MS = 60 * 60 * 1000;
const PUBLIC_CALLS_PER_HOUR = 5;
const THROTTLE_MAX_KEYS = 10_000;
// ask_eyes over MCP: the REST result, or "not_sent" when no worker is nearby. One object (MCP tool
// outputSchema roots must be type object), so the dispatched-only fields are optional.
const dispatched = TOOLS.ask_eyes.output.shape;
const AskEyesToolOutput = z.object({
  status: z
    .enum(["dispatched", "not_sent"])
    .describe(
      '"dispatched": workers were texted and the escrow is held. "not_sent": nobody nearby, nothing created or charged.',
    ),
  task_id: dispatched.task_id.optional(),
  workers_notified: dispatched.workers_notified.optional(),
  escrowed_usd: dispatched.escrowed_usd.optional(),
  deadline_at: dispatched.deadline_at.optional(),
  next_step: dispatched.next_step.optional(),
  reason: z.literal("no_workers_nearby").optional(),
  charged_usd: z.number().optional(),
  message: z.string().optional(),
  fix: z.string().optional(),
});
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
const CLIENT_KEY_CHARS = 64;
const sha256 = (text: string) => createHash("sha256").update(text);
const coarse = (degrees: number) => Math.round(degrees * 1000) / 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEED_HEADERS = { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
function opsHeaders(page: string) {
  const script = sha256(/<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "").digest("base64");
  return {
    ...FEED_HEADERS,
    // same-origin: under no-referrer browsers send `Origin: null` on the page's own POSTs, which sameOrigin rejects.
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": `default-src 'none'; script-src https://unpkg.com 'sha256-${script}'; style-src https://unpkg.com 'unsafe-inline'; img-src https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}
const OPS_FEED_LIMIT = 500;
const OPS_RECENT = 50;
export const SMOKE_UA = "eyes-smoke/";
const OPS_EVENTS = 200;
const TicketAction = z.object({
  ticket_id: z.coerce.number().int().positive(),
  outcome: z.enum(["release", "refund", "close"]),
  task_id: z.uuid(),
  note: z.string().trim().min(1).max(500),
});
const DisputeAction = z.object({
  ticket_id: z.coerce.number().int().positive(),
  note: z.string().trim().min(1).max(500),
});
type Ticket = {
  worker_id: string;
  lat: number;
  lng: number;
  submission_lat: number | null;
  submission_lng: number | null;
  [key: string]: unknown;
};
const PROVIDER_LINES = {
  messaging: ["Texting", "Task texts to workers' phones and their YES replies (Inkbox)."],
  email: ["Agent email", "Questions agents email in and the threaded answers (Primitive)."],
  payments: ["Payments", "Agent top-ups and payouts to workers (Stripe)."],
  storage: ["Photo storage", "Where answer photos are kept (InsForge)."],
  vision: ["Photo checks", "The AI check that a photo is safe to share (Cloudflare clef, or Claude)."],
  geo: ["Place lookup", "Turning place names into map points (OpenStreetMap)."],
} as const;
const SIMULATED = {
  messaging: "Texting is simulated: no worker gets a text, so no task gets answered.",
  payments: "Payments are simulated: no real money moves.",
  email: "Email is simulated: no email is sent, including the owner's control link.",
  geo: `Place lookup is simulated: only {lat, lng} coordinates and these demo places resolve: ${Object.values(
    FAKE_PLACES,
  )
    .map((place) => `"${place.label}"`)
    .join(", ")}.`,
} as const;

const layout = (title: string, body: HtmlEscapedString | Promise<HtmlEscapedString>) => html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title><style>${raw(PAGE_CSS)}</style></head>
<body class="ui">${raw(PAGE_HEADER)}
<main class="page">${body}</main>
</body>
</html>
`;

type Live = ReturnType<typeof liveProviders>;

const simulatedNotice = (live: Live) => {
  const fake = (Object.keys(SIMULATED) as (keyof typeof SIMULATED)[]).filter((name) => !live[name]);
  return fake.length
    ? html`<section class="box"><h2>This is a simulated deploy</h2><ul>${fake.map((name) => html`<li>${SIMULATED[name]}</li>`)}</ul></section>`
    : "";
};

const homePage = (joinUrl: string, live: Live, classifier: boolean) =>
  layout(
    "Eyes API",
    html`<p class="eyebrow">api.eyes.pictures</p>
<h1>AI agents pay people nearby about $3 to check public places.</h1>
<p>Is the cafe open? How long is the line? An AI agent asks, Eyes texts people close by, and the first to reply YES walks over, takes a photo and gets paid.</p>
${simulatedNotice(live)}
<h2>For AI agents</h2>
<p>Connect over MCP: <code>POST /mcp</code> with <code>Authorization: Bearer &lt;api_key&gt;</code>. No key yet? <code>POST /v1/signup</code>.</p>
<ul class="docs">
<li><a href="/llms.txt">llms.txt</a><span>Everything an agent needs, in one file</span></li>
<li><a href="/openapi.json">openapi.json</a><span>REST routes and schemas</span></li>
<li><a href="${AGENT_CARD}">agent-card.json</a><span>A2A agent card</span></li>
<li><a href="/agents.md">agents.md</a><span>How agents should use Eyes</span></li>
</ul>
<h2>For people</h2>
<div class="cta"><a class="button" href="${joinUrl}">Join to get paid tasks</a><a class="button button--quiet" href="https://eyes.pictures">What is Eyes?</a></div>
<section class="box">
<h2>Got a text from Eyes?</h2>
<p>Reply <b>YES</b> to claim the task, or ignore it. Reply <b>STOP</b> to stop all texts from Eyes, and START to get them again.</p>
</section>
<p class="muted">Only public places: stores, cafes, parks, transit stops. Never people, homes or cars. ${classifier ? "Every task passes the safety rules and an AI safety classifier before any money moves." : "Safety review is rules only here: the AI safety classifier is off, so only the safety rules check each task."}</p>
<p class="muted"><a href="/status">Service status</a></p>`,
  );

const statusPage = (live: Live, classifier: boolean, db: string, commit: string | undefined) =>
  layout(
    "Eyes status",
    html`<h1>Service status</h1>
<p>Eyes is up. A live part uses the real service. A simulated part is a test stand-in: nothing real is sent, charged or stored through it.</p>
${simulatedNotice(live)}
<ul class="rows">
${Object.entries(PROVIDER_LINES).map(([name, [label, meaning]]) => {
  const on = live[name as keyof typeof live];
  return html`<li><b class="state${on ? " live" : ""}">${label}: ${on ? "live" : "simulated"}</b><br><span class="muted">${meaning}</span></li>`;
})}
<li><b class="state${classifier ? " live" : ""}">Safety review: ${classifier ? "rules and AI classifier" : "rules only"}</b><br><span class="muted">Checks every task before any money moves: the safety rules, then the AI classifier (Cloudflare clef, or Claude) when it is on.</span></li>
<li><b>Database: ${db === "postgres" ? "Postgres" : "InsForge"}</b><br><span class="muted">Tasks, balances and the money ledger.</span></li>
<li><b>Deployed commit: ${commit ? html`<code>${commit.slice(0, 12)}</code>` : "not recorded"}</b></li>
</ul>
<p class="muted">For machines: <a href="/healthz">/healthz</a></p>`,
  );

function clientKey(forwardedFor: string | undefined) {
  const address = forwardedFor?.split(",").at(-1)?.trim() ?? "";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return mapped;
  if (!isIPv6(address)) return address.slice(0, CLIENT_KEY_CHARS);
  const [head, tail] = address.replace(/\d+\.\d+\.\d+\.\d+$/, "0:0").split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

const INSTRUCTIONS = `Eyes pays a nearby human to check something in the physical world right now (is it open, how long is the line, is it in stock, how crowded is it) and returns their answer with a live photo. Eyes checks location, freshness and that the photo is safe to share; it does not judge whether the answer is correct. Look at the photo, and call dispute_answer if it is wrong.
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
    vision: live && Boolean((env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) || env.ANTHROPIC_API_KEY),
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
  throw new EyesError(
    "invalid_input",
    { issues },
    {
      fix: [
        ERRORS.invalid_input.fix,
        ...issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)),
      ].join(" "),
    },
  );
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

export function createServer(
  deps: RouteDeps & {
    env: Env;
    rpc?: Rpc;
    events?: EventLog;
    clickhouse?: Pick<ClickHouseSink, "query" | "dropped">;
  },
) {
  const { service, config, env } = deps;
  const log = deps.events?.log ?? (() => {});
  const server = new MCPServer<never, AppEnv>({
    name: "eyes",
    title: "Eyes",
    version: "0.1.0",
    description: "Pay a nearby human a few dollars to check something in the physical world right now.",
    instructions: INSTRUCTIONS,
    logging: { enabled: false },
  });

  // Every request, without the query string and with token-looking path segments masked. The ops
  // page's own polling is skipped so the log is not mostly the dashboard reading itself.
  server.app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    const path = c.req.path
      .split("/")
      .map((s) => (s.length >= 20 && !UUID.test(s) ? ":token" : s))
      .join("/");
    if (/^\/ops\/(feed|events)$/.test(path)) return;
    const status = c.res.status;
    const ms = Math.round(performance.now() - started);
    const webhook = /^\/webhooks\/(\w+)/.exec(path)?.[1];
    // smoke:live sends unsigned webhooks and bad OAuth on purpose; 404s are scanners. Neither is our fault,
    // so they log as info (still searchable by status) and never count as warnings. 5xx always stays an error.
    const probe = c.req.header("user-agent")?.startsWith(SMOKE_UA) ?? false;
    log({
      kind: webhook ? "webhook" : "http",
      level: status >= 500 ? "error" : status >= 400 && status !== 404 && !probe ? "warn" : "info",
      summary:
        (webhook
          ? `${webhook} ${status < 400 ? "accepted" : status} (${ms} ms)`
          : `${c.req.method} ${path} ${status} ${ms} ms`) + (probe ? " (smoke probe)" : ""),
      data: {
        method: c.req.method,
        path,
        status,
        ms,
        ...(probe && { probe: true }),
        ...(webhook && { provider: webhook }),
        // Location posts: a coarse device hint to tell a worker's devices apart (no IP, no coordinates).
        ...(/^\/(w|v1\/worker)\/location$/.test(path) && {
          ua: c.req.header("user-agent")?.slice(0, 60) ?? null,
        }),
      },
    });
  });

  server.app.onError((err, c) => {
    const e = toEyesError(err);
    return c.json(e.toBody(), e.status as ContentfulStatusCode);
  });

  server.use("*", async (c, next) => {
    await next();
    if (c.res.status !== 404 || !c.res.headers.get("content-type")?.startsWith("text/plain")) return;
    // Browsers get a page with a way out; API clients keep the JSON error below.
    if (c.req.header("accept")?.includes("text/html")) {
      c.res = await c.html(
        layout(
          "Page not found",
          html`<section class="notice-page"><h1>Page not found</h1><p>This address is not part of Eyes. If you followed a link from a text, open the newest one Eyes sent you.</p><a class="button" href="https://eyes.pictures">Go to eyes.pictures</a></section>`,
        ),
        404,
        PAGE_HEADERS,
      );
      return;
    }
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
    if (c.req.method === "POST" && (c.req.path === "/v1/signup" || c.req.path === "/v1/worker/location"))
      return next();
    const key = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const agent = key ? await service.authenticate(key) : null;
    if (!agent)
      return c.json(new EyesError("unauthorized").toBody(), 401, {
        "WWW-Authenticate": `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", config.public_api_url).href}"`,
      });
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
Returns workers_nearby, est_minutes_to_answer, suggested_bounty_usd, allowed, reason_if_not and resolved_location (where Eyes thinks you mean).
suggested_bounty_usd already fits this API key's max_bounty_usd, the daily cap left and your balance, so ask_eyes accepts it. allowed is false only when you cannot post this task right now: the safety rules refuse this task_type at this place, the task_type is not allowed for this key, or even the 1 USD minimum bounty plus the 0.50 USD fee does not fit your limits or balance; reason_if_not says what to do. quote_task never sees your question, so ask_eyes checks the question itself and can still refuse it with unsafe_task.
location is {lat, lng} or a string such as "Blue Bottle Coffee, Mint Plaza, San Francisco". task_type is one of: is_open, line_length, in_stock, photo_of_place, price_check, crowd_level, other_public.
Example: quote_task({ "location": "Ferry Building, San Francisco", "task_type": "line_length" })
Next: if allowed is true and workers_nearby > 0, call ask_eyes with the same location and task_type, using suggested_bounty_usd as bounty_usd. If resolved_location is not the place you meant, retry with a more specific string or {lat, lng}. If workers_nearby is 0, try a nearby busier place or later.`,
      inputSchema: TOOLS.quote_task.input,
      outputSchema: TOOLS.quote_task.output,
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: widgetToolMeta("Checking the place", "Quote ready"),
    },
    (input, ctx) => run(() => service.quoteTask(ctx.get("agent"), input)),
  );

  server.tool(
    {
      name: "ask_eyes",
      title: "Ask a human to check",
      description: `Pay a nearby human to look at a public place right now and answer your question, usually with a live photo. Eyes texts nearby workers; the first to accept walks over and captures the answer on site. Eyes checks location (GPS within about 150 m), freshness (photo taken live before the deadline) and that the photo is safe to share; it does not judge whether the answer is correct. Look at the photo, and call dispute_answer if it is wrong.
Money: bounty_usd (default 3) plus a 0.50 USD fee is escrowed from your balance now. The worker is paid only after a verified answer. If nobody answers before deadline_minutes (default 30), or you cancel_task before a worker claims it, everything is refunded.
Only public, commercial or civic places: stores, cafes, parks, transit stops, venues. Never specific private people, homes, vehicles or private property; those are refused with an unsafe_task error.
idempotency_key is required: any unique string for each task you intend to create, for example a UUID. Reuse the same key when you retry that task: the same key and parameters return the original task instead of charging again, so retries after a timeout or network error are safe. Use a new key for a new question.
Example: ask_eyes({ "question": "How many people are waiting in line right now?", "location": "Blue Bottle Coffee, Mint Plaza, San Francisco", "task_type": "line_length", "bounty_usd": 3, "idempotency_key": "6f1c2a9e-line-check" })
If no worker is near the place right now, nothing is created or charged: the result has status "not_sent", reason "no_workers_nearby", charged_usd 0, message and fix, and no task_id.
Next: if status is "dispatched", immediately call await_answer with the returned task_id and keep calling it until answered is true. If status is "not_sent", tell your user nobody is nearby and follow fix (a busier place, or later).`,
      inputSchema: TOOLS.ask_eyes.input,
      outputSchema: AskEyesToolOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: widgetToolMeta("Texting nearby workers", "Task posted"),
    },
    // MCP only: no workers nearby is an answer, not a tool failure (nothing created or charged), so
    // hosts do not show "Failed". REST /v1/tasks keeps the 409 error.
    (input, ctx) =>
      run(async (): Promise<z.output<typeof AskEyesToolOutput>> => {
        try {
          return await service.askEyes(ctx.get("agent"), input);
        } catch (err) {
          if (!(err instanceof EyesError && err.code === "no_workers_nearby")) throw err;
          return {
            status: "not_sent",
            reason: "no_workers_nearby",
            charged_usd: 0,
            message: err.message,
            fix: err.fix,
          };
        }
      }),
  );

  server.tool(
    {
      name: "await_answer",
      title: "Wait for the answer",
      description: `Wait for the answer to a task you created with ask_eyes. Call it immediately after ask_eyes, then keep calling it with the same task_id until answered is true or the status is expired, refunded or disputed. You cannot watch for events in the background, so this loop is the only way to receive the answer.
Each call waits up to timeout_seconds (default 50, max 55) and returns as soon as the answer arrives. A task usually takes 5 to 20 minutes. deadline_at (from ask_eyes) is the latest time a worker can still answer; a human review outcome can come later.
How to read the result:
- answered true: stop calling. answer holds answer_text, answer_bool, photo_url, captured_at, worker_distance_m, verification, confidence and cost_usd. Show your user the answer and photo_url. Eyes checks location, freshness and that the photo is safe to share; it does not judge whether the answer is correct. Look at the photo yourself, and call dispute_answer if it is wrong.
- Then check answer.verification. If gps_ok, fresh_ok and vision_ok (the photo is safe to share) are all true, the worker is paid (status verified or paid). If any is false, status is needs_review: a check failed (vision_reason says why when the photo was blocked, and a blocked photo is not delivered). Your escrow stays held until a human review settles it, either paid to the worker or refunded to you. Tell your user and check get_task later.
- answered false with status dispatched, claimed or submitted: call await_answer again right away, and give your user a one-line progress update about every other call.
- status expired: nobody answered before the deadline; your escrow was refunded. Stop calling; ask again later, at a busier place or with a higher bounty_usd.
- status refunded: you cancelled the task and the escrow was refunded. Stop calling.
- status disputed: you disputed this answer and it is under human review. Stop calling and check get_task later.
Example: await_answer({ "task_id": "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b" })
Next: follow next_step in the response.`,
      inputSchema: TOOLS.await_answer.input,
      outputSchema: TOOLS.await_answer.output,
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: widgetToolMeta("Waiting for the answer", "Task updated"),
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
      _meta: widgetToolMeta("Looking up the task", "Task loaded"),
    },
    (input, ctx) => run(() => service.getTask(ctx.get("agent"), input)),
  );

  server.tool(
    {
      name: "list_tasks",
      title: "List your tasks",
      description: `List the tasks this API key created, newest first, with task_id, status, question, place_label, bounty_usd, created_at, deadline_at and answered. Read-only and instant. You only ever see your own tasks.
Call it when you lost a task_id (context reset, crash, restart) and before you ask a question again, so you resume an open task instead of paying twice. Find yours by question and place_label.
status keeps only tasks in that status, for example "dispatched" for tasks no worker has claimed yet. limit is 1 to 50 (default 20); raise it if the task you want is older.
Example: list_tasks({ "status": "dispatched", "limit": 5 })
Next: for a task with status dispatched, claimed or submitted, call await_answer with its task_id. For a task where answered is true, call get_task to read the answer. Call ask_eyes only if no listed task covers your question.`,
      inputSchema: TOOLS.list_tasks.input,
      outputSchema: TOOLS.list_tasks.output,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input, ctx) => run(() => service.listTasks(ctx.get("agent"), input)),
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
      description: `Flag a delivered answer as wrong or fake. Eyes does not check whether answers are correct, so this is how a wrong answer gets reviewed. If the worker has not been paid yet, the payout is held, and a person reviews the dispute. If they confirm the answer was fake, the full bounty and fee are refunded to your balance. get_task shows dispute.status: open, upheld (refunded) or rejected (the answer stands). Works on tasks whose status is verified, paid or needs_review. Give a specific reason of at least 5 characters.
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
      _meta: widgetToolMeta("Checking your balance", "Balance loaded"),
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

  const publicBase = config.public_api_url.replace(/\/$/, "");
  server.resource(
    {
      name: "eyes-card",
      uri: WIDGET_URI,
      title: "Eyes card",
      mimeType: WIDGET_MIME,
      _meta: widgetResourceMeta(publicBase, false),
    },
    // Same Claude test as mcp-use's own views: the per-request client name (2026 protocol), else the
    // HTTP user agent. Undetected Claude gets no ui.domain, which renders in the default sandbox.
    (_uri, ctx) => {
      const claude = [ctx.client.info().name, ctx.req?.header("user-agent")].some((s) =>
        /claude/i.test(s ?? ""),
      );
      const _meta = widgetResourceMeta(publicBase, claude);
      return { contents: [{ uri: WIDGET_URI, mimeType: WIDGET_MIME, text: WIDGET_HTML, _meta }] };
    },
  );
  // mcp-use strips `_meta.ui.resourceUri` from tools that have no mcp-use `view` (a React build), so
  // put the MCP Apps link back on the tools that carry the ChatGPT template.
  server.use("mcp:tools/list", async (_ctx, next) =>
    (await next()).map((tool) =>
      tool._meta?.["openai/outputTemplate"] === WIDGET_URI
        ? { ...tool, _meta: { ...tool._meta, ui: { resourceUri: WIDGET_URI }, "ui/resourceUri": WIDGET_URI } }
        : tool,
    ),
  );

  const hits = new Map<string, number[]>();
  const throttle = (c: Context, path = c.req.path) => {
    const now = deps.providers.clock.now().getTime();
    for (const [key, times] of hits) {
      if ((times.at(-1) ?? 0) > now - HOUR_MS && hits.size < THROTTLE_MAX_KEYS) break;
      hits.delete(key);
    }
    const key = `${path} ${clientKey(c.req.header("x-forwarded-for"))}`;
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
  if (env.EYES_OAUTH_SECRET) {
    if (env.EYES_OAUTH_SECRET.length < 32)
      throw new Error("EYES_OAUTH_SECRET must be at least 32 characters.");
    oauthRoutes(server.app, {
      base: publicBase,
      secret: env.EYES_OAUTH_SECRET,
      validKey: async (key) => (await service.authenticate(key)) !== null,
      signup: async (c, name) => {
        throttle(c, "/v1/signup");
        return service.signupAgent({ name: name.length >= 2 ? name : "MCP client" });
      },
      layout,
    });
  }
  server.post("/v1/quote", async (c) =>
    c.json(await service.quoteTask(c.get("agent"), parse(QuoteTaskInput, await readJson(c)))),
  );
  server.post("/v1/tasks", async (c) =>
    c.json(await service.askEyes(c.get("agent"), parse(AskEyesInput, await readJson(c)))),
  );
  server.get("/v1/tasks", async (c) => {
    const { status, limit } = c.req.query();
    const input = parse(ListTasksInput, {
      status: status || undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return c.json(await service.listTasks(c.get("agent"), input));
  });
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
    const number = env.INKBOX_PHONE_NUMBER;
    if (!number) {
      throw new EyesError(
        "not_implemented",
        {},
        {
          message: "Worker sign-up is not open yet.",
          fix: "Worker sign-up opens once the Eyes texting line is set up.",
        },
      );
    }
    const input = parse(JoinWorkerInput, await readJson(c));
    throttle(c);
    const joined = await service.joinWorker(input);
    return c.json({ ...joined, inkbox_number: joined.inkbox_number || number });
  });
  server.get("/w/offers/:token", async (c) => c.json(await service.getOffer(c.req.param("token"))));
  // The installed Shortcut has /v1/worker/location baked in, so that alias stays.
  for (const path of ["/w/location", "/v1/worker/location"]) {
    server.post(path, async (c) => {
      const token = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1];
      if (!token) throw new EyesError("unauthorized");
      await service.updateWorkerLocation(token, (await readJson(c)) as WorkerLocationInput);
      return c.body(null, 204);
    });
  }
  const uploads = new Set<string>();
  server.post("/w/offers/:token/capture", async (c) => {
    const token = c.req.param("token");
    if (!verifyToken(config.link_secret, token, deps.providers.clock.now()))
      throw new EyesError("offer_invalid");
    const offer = await service.getOffer(token);
    if (!offer.claimed_by_you) throw new EyesError("task_already_claimed");
    if (offer.status !== "claimed") throw new EyesError("offer_invalid", { status: offer.status });
    if (uploads.has(token)) {
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
  if (!liveProviders(env).payments && env.EYES_FAKE_WEBHOOKS !== "1") {
    server.app.post("/webhooks/stripe", (c) => c.notFound());
  }
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
  const live = liveProviders(env);
  const classifier = Boolean(
    (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN) || env.ANTHROPIC_API_KEY,
  );
  const home = homePage(config.worker_web_url, live, classifier);
  server.get("/", (c) => c.html(home, 200, { link: LINK, ...PAGE_HEADERS }));
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

  const db = env.DATABASE_URL ? "postgres" : "insforge";
  const providers = Object.fromEntries(
    Object.entries(live).map(([name, on]) => [name, on ? "live" : "fake"]),
  );
  server.get("/healthz", (c) => c.json({ ok: true, providers, db }));
  const status = statusPage(live, classifier, db, env.EYES_COMMIT);
  server.get("/status", (c) => c.html(status, 200, PAGE_HEADERS));

  const { rpc } = deps;
  if (rpc) {
    const ops = opsAuth({ rpc, providers: deps.providers, config, env, log });
    const clef = Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
    const claude = Boolean(env.ANTHROPIC_API_KEY);
    const health = {
      providers,
      db,
      classifier:
        clef && claude ? "clef, Claude when unsure" : clef ? "clef" : claude ? "Claude" : "rules only",
      commit: env.EYES_COMMIT || null,
      node: process.version,
    };
    for (const [path, page] of [
      ["/ops", OPS_PAGE],
      ["/ops/live", DASHBOARD],
    ] as const) {
      const headers = opsHeaders(page);
      server.app.get(path, ops.operator, (c) => c.html(page, 200, headers));
    }
    server.app.get("/ops/feed", ops.operator, async (c) => {
      const now = deps.providers.clock.now();
      let feed: Feed = { tasks: [], ledger: [], workers: [], totals: {} };
      let dbError: string | null = null;
      try {
        feed = (await readFeed(rpc, OPS_FEED_LIMIT)) as Feed;
      } catch (err) {
        dbError = err instanceof Error ? err.message : String(err);
        console.error("ops feed: database read failed:", dbError);
      }
      const workers = feed.workers.map((w) => ({ ...w, lat: coarse(w.lat), lng: coarse(w.lng) }));
      return c.json(
        {
          ...feed,
          tasks: feed.tasks.slice(0, OPS_RECENT),
          ledger: feed.ledger.slice(0, OPS_RECENT),
          workers,
          ops: {
            now: now.toISOString(),
            operator: c.get("operator").label,
            health: {
              ...health,
              uptime_s: Math.round(process.uptime()),
              db_error: dbError && redact(dbError),
            },
            ...summarize(feed, OPS_FEED_LIMIT, now),
            errors: (deps.events?.recent() ?? []).filter((e) => e.kind === "log").slice(0, 50),
          },
        },
        200,
        FEED_HEADERS,
      );
    });
    // Time-series panels: ClickHouse when configured and reachable, else Postgres feed + memory ring.
    server.app.get("/ops/series", ops.operator, async (c) => {
      const now = deps.providers.clock.now();
      const ch = deps.clickhouse;
      if (ch) {
        try {
          const series = buildSeries(await readClickHouseSeries(ch), now, "clickhouse");
          return c.json({ ...series, dropped: ch.dropped() }, 200, FEED_HEADERS);
        } catch (err) {
          console.error("ops series: clickhouse read failed:", err instanceof Error ? err.message : err);
        }
      }
      const feed = ((await readFeed(rpc, OPS_FEED_LIMIT).catch(() => null)) as Feed | null) ?? {
        tasks: [],
        ledger: [],
      };
      const rows = fallbackRows(deps.events?.recent() ?? [], feed);
      return c.json(
        { ...buildSeries(rows, now, "postgres"), dropped: ch?.dropped() ?? 0 },
        200,
        FEED_HEADERS,
      );
    });
    server.app.get("/ops/events", ops.operator, async (c) => {
      const q = c.req.query();
      const filter = {
        kind: q.kind || null,
        level: q.level || null,
        q: q.q?.trim() || null,
        task_id: q.task_id && UUID.test(q.task_id) ? q.task_id : null,
      };
      const before = /^\d+$/.test(q.before ?? "") ? Number(q.before) : null;
      try {
        const events = await rpc<LoggedEvent & { id: number }>("eyes_events", {
          p_limit: OPS_EVENTS,
          p_kind: filter.kind,
          p_level: filter.level,
          p_q: filter.q,
          p_task_id: filter.task_id,
          p_before: before,
        });
        return c.json({ source: "database", events }, 200, FEED_HEADERS);
      } catch (err) {
        console.error("ops events: database read failed:", err instanceof Error ? err.message : err);
        const needle = filter.q?.toLowerCase();
        const events = (deps.events?.recent() ?? []).filter(
          (e) =>
            (!filter.kind || e.kind === filter.kind) &&
            (!filter.level || e.level === filter.level) &&
            (!filter.task_id || e.task_id === filter.task_id) &&
            (!needle || `${e.summary} ${JSON.stringify(e.data)}`.toLowerCase().includes(needle)),
        );
        return c.json({ source: "memory", events: events.slice(0, OPS_EVENTS) }, 200, FEED_HEADERS);
      }
    });
    server.app.get("/ops/tickets", ops.operator, async (c) => {
      const rows = await rpc<Ticket>("eyes_tickets", { p_limit: OPS_RECENT });
      const tickets = rows.map(({ submission_lat, submission_lng, worker_id: _, ...t }) => ({
        ...t,
        distance_m:
          submission_lat == null || submission_lng == null
            ? null
            : Math.round(distanceMeters(t, { lat: submission_lat, lng: submission_lng })),
      }));
      return c.json({ tickets }, 200, FEED_HEADERS);
    });
    // Dispute tickets (ADR-026): confirm fraud (refund + reverse + ban) or reject. Each runs once;
    // a second click returns the same shape with already_resolved true and moves no money.
    for (const [action, decide] of [
      ["confirm_fraud", service.confirmFraud],
      ["reject_dispute", service.rejectDispute],
    ] as const) {
      server.app.post(`/ops/tickets/:id/${action}`, ops.sameOrigin, ops.operator, async (c) => {
        const body = parse(DisputeAction, { ...(await readJson(c)), ticket_id: c.req.param("id") });
        const operator = c.get("operator").label;
        const result = await decide({ ticket_id: body.ticket_id, note: body.note });
        log({
          kind: "ops",
          level: result.reversal === "owed" ? "warn" : "info",
          task_id: result.task_id,
          summary: `ticket #${result.ticket_id} ${action} by ${operator}${result.already_resolved ? " (already resolved)" : ""}`,
          data: { action, operator, ...result },
        });
        return c.json(result, 200, FEED_HEADERS);
      });
    }
    server.app.post("/ops/tickets/:id/:action", ops.sameOrigin, ops.operator, async (c) => {
      const { id, action } = c.req.param();
      const body = parse(TicketAction, { ...(await readJson(c)), ticket_id: id, outcome: action });
      if (body.outcome !== "close") await service.resolveTask(body.task_id, body.outcome, body.note);
      const resolved = await service.resolveTicket({
        ticket_id: body.ticket_id,
        outcome: body.outcome,
        note: body.note,
      });
      log({
        kind: "ops",
        task_id: body.task_id,
        summary: `ticket #${body.ticket_id} ${body.outcome} by ${c.get("operator").label}`,
        data: { ticket_id: body.ticket_id, outcome: body.outcome, operator: c.get("operator").label },
      });
      return c.json(resolved, 200, FEED_HEADERS);
    });
    server.app.route("/", ops.routes);
  }

  return server;
}
