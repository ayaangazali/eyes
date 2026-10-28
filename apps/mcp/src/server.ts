import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isIPv6 } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inkboxRoutes, primitiveRoutes } from "@eyes/comms";
import {
  type Agent,
  AskEyesDraftInput,
  AskEyesDraftOutput,
  AskEyesInput,
  AskEyesMcpOutput as AskEyesToolOutput,
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
  type Submission,
  type Task,
  TOOLS,
  verifyToken,
  type WorkerLocationInput,
  WorkerTasksQuery,
} from "@eyes/core";
import type { Rpc } from "@eyes/db";
import { PAGE_HEADERS, stripeRoutes } from "@eyes/payments";
import { PAGE_CSS, PAGE_HEADER } from "@eyes/ui/page";
import {
  buildSeries,
  type ClickHouseSink,
  type EventLog,
  type Feed,
  fallbackRows,
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
import { MCPServer, type McpMiddlewareResult } from "mcp-use";
import { z } from "zod";
import { deviceProfile, parseDeviceAttributes } from "./device-profile.ts";
import { oauthRoutes, sealer } from "./oauth.ts";
import { type Operator, opsAuth } from "./ops-auth.ts";
import { opsHost, opsOriginFor } from "./ops-host.ts";
import { opsLists } from "./ops-lists.ts";
import { createOpsSettings, type OpsSettingsStore, opsSettingsRoutes } from "./ops-settings.ts";
import {
  WIDGET_CALLABLE,
  WIDGET_HTML,
  WIDGET_MIME,
  WIDGET_URI,
  widgetResourceMeta,
  widgetToolMeta,
} from "./widget.ts";

type Env = Record<string, string | undefined>;
type AppEnv = { Variables: { agent: Agent; operator: Operator } };
type ListedTool = McpMiddlewareResult<"tools/list">[number];

const PROGRESS_INTERVAL_MS = 5000;
const HOUR_MS = 60 * 60 * 1000;
const PUBLIC_CALLS_PER_HOUR = 5;
const LOGIN_CODES_PER_HOUR = 10;
const JOINS_PER_PHONE_PER_HOUR = 3;
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const THROTTLE_MAX_KEYS = 10_000;
// Zod and the MCP SDK describe the same JSON wire schema with different TypeScript JSON types.
const { $schema: _draftInputDialect, ...draftInputSchema } = z.toJSONSchema(AskEyesDraftInput, {
  io: "input",
}) as unknown as ListedTool["inputSchema"] & { $schema?: string };
const { $schema: _draftOutputDialect, ...draftOutputSchema } = z.toJSONSchema(
  AskEyesDraftOutput,
) as unknown as NonNullable<ListedTool["outputSchema"]> & { $schema?: string };

function interactive(ctx: {
  client?: { supportsViews(): boolean; info(): { name?: string } };
  req?: { header(name: string): string | undefined };
}) {
  // Negotiated Apps support first; legacy ChatGPT/Claude requests lack the capability envelope.
  // These are presentation hints, not authentication. Non-UI automation keeps its paid API.
  if (ctx.client?.supportsViews()) return true;
  const name = ctx.client?.info().name?.toLowerCase();
  const userAgent = ctx.req?.header("user-agent") ?? "";
  return (
    name === "chatgpt" ||
    name === "openai-mcp" ||
    name === "claude-user" ||
    /^(?:openai-mcp|Claude-User)\/[\d.]+(?:\s|$)/i.test(userAgent)
  );
}
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
type OpsWorker = { lat: number | null; lng: number | null; [key: string]: unknown };
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
/** Uptime services' user agents (UptimeRobot, Better Stack, Pingdom, StatusCake, Checkly, Hetrix). */
const MONITOR_UA = /uptimerobot|betteruptime|better ?stack|pingdom|statuscake|checkly|hetrix/i;
const TicketAction = z.object({
  ticket_id: z.coerce.number().int().positive(),
  outcome: z.enum(["release", "refund", "close"]),
  task_id: z.uuid(),
  note: z.string().trim().min(1).max(500),
});
const TASK_STATUSES = [
  "dispatched",
  "claimed",
  "submitted",
  "verified",
  "paid",
  "needs_review",
  "disputed",
  "expired",
  "refunded",
];
const IssueStatus = z.object({
  status: z.enum(["resolved", "ignored", "unresolved"]),
  more: z.coerce.number().int().positive().max(100_000).optional(),
});
const DisputeAction = z.object({
  ticket_id: z.coerce.number().int().positive(),
  note: z.string().trim().min(1).max(500),
});
const TaskResolve = z.object({
  task_id: z.uuid(),
  outcome: z.enum(["release", "refund"]),
  note: z.string().trim().max(500).optional(),
});
// What resolveTask leaves behind: a second click finds one of these and moves no money.
const RESOLVED = ["verified", "paid", "refunded"];
const PROVIDER_LINES = {
  messaging: ["Texting", "Task texts to workers' phones and their YES replies (Inkbox)."],
  email: ["Email", "Questions agents email in and the threaded answers (Primitive)."],
  payments: ["Payments", "Agent top-ups and payouts to workers (Stripe)."],
  storage: ["Photos", "Where answer photos are kept (InsForge storage)."],
  vision: ["Photo moderation", "The AI check that a photo is safe to share (Cloudflare clef, or Claude)."],
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

const FAVICON = readFileSync(fileURLToPath(new URL("../../web/worker/public/favicon.svg", import.meta.url)));
// Instrument Sans for the h1 of these pages (the @font-face in @eyes/ui/page): read once at start.
const DISPLAY_FONT = readFileSync(
  new URL(
    import.meta.resolve("@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2"),
  ),
);

const layout = (
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString>,
  css = "",
) => html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title><style>${raw(PAGE_CSS + css)}</style></head>
<body class="ui">${raw(PAGE_HEADER)}
<main class="page">${body}</main>
</body>
</html>
`;

type Live = ReturnType<typeof liveProviders>;

const simulatedNotice = (live: Live) => {
  const lines = (Object.keys(SIMULATED) as (keyof typeof SIMULATED)[])
    .filter((name) => !live[name] || live[name] === "test")
    .map((name) => SIMULATED[name]);
  return lines.length
    ? html`<section class="box"><h2>This is a simulated deploy</h2><ul>${lines.map((line) => html`<li>${line}</li>`)}</ul></section>`
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

// Status rows: the dot is decoration (aria-hidden); the bold text always states the state too.
const STATUS_CSS =
  ".dot{display:inline-block;width:.5rem;height:.5rem;margin:0 .5rem .1rem 0;border-radius:50%;background:var(--eyes-text-tertiary)}.dot.live{background:var(--eyes-success-text)}.dot.simulated{background:var(--eyes-warning-text)}";
const statusRow = (
  tone: "live" | "simulated" | "neutral",
  title: string | HtmlEscapedString | Promise<HtmlEscapedString>,
  detail?: string,
) =>
  html`<li><span class="dot ${tone}" aria-hidden="true"></span><b>${title}</b>${detail ? html`<br><span class="muted">${detail}</span>` : ""}</li>`;

const statusPage = (
  live: Live,
  classifier: boolean,
  db: string,
  commit: string | undefined,
  emailNote: string | null,
) =>
  layout(
    "Eyes status",
    html`<h1>Service status</h1>
<p>Eyes is up. A live part uses the real service. A simulated part is a test stand-in: nothing real is sent, charged or stored through it.</p>
${simulatedNotice(live)}
<ul class="rows">
${Object.entries(PROVIDER_LINES).map(([name, [label, meaning]]) => {
  const on = live[name as keyof typeof live];
  const state = !on
    ? "simulated"
    : on === "test"
      ? "test mode, no real money"
      : name === "email" && emailNote
        ? `live (${emailNote})`
        : "live";
  return statusRow(on && on !== "test" ? "live" : "simulated", `${label}: ${state}`, meaning);
})}
${statusRow(
  classifier ? "live" : "neutral",
  `Safety check: ${classifier ? "rules and AI classifier" : "rules only"}`,
  "Checks every task before any money moves: the safety rules, then the AI classifier (Cloudflare clef, or Claude) when it is on.",
)}
${statusRow("live", "Database: live", `Tasks, balances and the money ledger (${db === "postgres" ? "Postgres" : "InsForge"}).`)}
${commit ? statusRow("neutral", html`Deployed commit: <code>${commit.slice(0, 12)}</code>`) : ""}
</ul>
<p class="muted">For machines: <a href="/healthz">/healthz</a></p>`,
    STATUS_CSS,
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

export function liveProviders(env: Env) {
  const live = env.EYES_PROVIDERS === "live";
  return {
    messaging: live && Boolean(env.INKBOX_API_KEY),
    email: live && Boolean(env.PRIMITIVE_API_KEY),
    payments:
      live && env.STRIPE_SECRET_KEY
        ? /^[rs]k_live_/.test(env.STRIPE_SECRET_KEY)
          ? ("live" as const)
          : ("test" as const)
        : false,
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
    settings?: OpsSettingsStore;
  },
) {
  const { service, config, env } = deps;
  const log = deps.events?.log ?? (() => {});
  const publicBase = new URL(config.public_api_url).origin;
  const mcpUrl = new URL(env.EYES_PUBLIC_MCP_URL || `${publicBase}/mcp`);
  if (mcpUrl.pathname !== "/mcp" || mcpUrl.search || mcpUrl.hash || mcpUrl.username || mcpUrl.password)
    throw new Error("EYES_PUBLIC_MCP_URL must be an origin followed by /mcp.");
  // http.ts authenticates the edge host before exposing x-forwarded-host here.
  // Keep the old API connector's issuer and card domain throughout staging.
  const mcpBase = (c?: { req?: Context["req"] }) =>
    c?.req && (c.req.header("x-forwarded-host") ?? new URL(c.req.url).host) === mcpUrl.host
      ? mcpUrl.origin
      : publicBase;
  const server = new MCPServer<never, AppEnv>({
    name: "eyes",
    title: "Eyes",
    version: "0.1.0",
    description: "Pay a nearby human a few dollars to check something in the physical world right now.",
    logging: { enabled: false },
  });

  // Before everything else: the ops host maps `/x` to `/ops/x`; other hosts redirect `/ops*` there.
  const opsSite = opsHost(
    new URL(config.public_api_url).origin,
    opsOriginFor(config.public_api_url, env.EYES_OPS_URL),
    async (req) => server.app.fetch(req),
  );
  server.app.use("*", opsSite.route);

  const browserCors = cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "MCP-Protocol-Version", "MCP-Session-Id"],
    exposeHeaders: ["WWW-Authenticate", "MCP-Session-Id"],
    credentials: false,
  });
  server.app.use("*", (c, next) => {
    const path = c.req.path;
    return (path.startsWith("/v1/") && !path.startsWith("/v1/worker/")) ||
      path === "/mcp" ||
      path.startsWith("/oauth/") ||
      /^\/\.well-known\/oauth-(protected-resource|authorization-server)(\/mcp)?$/.test(path) ||
      path === "/openapi.json"
      ? browserCors(c, next)
      : next();
  });

  // Every request, without the query string and with token-looking path segments masked. The ops
  // page's own polling is skipped so the log is not mostly the dashboard reading itself.
  server.app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    const path = c.req.path
      .replace(/^\/s\/[^/]*$/, "/s/:id")
      .split("/")
      .map((s) => (s.length >= 20 && !UUID.test(s) ? ":token" : s))
      .join("/");
    if (/^\/ops\/(feed|events)$/.test(path)) return;
    const status = c.res.status;
    const ms = Math.round(performance.now() - started);
    const webhook = /^\/webhooks\/(\w+)/.exec(path)?.[1];
    // smoke:live sends unsigned webhooks and bad OAuth on purpose; 404s are scanners. Neither is our fault,
    // so they log as info (still searchable by status) and never count as warnings. 5xx always stays an error.
    const ua = c.req.header("user-agent") ?? "";
    const probe = ua.startsWith(SMOKE_UA);
    // Uptime monitors hit /healthz every minute; the ops log hides them unless asked (see ops-lists.ts).
    const monitor = path === "/healthz" || MONITOR_UA.test(ua);
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
        ...(monitor && { monitor: true }),
        ...(webhook && { provider: webhook }),
        // Location posts: a coarse device hint to tell a worker's devices apart (no IP, no coordinates).
        ...(/^\/(w|v1\/worker)\/location$/.test(path) && {
          ua: ua.slice(0, 60) || null,
        }),
      },
    });
  });

  server.app.onError((err, c) => {
    const e = toEyesError(err);
    return c.json(e.toBody(), e.status as ContentfulStatusCode);
  });

  const mcpMethods = ["GET", "POST", "DELETE"];
  const allowedMethods = (path: string) => {
    const methods = [...new Set(server.app.routes.map((route) => route.method))].filter(
      (method) =>
        method !== "ALL" &&
        server.app.router.match(method, path)[0].some(([[, route]]) => route.method === method),
    );
    if (methods.includes("GET") && !methods.includes("HEAD")) methods.push("HEAD");
    return methods;
  };

  server.use("*", async (c, next) => {
    await next();
    if (c.req.path === "/mcp" && c.res.status === 405 && !mcpMethods.includes(c.req.method)) {
      const error = new EyesError("method_not_allowed", { path: c.req.path });
      c.res = c.json(error.toBody(), 405, { Allow: c.res.headers.get("allow") ?? mcpMethods.join(", ") });
      return;
    }
    if (c.res.status !== 404 || !c.res.headers.get("content-type")?.startsWith("text/plain")) return;
    const methods = allowedMethods(c.req.path);
    if (methods.length && !methods.includes(c.req.method)) {
      const error = new EyesError("method_not_allowed", { path: c.req.path });
      c.res = c.json(error.toBody(), 405, { Allow: methods.join(", ") });
      return;
    }
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
    const unknown = new EyesError("not_found", { path: c.req.path });
    c.res = c.json(unknown.toBody(), 404);
  });

  const oauthBox = env.EYES_OAUTH_SECRET ? sealer(env.EYES_OAUTH_SECRET) : null;
  const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (c.req.method === "POST" && (c.req.path === "/v1/signup" || c.req.path === "/v1/worker/location"))
      return next();
    const header = c.req.header("authorization");
    const key = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "")?.[1];
    const token = key ? oauthBox?.open(key, "access") : null;
    const agent =
      token && token.resource !== `${mcpBase(c)}${c.req.path}`
        ? null
        : key
          ? await service.authenticate(token?.k ?? key)
          : null;
    if (!agent)
      return c.json(new EyesError("unauthorized").toBody(), 401, {
        "WWW-Authenticate": `Bearer resource_metadata="${mcpBase(c)}/.well-known/oauth-protected-resource"${header === undefined ? "" : ', error="invalid_token"'}`,
      });
    c.set("agent", agent);
    await next();
  };
  server.use("/mcp", auth);
  server.use("/v1/*", auth);

  const dispatch = (agent: Agent, input: z.output<typeof AskEyesInput>) =>
    run(async (): Promise<z.output<typeof AskEyesToolOutput>> => {
      try {
        return await service.askEyes(agent, input);
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
    });

  server.tool(
    {
      name: "quote_task",
      title: "Quote a task",
      description: `Check whether Eyes can answer a question at a place before you spend anything. Free and read-only.
Returns workers_nearby, est_minutes_to_answer, suggested_bounty_usd, allowed, reason_if_not and resolved_location (where Eyes thinks you mean).
suggested_bounty_usd already fits this API key's max_bounty_usd, the daily cap left and your balance, so ask_eyes accepts it. allowed is false only when you cannot post this task right now: the safety rules refuse this task_type at this place, the task_type is not allowed for this key, or even the 1 USD minimum bounty plus the 0.50 USD fee does not fit your limits or balance; reason_if_not says what to do. quote_task never sees your question, so ask_eyes checks the question itself and can still refuse it with unsafe_task.
location is the public place to check: {lat, lng} or a string such as "Blue Bottle Coffee, Mint Plaza, San Francisco", never your user's location. task_type is one of: is_open, line_length, in_stock, photo_of_place, price_check, crowd_level, other_public.
Example: quote_task({ "location": "Ferry Building, San Francisco", "task_type": "line_length" })
Next: in ChatGPT, Claude or MCP Apps, show the card and let the user review and confirm; neither quoting nor preparing a draft sends a task. Non-UI automation may call ask_eyes with the same location, task_type and suggested_bounty_usd. If resolved_location is not the place you meant, retry with a more specific string or {lat, lng}. If workers_nearby is 0, try a nearby busier place or later.`,
      inputSchema: TOOLS.quote_task.input,
      outputSchema: TOOLS.quote_task.output,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: widgetToolMeta("Checking the place", "Quote ready"),
    },
    (input, ctx) => run(() => service.quoteTask(ctx.get("agent"), input)),
  );

  server.tool(
    {
      name: "ask_eyes",
      title: "Ask a human to check",
      description: `Pay a nearby human to look at a public place right now and answer your question, usually with a live photo. Eyes texts nearby workers; the first to accept walks over and captures the answer on site. Eyes checks location (GPS within about 150 m), freshness (photo taken live before the deadline) and that the photo is safe to share; it does not judge whether the answer is correct. Look at the photo, and call dispute_answer if it is wrong.
Money: bounty_usd (default 3) plus a 0.50 USD fee is escrowed from your balance now. The worker is paid only after a verified answer. If nobody answers before deadline_minutes (default 30), or you cancel_task before a worker claims it, everything is refunded. Photo requests targeting identifiable people are refused before dispatch.
Only public, commercial or civic places (stores, cafes, parks, transit stops, venues), never your user's location. Never specific private people, homes, vehicles or private property; those are refused with an unsafe_task error.
idempotency_key is required: any unique string for each task you intend to create, for example a UUID. Reuse the same key when you retry that task: the same key and parameters return the original task instead of charging again, so retries after a timeout or network error are safe. Use a new key for a new question.
Example: ask_eyes({ "question": "How many people are waiting in line right now?", "location": "Blue Bottle Coffee, Mint Plaza, San Francisco", "task_type": "line_length", "bounty_usd": 3, "idempotency_key": "6f1c2a9e-line-check" })
In ChatGPT, Claude and MCP Apps, this returns status "confirmation_required" and a read-only quote with the request's idempotency_key. Nothing is sent or charged until the user confirms in the card. Keep that intent key; never follow a successful card confirmation with another paid ask.
Errors include error, message and fix, or an "Input validation error" naming invalid fields. Use them to repair the original authorized request, not to change its goal, raise spending or bypass confirmation. After an unknown dispatch outcome, retry only the same parameters and idempotency_key.
For non-UI automation, this dispatches directly. If no worker is nearby, nothing is created or charged: status "not_sent", reason "no_workers_nearby", charged_usd 0, message and fix, and no task_id.
Successful dispatch includes resolved_location with the stored task's label, latitude and longitude. A string can resolve to another city or country; this does not block dispatch. Check that place before relying on the answer. Out-of-range coordinates, NUL characters and lone Unicode surrogates are invalid input; correct the named field instead of retrying unchanged.
Next: if status is "dispatched", call await_answer with the returned task_id. For "confirmation_required", wait for the card confirmation. For "not_sent", show the explanation. A retry returns the stored task status and money held; follow next_step without creating another paid task.`,
      inputSchema: TOOLS.ask_eyes.input,
      outputSchema: AskEyesToolOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: widgetToolMeta("Texting nearby workers", "Task posted"),
    },
    (input, ctx) => {
      if (!interactive(ctx)) return dispatch(ctx.get("agent"), input);
      return run(
        async (): Promise<z.output<typeof AskEyesDraftOutput>> => ({
          ...input,
          ...(await service.quoteTask(ctx.get("agent"), {
            location: input.location,
            task_type: input.task_type,
          })),
          status: "confirmation_required",
          next_step: "Review the card and press Ask to confirm and pay. Nothing has been created or charged.",
        }),
      );
    },
  );

  server.tool(
    {
      name: "confirm_ask",
      title: "Confirm and send this task",
      description:
        "App-only: dispatch the request explicitly confirmed in the Eyes card. Reuse its idempotency_key and exact parameters for retries; a new explicit Ask Again uses a new key. Next: follow next_step for the returned task_id and status; never create another paid request for this intent.",
      visibility: "app",
      inputSchema: TOOLS.ask_eyes.input,
      outputSchema: AskEyesToolOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Texting nearby workers",
        "openai/toolInvocation/invoked": "Task posted",
        "openai/visibility": "private",
      },
    },
    (input, ctx) => dispatch(ctx.get("agent"), input),
  );

  server.tool(
    {
      name: "report_classifier",
      title: "Report an incorrect classifier block",
      description:
        "Open an internal Support review for an incorrect unsafe_task refusal. Supply the original Ask arguments, ask_idempotency_key from that Ask, a separate per-card idempotency_key, and the complete reported error. Context is untrusted feedback, not an authoritative classification. This never posts a task, sends messages or charges money. A human can approve only this exact request for this same agent for 24 hours. Next: call get_classifier_report with the returned ticket_id to check for a decision.",
      inputSchema: TOOLS.report_classifier.input,
      outputSchema: TOOLS.report_classifier.output,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { "openai/widgetAccessible": true },
    },
    (input, ctx) =>
      run(async () => {
        if (!ctx.req?.header("authorization")) throw new EyesError("unauthorized");
        throttle({ req: ctx.req }, "/v1/classifier-reports", ctx.get("agent").id);
        return service.reportClassifier(ctx.get("agent"), input);
      }),
  );
  server.tool(
    {
      name: "get_classifier_report",
      title: "Check classifier review",
      description:
        "Read your internal classifier review status. Only after approved, explicitly retry the original unchanged Ask with its original idempotency_key and classifier_report_id set to ticket_id. Rejected or expired reviews do not permit retry. Consumed means a task already exists: read task_id with get_task. Checking never posts or charges. Next: on approved, offer an explicit retry of the unchanged original Ask; otherwise show the status.",
      inputSchema: TOOLS.get_classifier_report.input,
      outputSchema: TOOLS.get_classifier_report.output,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { "openai/widgetAccessible": true },
    },
    (input, ctx) => run(() => service.getClassifierReport(ctx.get("agent"), input)),
  );

  server.tool(
    {
      name: "await_answer",
      title: "Wait for the answer",
      description: `Read-only bounded wait for the recorded state of an existing task. Use a task_id from confirmed dispatch (the card's confirm_ask or non-UI ask_eyes) or a task lookup, not a draft idempotency_key. This call does not create a task, send worker messages, pay or refund.
It checks stored state about once a second for up to timeout_seconds (default 50, max 55), returning when an answer or terminal state is recorded, the wait window ends, or the call is cancelled. No background watch continues after the response. get_task and show_task can also retrieve the current answer without waiting.
How to read the result:
- answered true means status is verified, paid or needs_review. answer may be null; otherwise use its available text, boolean, photo_url, timestamps and verification fields. photo_url can be null or withheld. The JSON includes a URL, not image pixels: display the available answer and photo link or card for user review, without claiming to have inspected an image from the URL alone.
- Use status for settlement, not the verification flags: verified does not prove payout, paid means payout was recorded, and needs_review holds escrow for human review. Human review can pay or refund without changing the original flags. Eyes checks location, freshness and photo safety, not whether the answer is correct; use dispute_answer for a wrong answer.
- answered false with status dispatched, claimed or submitted: call again with the same task_id if another bounded wait is wanted, or read get_task later.
- status expired, refunded or disputed: stop waiting. Refunds can follow cancellation or human review; await_answer itself does not settle funds. Use get_task later for a review outcome.
Example: await_answer({ "task_id": "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b" })
Next: follow next_step in the response.`,
      inputSchema: TOOLS.await_answer.input,
      outputSchema: TOOLS.await_answer.output,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: widgetToolMeta("Looking up the task", "Task loaded"),
    },
    (input, ctx) => run(() => service.getTask(ctx.get("agent"), input)),
  );

  server.tool(
    {
      name: "show_task",
      title: "Show a task card",
      description: `Show your user a task as a card: status, place, question, the answer with its photo, the verification checks and what it cost. Read-only and instant; the JSON result is the same as get_task's. Chat apps that render MCP Apps, such as ChatGPT and Claude, draw the card; other clients get only the JSON.
Example: show_task({ "task_id": "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b" })
Next: call it once await_answer returns answered true, so your user sees the answer and the photo. To wait for an answer call await_answer instead.`,
      inputSchema: TOOLS.get_task.input,
      outputSchema: TOOLS.get_task.output,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: widgetToolMeta("Loading the Eyes task card", "Eyes task card ready"),
    },
    (input, ctx) => run(() => service.getTask(ctx.get("agent"), input)),
  );

  server.tool(
    {
      name: "list_tasks",
      title: "List your tasks",
      description: `List the tasks this API key created, newest first, with task_id, status, question, place_label, bounty_usd, created_at, deadline_at and answered. Read-only and instant. You only ever see your own tasks.
Call it when you lost a task_id (context reset, crash, restart) and before you ask a question again, so you resume an open task instead of paying twice. Find yours by question and place_label.
status keeps only tasks in that status, for example "dispatched" for tasks no worker has claimed yet. limit is 1 to 50 (default 20). Pass next_cursor as before to read older tasks with the same status filter; null means no more tasks.
Example: list_tasks({ "status": "dispatched", "limit": 5 })
Next: for a task with status dispatched, claimed or submitted, call await_answer with its task_id. For a task where answered is true, call get_task to read the answer. Call ask_eyes only if no listed task covers your question.`,
      inputSchema: TOOLS.list_tasks.input,
      outputSchema: TOOLS.list_tasks.output,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (input, ctx) => run(() => service.listTasks(ctx.get("agent"), input)),
  );

  server.tool(
    {
      name: "cancel_task",
      title: "Cancel a task",
      description: `Cancel a task that no worker has claimed yet; the full escrow (bounty plus fee) goes back to your balance. Only works while status is dispatched; once a worker has claimed it you get task_not_cancellable.
Example: cancel_task({ "task_id": "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b" })
Next: call get_balance to see the refund. If cancellation fails, call get_task; call await_answer only for claimed or submitted tasks.`,
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
      name: "accept_answer",
      title: "Accept an answer",
      description: `Record your user's positive feedback on a delivered answer belonging to this API key. Only answered tasks with status verified or paid qualify. This is not photo verification, does not charge or pay anyone, and is never required for payment. Repeated calls preserve the first acceptance. The right to dispute is unchanged.
Example: accept_answer({ "task_id": "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b" })
Next: get_task shows accepted_at on reload. Accept only after your user says the answer looks good.`,
      inputSchema: TOOLS.accept_answer.input,
      outputSchema: TOOLS.accept_answer.output,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { "openai/widgetAccessible": true },
    },
    (input, ctx) => run(() => service.acceptAnswer(ctx.get("agent"), input)),
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
        destructiveHint: true,
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (_input, ctx) => run(() => service.getSpendPolicy(ctx.get("agent"))),
  );

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
      const _meta = widgetResourceMeta(mcpBase(ctx), claude);
      return { contents: [{ uri: WIDGET_URI, mimeType: WIDGET_MIME, text: WIDGET_HTML, _meta }] };
    },
  );
  server.use("mcp:resources/list", async (ctx, next) =>
    (await next()).map((resource) =>
      resource.uri === WIDGET_URI
        ? { ...resource, _meta: widgetResourceMeta(mcpBase(ctx), false) }
        : resource,
    ),
  );
  // mcp-use strips `_meta.ui` from tools that have no mcp-use `view` (a React build), so put the
  // MCP Apps link back on the tools that carry the ChatGPT template, and let the card's buttons call
  // WIDGET_CALLABLE (ChatGPT: openai/widgetAccessible; MCP Apps: ui.visibility includes "app").
  server.use("mcp:tools/list", async (ctx, next) =>
    (await next()).map((listed) => {
      const tool: ListedTool =
        listed.name === "ask_eyes" && interactive(ctx)
          ? {
              ...listed,
              title: "Prepare a task for confirmation",
              description:
                "Prepare a read-only Eyes card with the question, place, price and intent key. No task, payment or worker notification occurs. The user must press Ask in the card to confirm; never dispatch a second task after that confirmation. Errors include error, message and fix, or an Input validation error naming invalid fields. Use them to repair the original authorized request, not to change its goal, raise spending or bypass confirmation. After an unknown dispatch outcome, retry only the same parameters and idempotency_key.",
              inputSchema: draftInputSchema,
              outputSchema: draftOutputSchema,
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
              },
              _meta: {
                ...listed._meta,
                "openai/toolInvocation/invoking": "Preparing draft",
                "openai/toolInvocation/invoked": "Review confirmation",
              },
            }
          : listed;
      const card = tool._meta?.["openai/outputTemplate"] === WIDGET_URI;
      const callable =
        WIDGET_CALLABLE.includes(tool.name) ||
        ["confirm_ask", "report_classifier", "get_classifier_report"].includes(tool.name);
      if (!card && !callable) return tool;
      const ui = {
        ...(card && { resourceUri: WIDGET_URI }),
        ...(callable && { visibility: tool.name === "confirm_ask" ? ["app"] : ["model", "app"] }),
      };
      return {
        ...tool,
        _meta: {
          ...tool._meta,
          ui,
          ...(card && { "ui/resourceUri": WIDGET_URI }),
          ...(callable && { "openai/widgetAccessible": true }),
        },
      };
    }),
  );

  const hits = new Map<string, number[]>();
  // `who` defaults to the caller's address; the worker email routes also key by code or address.
  const throttle = (
    c: Pick<Context, "req">,
    path = c.req.path,
    who = clientKey(c.req.header("x-forwarded-for")),
    max = PUBLIC_CALLS_PER_HOUR,
  ) => {
    const now = deps.providers.clock.now().getTime();
    for (const [key, times] of hits) {
      if ((times.at(-1) ?? 0) > now - HOUR_MS && hits.size < THROTTLE_MAX_KEYS) break;
      hits.delete(key);
    }
    const key = `${path} ${who}`;
    const recent = (hits.get(key) ?? []).filter((at) => at > now - HOUR_MS);
    if (recent.length >= max) {
      const until = (recent[0] ?? now) + HOUR_MS;
      const retry_after_s = Math.ceil((until - now) / 1000);
      throw new EyesError(
        "rate_limited",
        { retry_after_s },
        {
          fix: `${c.req.path} allows ${max} calls per hour from one address or for one account. Wait ${retry_after_s} seconds (until ${new Date(until).toISOString()}) and try again.`,
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
    if (!deps.rpc) throw new Error("OAuth requires a database RPC connection.");
    oauthRoutes(server.app, {
      base: mcpBase,
      secret: env.EYES_OAUTH_SECRET,
      rpc: deps.rpc,
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
  server.post("/v1/classifier-reports", async (c) => {
    const input = parse(TOOLS.report_classifier.input, await readJson(c));
    throttle(c, "/v1/classifier-reports", c.get("agent").id);
    return c.json(await service.reportClassifier(c.get("agent"), input));
  });
  server.get("/v1/classifier-reports/:ticket_id", async (c) => {
    return c.json(
      await service.getClassifierReport(
        c.get("agent"),
        parse(TOOLS.get_classifier_report.input, c.req.param()),
      ),
    );
  });
  server.get("/v1/tasks", async (c) => {
    const { status, limit, before } = c.req.query();
    const input = parse(ListTasksInput, {
      status: status || undefined,
      limit: limit ? Number(limit) : undefined,
      before,
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
  server.post("/v1/tasks/:task_id/accept", async (c) => {
    return c.json(
      await service.acceptAnswer(c.get("agent"), parse(TOOLS.accept_answer.input, c.req.param())),
    );
  });
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
    // The web page proves a human with Turnstile; the app has no widget, so it relies on the limits.
    if (c.req.header("origin") === new URL(config.worker_web_url).origin) {
      const token = c.req.header("x-turnstile-token");
      const secret = env.TURNSTILE_SECRET_KEY;
      const verdict =
        token && secret
          ? ((await (
              await fetch(TURNSTILE_VERIFY_URL, {
                method: "POST",
                body: new URLSearchParams({
                  secret,
                  response: token,
                  remoteip: clientKey(c.req.header("x-forwarded-for")),
                }),
              })
            )
              .json()
              .catch(() => null)) as { success?: boolean } | null)
          : null;
      if (!verdict?.success) {
        throw new EyesError(
          "invalid_input",
          {},
          {
            message: "We could not confirm you are a person.",
            fix: "Reload the page, finish the check, and tap Join again.",
          },
        );
      }
    }
    throttle(c, c.req.path, `phone ${input.phone}`, JOINS_PER_PHONE_PER_HOUR);
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
  // Ad hoc install (T6.31): the page trades the worker's code (header, never a URL) for a 1-hour
  // profile link; the iPhone posts its device ID back to the same ticket URL.
  server.post("/w/device", async (c) => {
    const code = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (!code) throw new EyesError("unauthorized");
    return c.json(await service.workerDevice(code));
  });
  // The setup page (ADR-028): its code is the worker's "e:" token, read only from the header. A missing
  // header reaches the engine as "", which refuses it like a bad code. Only POST mints a location code.
  server.get("/w/me", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(
      await service.workerSetup(/^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? ""),
    );
  });
  // The /me task list (T6.42, ADR-029): one page per call, same bearer code as /w/me; tz is the browser's zone.
  server.get("/w/me/tasks", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(
      await service.workerTasks(
        /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "",
        WorkerTasksQuery.parse(c.req.query()),
      ),
    );
  });
  // The worker contests an owner's dispute (ADR-050). 10 an hour per code, shared with the owner route's rule.
  server.post("/w/me/tasks/:task_id/dispute", async (c) => {
    c.header("Cache-Control", "no-store");
    const token = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const input = parse(DisputeAnswerInput, { ...(await readJson(c)), ...c.req.param() });
    throttle(c, "/w/me/dispute", `code ${createHash("sha256").update(token).digest("hex")}`, 10);
    return c.json(await service.workerDispute(token, input));
  });
  // The owner disputes an answer with the owner console token (ADR-050).
  server.post("/owner/:token/tasks/:task_id/dispute", async (c) => {
    c.header("Cache-Control", "no-store");
    const { token, task_id } = c.req.param();
    const input = parse(DisputeAnswerInput, { ...(await readJson(c)), task_id });
    throttle(c, "/owner/dispute", `code ${createHash("sha256").update(token).digest("hex")}`, 10);
    // Same 401 for a bad link as the owner JSON routes (ADR-044).
    return c.json(
      await service.ownerDispute(token, input).catch((err: unknown) => {
        if (err instanceof EyesError && err.code === "owner_link_invalid")
          throw new EyesError("unauthorized");
        throw err;
      }),
    );
  });
  server.post("/w/me/install", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(
      await service.workerInstallLink(
        /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "",
      ),
    );
  });
  // Account deletion (ADR-045): same bearer code as /w/me.
  server.delete("/w/me", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(
      await service.workerDelete(/^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? ""),
    );
  });
  // Worker email (T6.48): the /me code adds, changes or (null) removes the address, and a repeat POST
  // re-sends the confirmation; the engine mails the link. 5 changes an hour per code.
  server.post("/w/me/email", async (c) => {
    c.header("Cache-Control", "no-store");
    const token = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const { email } = parse(z.object({ email: z.string().trim().max(254).nullable() }), await readJson(c));
    throttle(c, c.req.path, `code ${createHash("sha256").update(token).digest("hex")}`);
    return c.json(await service.workerSetEmail(token, email));
  });
  // Texts on or off (STOP / START) for the "e:" code. Same 5 an hour per code as email.
  server.post("/w/me/texts", async (c) => {
    c.header("Cache-Control", "no-store");
    const token = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const { on } = parse(z.object({ on: z.boolean() }).strict(), await readJson(c));
    throttle(c, "/w/me/email", `code ${createHash("sha256").update(token).digest("hex")}`);
    return c.json(await service.workerSetTexts(token, on));
  });
  // Optional email acknowledgement; no address, verification or delivery side effects.
  server.post("/w/me/email/skip", async (c) => {
    c.header("Cache-Control", "no-store");
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(config.worker_web_url).origin) throw new EyesError("unauthorized");
    const token = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    parse(z.object({}).strict(), await readJson(c));
    return c.json(await service.workerSkipEmail(token));
  });
  // The worker emails first (T6.51): a one-time mailto to work@ whose email connects the sender,
  // verified. 5 an hour per code, shared with /w/me/email.
  server.post("/w/me/email/start", async (c) => {
    c.header("Cache-Control", "no-store");
    const token = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    throttle(c, "/w/me/email", `code ${createHash("sha256").update(token).digest("hex")}`);
    return c.json(await service.workerEmailStart(token));
  });
  // Always 200, and the send is not awaited, so neither the answer nor its timing tells whether the
  // address is on an account. 5 an hour per address and per caller.
  server.post("/w/login/email", async (c) => {
    c.header("Cache-Control", "no-store");
    const { email } = parse(
      z.object({ email: z.string().trim().toLowerCase().min(3).max(254) }),
      await readJson(c),
    );
    throttle(c);
    throttle(c, c.req.path, `email ${email}`);
    void service
      .workerEmailLogin(email)
      .catch((err: unknown) =>
        console.error(`worker email login failed: ${err instanceof Error ? err.name : typeof err}`),
      );
    return c.json({ ok: true });
  });
  // The one-time code from the emailed link becomes the /me "e:" token. 10 tries an hour per caller.
  server.post("/w/login/code", async (c) => {
    c.header("Cache-Control", "no-store");
    const { code } = parse(z.object({ code: z.string().min(1).max(512) }), await readJson(c));
    throttle(c, c.req.path, undefined, LOGIN_CODES_PER_HOUR);
    return c.json(await service.workerLoginCode(code));
  });
  server.get("/w/device/profile/:ticket", (c) => {
    const ticket = c.req.param("ticket");
    if (!verifyToken(config.link_secret, ticket, deps.providers.clock.now())?.startsWith("d:"))
      throw new EyesError("unauthorized");
    return c.body(deviceProfile(`${config.public_api_url}/w/device/${ticket}`), 200, {
      "content-type": "application/x-apple-aspen-config",
      "content-disposition": 'attachment; filename="Eyes.mobileconfig"',
    });
  });
  server.post("/w/device/:ticket", async (c) => {
    const device = parseDeviceAttributes(new Uint8Array(await c.req.arrayBuffer()));
    if (!device) throw new EyesError("invalid_input", { field: "udid" });
    await service.addWorkerDevice(c.req.param("ticket"), device);
    // Start an ad hoc release on the build runner (i098/eyes-ios-release); its hourly run is the backstop,
    // so a failed dispatch only logs.
    if (env.EYES_RELEASE_DISPATCH_TOKEN) {
      fetch("https://api.github.com/repos/i098/eyes-ios-release/dispatches", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.EYES_RELEASE_DISPATCH_TOKEN}`,
          accept: "application/vnd.github+json",
          "user-agent": "eyes-api",
        },
        body: JSON.stringify({ event_type: "device-registered", client_payload: { ref: env.EYES_COMMIT } }),
      })
        .then((res) => res.ok || Promise.reject(new Error(`HTTP ${res.status}`)))
        .catch((err: unknown) => console.error("release dispatch failed:", String(err)));
    }
    return c.redirect(`${config.worker_web_url}/install?registered=1`, 301);
  });
  // The ad hoc build, served from our own HTTPS origin: iOS's itms-services install should not depend
  // on following storage's redirect to its CDN. The bucket object is replaced on every release.
  for (const [file, type, cache] of [
    ["manifest.plist", "application/xml", "no-cache"],
    ["Eyes.ipa", "application/octet-stream", "public, max-age=300"],
  ] as const) {
    server.get(`/w/app/${file}`, async () => {
      const base = env.INSFORGE_BASE_URL?.replace(/\/+$/, "");
      const res = base ? await fetch(`${base}/api/storage/buckets/apps/objects/eyes-worker/${file}`) : null;
      if (!res?.ok || !res.body) return new Response("No ad hoc build uploaded yet.", { status: 404 });
      const length = res.headers.get("content-length");
      return new Response(res.body, {
        headers: {
          "content-type": type,
          "cache-control": cache,
          ...(length && { "content-length": length }),
        },
      });
    });
  }
  // Private photo bucket: a link signed by storage.signPhoto, valid until its exp (ADR-048).
  server.get("/photos", async (c) => {
    const { k, exp, sig } = c.req.query();
    const res = k && exp && sig ? await deps.providers.storage.readPhoto({ key: k, exp, sig }) : null;
    if (!res) return c.text("This photo link is invalid or has expired.", 403);
    return new Response(res.body, {
      headers: {
        "content-type": res.headers.get("content-type") ?? "image/jpeg",
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      },
    });
  });
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
  let healthRead: Promise<Agent | null> | undefined;
  server.get("/healthz", async (c) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      // Share an unfinished read so repeated probes cannot fill the database connection pool.
      healthRead ??= service.authenticate("eyes-health-check").finally(() => {
        healthRead = undefined;
      });
      await Promise.race([
        healthRead,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Health check timed out")), 2000);
        }),
      ]);
      return c.json({ ok: true, providers, db });
    } catch {
      return c.json({ ok: false }, 503);
    } finally {
      clearTimeout(timer);
    }
  });
  // Primitive gates outbound mail per org: until it grants send_to_any_domain, first contact (owner links,
  // sign-in codes, worker email) goes out through Inkbox when it is configured, or not at all.
  const emailNote =
    env.PRIMITIVE_SEND_ANY_DOMAIN === "1"
      ? null
      : `${live.messaging ? "first contact via Inkbox" : "replies only"} until Primitive enables any-domain sending`;
  const status = statusPage(live, classifier, db, env.EYES_COMMIT, emailNote);
  server.get("/status", (c) => c.html(status, 200, PAGE_HEADERS));
  // The Eyes viewfinder (apps/web/worker/public/favicon.svg); browsers asking for .ico get the SVG.
  server.get("/favicon.svg", (c) =>
    c.body(FAVICON, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }),
  );
  server.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 302));
  server.get("/fonts/instrument-sans.woff2", (c) =>
    c.body(DISPLAY_FONT, 200, {
      "content-type": "font/woff2",
      "cache-control": "public, max-age=31536000, immutable",
    }),
  );

  const { rpc } = deps;
  if (rpc) {
    // Short links in texts: /s/<id> redirects to the full link. Unknown, expired or malformed ids get a
    // page that says how to get fresh links.
    server.app.get("/s/:id", async (c) => {
      for (const [name, value] of Object.entries(PAGE_HEADERS)) c.header(name, value);
      const id = c.req.param("id");
      const [row] = /^[0-9A-Za-z]{8}$/.test(id)
        ? await rpc<{ target: string }>("eyes_short_link", {
            p_id: id,
            p_now: deps.providers.clock.now().toISOString(),
          })
        : [];
      if (row) return c.redirect(row.target, 302);
      return c.html(
        layout(
          "This link has expired",
          html`<section class="notice-page"><h1>This link has expired</h1><p>Text HELP to the Eyes number for fresh links.</p><a class="button" href="https://eyes.pictures">Go to eyes.pictures</a></section>`,
        ),
        404,
      );
    });
    const ops = opsAuth({ rpc, providers: deps.providers, config, env, log, site: opsSite.site });
    server.app.route(
      "/",
      opsSettingsRoutes(deps.settings ?? createOpsSettings(rpc), ops.operator, ops.sameOrigin),
    );
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
    const opsPageHeaders = opsHeaders(OPS_PAGE);
    server.app.get("/ops", ops.operator, (c) => c.html(OPS_PAGE, 200, opsPageHeaders));
    // The old live map is the Workers tab now.
    server.app.get("/ops/live", ops.operator, (c) =>
      c.redirect(`${opsSite.site(c).base || "/"}#workers`, 301),
    );
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
      // No location (null) or a 0,0 placeholder stays off the map: coarse(null) would read as 0.
      const workers = feed.workers.map((w) =>
        w.lat == null || w.lng == null || (w.lat === 0 && w.lng === 0)
          ? { ...w, lat: null, lng: null }
          : { ...w, lat: coarse(w.lat), lng: coarse(w.lng) },
      );
      return c.json(
        {
          ...feed,
          tasks: feed.tasks
            .slice(0, OPS_RECENT)
            .map((t) =>
              "photo_url" in t && typeof t.photo_url === "string"
                ? { ...t, photo_url: deps.providers.storage.signPhoto(t.photo_url) }
                : t,
            ),
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
    // Paged lists: /ops/events, /ops/tickets, /ops/tasks, /ops/ledger (keyset cursor, server-side filters).
    server.app.route(
      "/",
      opsLists({ rpc, events: deps.events, operator: ops.operator, sign: deps.providers.storage.signPhoto }),
    );
    server.app.get("/ops/tasks/:id", ops.operator, async (c) => {
      const id = c.req.param("id");
      const [row] = UUID.test(id)
        ? await rpc<{ task: Task; submission: Submission | null }>("eyes_task_detail", { p_task_id: id })
        : [];
      if (!row) throw new EyesError("task_not_found", { task_id: id }, { message: "No task with this id." });
      const { task: t, submission: s } = row;
      return c.json(
        {
          id: t.id,
          question: t.question,
          place_label: t.place_label,
          radius_m: t.radius_m,
          status: t.status,
          bounty_cents: t.bounty_cents,
          fee_cents: t.fee_cents,
          dispute_reason: t.dispute_reason,
          created_at: t.created_at,
          photo_url: s?.photo_url ? deps.providers.storage.signPhoto(s.photo_url) : null,
          answer_text: s?.answer_text ?? null,
          answer_bool: s?.answer_bool ?? null,
          gps_ok: s?.gps_ok ?? null,
          fresh_ok: s?.fresh_ok ?? null,
          vision_ok: s?.vision_ok ?? null,
          vision_reason: s?.vision_reason ?? null,
          confidence: s?.confidence ?? null,
          submitted_at: s?.created_at ?? null,
          distance_m: s ? Math.round(distanceMeters(t, s)) : null,
        },
        200,
        FEED_HEADERS,
      );
    });
    // The Workers map's tasks: the Tasks tab's status and date window, plus every open or attention task.
    server.app.get("/ops/map/tasks", ops.operator, async (c) => {
      const q = c.req.query();
      const instant = (text: string | undefined) =>
        text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : null;
      const tasks = await rpc<Record<string, unknown>>("eyes_map_tasks", {
        p_status: TASK_STATUSES.includes(q.status ?? "") ? q.status : null,
        p_from: instant(q.from),
        p_to: instant(q.to),
        p_now: deps.providers.clock.now().toISOString(),
      });
      return c.json({ tasks }, 200, FEED_HEADERS);
    });
    // One worker for the Workers panel: state, rounded last fix, their tasks, what they earned.
    server.app.get("/ops/workers/:id", ops.operator, async (c) => {
      const id = c.req.param("id");
      const [row] = UUID.test(id)
        ? await rpc<{ worker: OpsWorker | null; tasks: unknown[]; earnings: Record<string, unknown> }>(
            "eyes_ops_worker",
            { p_id: id, p_limit: 10 },
          )
        : [];
      if (!row?.worker)
        return c.json({ error: "worker_not_found", message: "No worker with this id." }, 404, FEED_HEADERS);
      const w = row.worker;
      return c.json(
        {
          worker: {
            ...w,
            lat: w.lat == null ? null : coarse(w.lat),
            lng: w.lng == null ? null : coarse(w.lng),
          },
          tasks: row.tasks,
          earnings: row.earnings,
        },
        200,
        FEED_HEADERS,
      );
    });
    server.app.get("/ops/workers/:id/dispute-review", ops.operator, async (c) => {
      const id = c.req.param("id");
      const [review] = UUID.test(id)
        ? await rpc<Record<string, unknown>>("eyes_worker_dispute_review", { p_worker_id: id })
        : [];
      return review
        ? c.json(review, 200, FEED_HEADERS)
        : c.json({ error: "worker_not_found" }, 404, FEED_HEADERS);
    });
    server.app.post("/ops/workers/:id/dispute-review", ops.sameOrigin, ops.operator, async (c) => {
      const id = c.req.param("id");
      if (!UUID.test(id)) return c.json({ error: "worker_not_found" }, 404, FEED_HEADERS);
      const { note } = parse(z.object({ note: z.string().trim().min(5).max(1000) }), await readJson(c));
      const operator = c.get("operator");
      const [review] = await rpc<Record<string, unknown>>("eyes_review_worker_disputes", {
        p_worker_id: id,
        p_actor: `${operator.id} (${operator.label})`,
        p_note: note,
        p_now: deps.providers.clock.now().toISOString(),
      });
      if (!review) return c.json({ error: "worker_not_found" }, 404, FEED_HEADERS);
      return c.json(review, review.error === "worker_not_held" ? 409 : 200, FEED_HEADERS);
    });
    server.app.post("/ops/tasks/:id/resolve", ops.sameOrigin, ops.operator, async (c) => {
      const body = parse(TaskResolve, { ...(await readJson(c)), task_id: c.req.param("id") });
      const operator = c.get("operator").label;
      let result: { task_id: string; status: string; already_resolved: boolean };
      try {
        const note = body.note || `${body.outcome} from the ops review panel by ${operator}`;
        result = {
          ...(await service.resolveTask(body.task_id, body.outcome, note)),
          already_resolved: false,
        };
      } catch (err) {
        const status = err instanceof EyesError && err.code === "invalid_input" ? err.context.status : null;
        if (typeof status !== "string" || !RESOLVED.includes(status)) throw err;
        result = { task_id: body.task_id, status, already_resolved: true };
      }
      log({
        kind: "ops",
        task_id: body.task_id,
        summary: `task ${body.outcome} by ${operator}${result.already_resolved ? " (already resolved)" : ""}`,
        data: { action: body.outcome, operator, ...result },
      });
      return c.json(result, 200, FEED_HEADERS);
    });
    // Errors tab: issues grouped from console errors (migration 028), one issue's occurrences, and its status.
    server.app.get("/ops/issues", ops.operator, async (c) => {
      const issues = await rpc<Record<string, unknown>>("eyes_issues", {
        p_now: deps.providers.clock.now().toISOString(),
      });
      return c.json({ issues }, 200, FEED_HEADERS);
    });
    server.app.get("/ops/issues/:fp", ops.operator, async (c) => {
      const fp = c.req.param("fp");
      const events = /^[0-9a-f]{16}$/.test(fp)
        ? await rpc<Record<string, unknown>>("eyes_issue_events", { p_fingerprint: fp, p_limit: 20 })
        : [];
      return c.json({ events }, 200, FEED_HEADERS);
    });
    server.app.post("/ops/issues/:fp/status", ops.sameOrigin, ops.operator, async (c) => {
      const body = parse(IssueStatus, await readJson(c));
      const operator = c.get("operator").label;
      const [issue] = await rpc<{ fingerprint: string; title: string }>("eyes_issue_status", {
        p_fingerprint: c.req.param("fp"),
        p_status: body.status,
        p_more: body.more ?? null,
        p_by: operator,
        p_now: deps.providers.clock.now().toISOString(),
      });
      if (!issue)
        return c.json({ error: "issue_not_found", message: "No issue with this id." }, 404, FEED_HEADERS);
      log({
        kind: "ops",
        summary: `issue ${issue.fingerprint} ${body.status}${body.more ? ` until ${body.more} more` : ""} by ${operator}`,
        data: { action: body.status, fingerprint: issue.fingerprint, operator },
      });
      return c.json({ issue }, 200, FEED_HEADERS);
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
    for (const [action, decision] of [
      ["approve_classifier", "approved"],
      ["reject_classifier", "rejected"],
    ] as const) {
      server.app.post(`/ops/tickets/:id/${action}`, ops.sameOrigin, ops.operator, async (c) => {
        const body = parse(
          z.object({
            ticket_id: TOOLS.get_classifier_report.input.shape.ticket_id,
            note: z.string().trim().max(500).default(""),
          }),
          { ...(await readJson(c)), ticket_id: c.req.param("id") },
        );
        const operator = c.get("operator").label;
        const result = await service.decideClassifierReport({ ...body, decision, operator });
        log({
          kind: "ops",
          summary: `classifier ticket #${body.ticket_id} ${decision} by ${operator}${result.already_resolved ? " (already resolved)" : ""}`,
          data: { action, operator, ...result },
        });
        return c.json(result, 200, FEED_HEADERS);
      });
    }
    server.app.post("/ops/tickets/:id/:action", ops.sameOrigin, ops.operator, async (c) => {
      const { id, action } = c.req.param();
      const body = parse(TicketAction, { ...(await readJson(c)), ticket_id: id, outcome: action });
      if (!(await rpc("eyes_manual_ticket", { p_ticket_id: body.ticket_id, p_task_id: body.task_id })).length)
        throw new EyesError("invalid_input", {
          issues: [{ path: "ticket_id", message: "Not a manual review ticket for this task." }],
        });
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
