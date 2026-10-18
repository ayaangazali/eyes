import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
} from "@eyes/core";
import type { Rpc } from "@eyes/db";
import { PAGE_HEADERS, stripeRoutes } from "@eyes/payments";
import { PAGE as DASHBOARD, readFeed } from "@eyes/web-dashboard";
import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { MCPServer, registerViews, type ViewsManifest } from "mcp-use";
import type { z } from "zod";

type Env = Record<string, string | undefined>;
type AppEnv = { Variables: { agent: Agent } };

const PROGRESS_INTERVAL_MS = 5000;
const HOUR_MS = 60 * 60 * 1000;
const PUBLIC_CALLS_PER_HOUR = 5;
const THROTTLE_MAX_KEYS = 10_000;
const DOCS_DIR = fileURLToPath(new URL("../../../docs/public/", import.meta.url));
const VIEWS_MANIFEST = fileURLToPath(new URL("../.mcp-use/build/manifest.json", import.meta.url));
const TASK_CARD = "task-card";

function taskCard(file: string) {
  if (!existsSync(file)) return undefined;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { views?: ViewsManifest }).views?.[TASK_CARD];
  } catch (err) {
    console.error(
      `views manifest ${file} is unreadable, so show_task has no card: ${err instanceof Error ? err.name : typeof err}`,
    );
    return undefined;
  }
}
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
const STYLE = `*{box-sizing:border-box}
body{margin:0;font:17px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#121820;background:#fafafa}
header{background:#121820;padding:.75rem max(1rem,calc(50% - 17rem))}
header a{display:inline-flex;align-items:center;gap:.6rem;color:#eef3f8;font-size:1.25rem;font-weight:750;letter-spacing:-.02em;text-decoration:none}
.mark{width:1.6rem;height:1rem;border-radius:50%;background:radial-gradient(circle,#121820 0 28%,#ffc24b 30%);box-shadow:0 0 .8rem rgba(255,194,75,.45)}
main{max-width:36rem;margin:0 auto;padding:1.25rem 1rem 3rem}
h1{font-size:1.75rem;line-height:1.2;letter-spacing:-.01em;margin:.5rem 0 .75rem}
h2{font-size:1.1rem;margin:2rem 0 .5rem}
a{color:inherit;text-decoration-color:#e0a020;text-decoration-thickness:2px;text-underline-offset:.15em}
.button{display:block;padding:.9rem 1rem;border-radius:.6rem;background:#ffc24b;color:#121820;font-weight:700;text-align:center;text-decoration:none}
.box{margin-top:1.5rem;padding:.25rem 1rem;border:1px solid #e3e6ea;border-radius:.6rem;background:#fff}
.box h2{margin-top:.75rem}
.muted{color:#5b6672}
code{font:.9em ui-monospace,SFMono-Regular,Menlo,monospace;background:#eef0f3;padding:.1em .3em;border-radius:.25em}
.links a{margin-right:1rem;line-height:2.5}
.rows{list-style:none;padding:0}.rows li{padding:.75rem 0;border-bottom:1px solid #e3e6ea}
.state::before{content:"";display:inline-block;width:.6rem;height:.6rem;margin-right:.5rem;border-radius:50%;background:#7d8a9b}
.state.live::before{background:#1f9d63}
.box+.button{margin-top:1.5rem}`;
const sha256 = (text: string) => createHash("sha256").update(text);
const coarse = (degrees: number) => Math.round(degrees * 1000) / 1000;
const DASHBOARD_SCRIPT = sha256(/<script>([\s\S]*?)<\/script>/.exec(DASHBOARD)?.[1] ?? "").digest("base64");
const OPS_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy": `default-src 'none'; script-src https://unpkg.com 'sha256-${DASHBOARD_SCRIPT}'; style-src https://unpkg.com 'unsafe-inline'; img-src https: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
};
const PROVIDER_LINES = {
  messaging: ["Texting", "Task texts to workers' phones and their YES replies (Inkbox)."],
  email: ["Agent email", "Questions agents email in and the threaded answers (Primitive)."],
  payments: ["Payments", "Agent top-ups and payouts to workers (Stripe)."],
  storage: ["Photo storage", "Where answer photos are kept (InsForge)."],
  vision: ["Photo checks", "The AI check that a photo answers the question (Claude)."],
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
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${raw(STYLE)}</style></head>
<body><header><a href="/"><span class="mark"></span>Eyes</a></header>
<main>${body}</main>
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
    "Eyes",
    html`<h1>AI agents pay people nearby about $3 to check public places.</h1>
<p>Is the cafe open? How long is the line? An AI agent asks, Eyes texts people close by, and the first to reply YES walks over, takes a photo and gets paid.</p>
${simulatedNotice(live)}
<a class="button" href="${joinUrl}">Join to get paid tasks</a>
<section class="box">
<h2>Got a text from Eyes?</h2>
<p>Reply <b>YES</b> to claim the task, or ignore it. Reply <b>STOP</b> to stop all texts from Eyes, and START to get them again.</p>
</section>
<p class="muted">Only public places: stores, cafes, parks, transit stops. Never people, homes or cars. ${classifier ? "Every task passes the safety rules and an AI safety classifier before any money moves." : "Safety review is rules only here: the AI safety classifier is off, so only the safety rules check each task."}</p>
<h2>For AI agents</h2>
<p>Connect over MCP: <code>POST /mcp</code> with <code>Authorization: Bearer &lt;api_key&gt;</code>. No key yet? <code>POST /v1/signup</code>.</p>
<p class="links"><a href="/llms.txt">llms.txt</a> <a href="/openapi.json">openapi.json</a> <a href="${AGENT_CARD}">agent-card.json</a> <a href="/agents.md">agents.md</a></p>
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
<li><b class="state${classifier ? " live" : ""}">Safety review: ${classifier ? "rules and AI classifier" : "rules only"}</b><br><span class="muted">Checks every task before any money moves: the safety rules, then the AI classifier (Claude) when it is on.</span></li>
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

export function createServer(deps: RouteDeps & { env: Env; rpc?: Rpc }) {
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
Returns workers_nearby, est_minutes_to_answer, suggested_bounty_usd, allowed, reason_if_not and resolved_location (where Eyes thinks you mean).
suggested_bounty_usd already fits this API key's max_bounty_usd, the daily cap left and your balance, so ask_eyes accepts it. allowed is false only when you cannot post this task right now: the safety rules refuse this task_type at this place, the task_type is not allowed for this key, or even the 1 USD minimum bounty plus the 0.50 USD fee does not fit your limits or balance; reason_if_not says what to do. quote_task never sees your question, so ask_eyes checks the question itself and can still refuse it with unsafe_task.
location is {lat, lng} or a string such as "Blue Bottle Coffee, Mint Plaza, San Francisco". task_type is one of: is_open, line_length, in_stock, photo_of_place, price_check, crowd_level, other_public.
Example: quote_task({ "location": "Ferry Building, San Francisco", "task_type": "line_length" })
Next: if allowed is true and workers_nearby > 0, call ask_eyes with the same location and task_type, using suggested_bounty_usd as bounty_usd. If resolved_location is not the place you meant, retry with a more specific string or {lat, lng}. If workers_nearby is 0, try a nearby busier place or later.`,
      inputSchema: TOOLS.quote_task.input,
      outputSchema: TOOLS.quote_task.output,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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
idempotency_key is required: any unique string for each task you intend to create, for example a UUID. Reuse the same key when you retry that task: the same key and parameters return the original task instead of charging again, so retries after a timeout or network error are safe. Use a new key for a new question.
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
    },
    (input, ctx) => run(() => service.getTask(ctx.get("agent"), input)),
  );

  const card = taskCard(env.EYES_VIEWS_MANIFEST || VIEWS_MANIFEST);
  if (card) server[registerViews]({ [TASK_CARD]: card });
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
      ...(card && {
        view: {
          name: TASK_CARD,
          description: "An Eyes task: status, answer, photo, verification checks and cost.",
          ...(env.INSFORGE_BASE_URL && {
            csp: { resourceDomains: [new URL(env.INSFORGE_BASE_URL).origin] },
          }),
        },
      }),
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
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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

  const hits = new Map<string, number[]>();
  const throttle = (c: Context) => {
    const now = deps.providers.clock.now().getTime();
    for (const [key, times] of hits) {
      if ((times.at(-1) ?? 0) > now - HOUR_MS && hits.size < THROTTLE_MAX_KEYS) break;
      hits.delete(key);
    }
    const key = `${c.req.path} ${clientKey(c.req.header("x-forwarded-for"))}`;
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
  const classifier = Boolean(env.ANTHROPIC_API_KEY);
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
  server.get("/healthz", (c) => {
    const providers = Object.fromEntries(
      Object.entries(live).map(([name, on]) => [name, on ? "live" : "fake"]),
    );
    return c.json({ ok: true, providers, db });
  });
  const status = statusPage(live, classifier, db, env.EYES_COMMIT);
  server.get("/status", (c) => c.html(status, 200, PAGE_HEADERS));

  const { rpc } = deps;
  if (env.EYES_OPS_KEY && rpc) {
    const opsKey = sha256(env.EYES_OPS_KEY).digest();
    const operator = (key: string) => timingSafeEqual(opsKey, sha256(key).digest());
    server.get("/ops/:key", (c) =>
      operator(c.req.param("key")) ? c.html(DASHBOARD, 200, OPS_HEADERS) : c.notFound(),
    );
    server.get("/ops/:key/feed", async (c) => {
      if (!operator(c.req.param("key"))) return c.notFound();
      const { workers, ...feed } = (await readFeed(rpc)) as { workers: { lat: number; lng: number }[] };
      const coarseWorkers = workers.map((w) => ({ ...w, lat: coarse(w.lat), lng: coarse(w.lng) }));
      return c.json({ ...feed, workers: coarseWorkers }, 200, OPS_HEADERS);
    });
  }

  return server;
}
