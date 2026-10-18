import { readFileSync, writeFileSync } from "node:fs";
import {
  AskEyesDraftInput,
  AskEyesDraftOutput,
  AskEyesMcpOutput,
  ERRORS,
  FAKE_PLACES,
  HTTP_ROUTES,
  SignupInput,
  SignupOutput,
  TOOLS,
  type ToolName,
} from "@eyes/core";
import { z } from "zod";

type Json = Record<string, unknown>;
type Documented = Exclude<
  keyof typeof HTTP_ROUTES,
  | "health"
  | "topup_redirect"
  | `owner_${string}`
  | `worker_${string}`
  | `offer_${string}`
  | `webhook_${string}`
>;
type Op = {
  id: string;
  tag: "agent" | "docs";
  summary: string;
  description: string;
  auth: boolean;
  params?: Record<string, Json>;
  query?: Json;
  body?: Json;
  example?: Json;
  response: Json;
  responseType?: string;
};

export const PUBLIC_DIR = new URL("../../docs/public/", import.meta.url);

const VERSION = "0.1.0";
const DESCRIPTION =
  "Eyes pays a nearby human a few dollars to check something in a public place right now (is it open, how long is the line, is it in stock, how crowded is it) and returns a verified answer with a live photo.";
const MCP_BINDING = "https://modelcontextprotocol.io/specification/latest/basic/transports#streamable-http";
const OPENAPI_BINDING = "https://spec.openapis.org/oas/v3.1.0";
const TASK_ID = { task_id: "3f0e8c1a-5b7d-4e2f-9a6b-1c2d3e4f5a6b" };
const DEMO_PLACES = Object.values(FAKE_PLACES)
  .map((place) => `"${place.label}"`)
  .join(", ");

const TOOL_DOCS: Record<ToolName, { title: string; summary: string; tags: string[]; example: Json }> = {
  quote_task: {
    title: "Quote a task",
    summary:
      "Free and read-only. Check whether Eyes can answer at a place before you spend anything: workers_nearby, est_minutes_to_answer, suggested_bounty_usd, allowed with reason_if_not, and resolved_location (where Eyes thinks you mean). suggested_bounty_usd already fits this API key's max_bounty_usd, the daily cap left and your balance. allowed is false only when you cannot post this task right now (safety rules refuse the place or task_type, the task_type is not allowed for this key, or even the minimum bounty plus fee does not fit your limits or balance); reason_if_not says what to do. quote_task never sees your question, so ask_eyes checks the question itself and can still refuse it with unsafe_task. Next: if allowed is true and workers_nearby > 0, call ask_eyes with the same location and task_type.",
    tags: ["coverage", "pricing"],
    example: { location: "Ferry Building, San Francisco", task_type: "line_length" },
  },
  ask_eyes: {
    title: "Ask a human to check",
    summary:
      "For REST and non-UI MCP dispatch, pay a nearby human to look at a public place and answer your question, usually with a live photo. bounty_usd (default 3) plus a 0.50 USD fee is escrowed on dispatch, paid to the worker only after a verified answer, and refunded in full if nobody answers before deadline_minutes or you cancel before a worker claims it. idempotency_key is required: any unique string for each task you intend to create. Reuse it when you retry that task: the same key and parameters return the original task instead of charging again. Only public, commercial or civic places. After dispatch, call await_answer with the returned task_id immediately. Interactive MCP instead prepares the read-only draft documented below; payment requires a later card confirmation.",
    tags: ["physical-world", "human-verification", "real-time"],
    example: {
      question: "How many people are waiting in line right now?",
      location: "Blue Bottle Coffee, Mint Plaza, San Francisco",
      task_type: "line_length",
      bounty_usd: 3,
      idempotency_key: "6f1c2a9e-line-check",
    },
  },
  report_classifier: {
    title: "Report an incorrect classifier block",
    summary:
      "Create an internal Support ticket with the original refused Ask and client-reported unsafe_task context. Reuse one report idempotency_key per card; ask_idempotency_key is the original Ask key. No dispatch, messages or charge. A human may approve this exact request for the same agent for 24 hours. Next: explicitly check get_classifier_report.",
    tags: ["support", "review"],
    example: {
      question: "Is the cafe open now?",
      location: "Ferry Building, San Francisco",
      task_type: "is_open",
      bounty_usd: 3,
      ask_idempotency_key: "original-ask",
      idempotency_key: "report-card",
      classifier_error: { error: "unsafe_task", reason: "Reported classifier refusal" },
    },
  },
  get_classifier_report: {
    title: "Check classifier review",
    summary:
      "Read your ticket status. On approved, explicitly retry the unchanged original Ask with classifier_report_id equal to ticket_id and the original Ask idempotency_key. Rejected or expired does not permit retry. Consumed returns the existing task_id. Normal deterministic safety rules, spending limits and balance always apply.",
    tags: ["support", "status"],
    example: { ticket_id: "123" },
  },
  await_answer: {
    title: "Wait for the answer",
    summary:
      "Long-poll for the answer to a task. Each call waits up to timeout_seconds (default 50, max 55) and returns as soon as the task is answered. Call it right after ask_eyes and keep calling it with the same task_id until answered is true or status is expired, refunded or disputed; you cannot receive events in the background, so this loop is how you get the answer. answered: false only means not yet; tasks usually take 5 to 20 minutes.",
    tags: ["physical-world", "polling"],
    example: TASK_ID,
  },
  get_task: {
    title: "Get task status",
    summary:
      "Instant, read-only status and details of one task, including the answer once there is one. To wait for an answer call await_answer instead of polling get_task.",
    tags: ["status"],
    example: TASK_ID,
  },
  list_tasks: {
    title: "List your tasks",
    summary:
      "Instant, read-only list of the tasks this API key created, newest first: task_id, status, question, place_label, bounty_usd, created_at, deadline_at and answered. Call it when you lost a task_id (context reset, crash) and before asking a question again, so you resume an open task instead of paying twice. status filters to one status; limit is 1 to 50 (default 20). Next: await_answer any task still dispatched, claimed or submitted; get_task any task where answered is true.",
    tags: ["status", "recovery"],
    example: { status: "dispatched", limit: 5 },
  },
  cancel_task: {
    title: "Cancel a task",
    summary:
      "Cancel a task that no worker has claimed yet (status dispatched) and refund the full escrow, bounty plus fee. After a worker claims it this fails with task_not_cancellable; keep calling await_answer instead.",
    tags: ["refund"],
    example: TASK_ID,
  },
  accept_answer: {
    title: "Accept an answer",
    summary:
      "Record your user's positive feedback on an owned answered task with status verified or paid. Returns status accepted and the first accepted_at timestamp. Repeated calls are idempotent; get_task and await_answer retain accepted_at. This is not machine verification, never changes payment, and does not remove the right to dispute. Next: accept only after your user says the answer looks good.",
    tags: ["feedback"],
    example: TASK_ID,
  },
  dispute_answer: {
    title: "Dispute an answer",
    summary:
      "Flag an answered task (status verified, paid or needs_review) as wrong. The worker payout is held and the task goes to human review. Give a specific reason. To get a fresh answer now, call ask_eyes again with a new idempotency_key.",
    tags: ["refund", "review"],
    example: { ...TASK_ID, reason: "The photo shows a different cafe, not Blue Bottle." },
  },
  get_balance: {
    title: "Get balance",
    summary:
      "Your prepaid balance and the amount escrowed in open tasks, in USD, plus top_up_url: a link your human opens to add funds with Stripe Checkout. If balance_usd is below bounty_usd + 0.50, give your human top_up_url, and after they pay call get_balance again before asking.",
    tags: ["billing"],
    example: {},
  },
  get_spend_policy: {
    title: "Get spend policy",
    summary:
      "The limits your human set on this API key: max_bounty_usd per task, daily_cap_usd, spent_today_usd and remaining_today_usd (UTC day), and allowed_task_types. Stay within them when you call ask_eyes; only your human can change them.",
    tags: ["billing", "limits"],
    example: {},
  },
};

const schema = (s: z.ZodType, io: "input" | "output" = "output"): Json => {
  const { $schema, ...rest } = z.toJSONSchema(s, { io }) as Json;
  return rest;
};

const pathParams = (route: string) => [...route.matchAll(/:(\w+)/g)].map((m) => m[1] as string);

function toolOp(name: ToolName, route: Documented): Op {
  const input = schema(TOOLS[name].input, "input");
  const props = input.properties as Record<string, Json>;
  const params = pathParams(HTTP_ROUTES[route]);
  const drop = (o: Json) => Object.fromEntries(Object.entries(o).filter(([k]) => !params.includes(k)));
  const bodyProps = drop(props);
  const hasBody = HTTP_ROUTES[route].startsWith("POST") && Object.keys(bodyProps).length > 0;
  const query = HTTP_ROUTES[route].startsWith("GET") ? bodyProps : {};
  const required = ((input.required as string[] | undefined) ?? []).filter((k) => !params.includes(k));
  const { example, title, summary } = TOOL_DOCS[name];
  return {
    id: name,
    tag: "agent",
    summary: title,
    description: `${summary} Same as ${name === "ask_eyes" ? "non-UI" : "the"} MCP tool ${name}.`,
    auth: true,
    params: Object.fromEntries(params.map((p) => [p, props[p] as Json])),
    query,
    body: hasBody ? { ...input, properties: bodyProps, required } : undefined,
    example: hasBody ? drop(example) : undefined,
    response: schema(TOOLS[name].output),
  };
}

const docOp = (id: string, summary: string, type: string): Op => ({
  id,
  tag: "docs",
  summary,
  description: `${summary} Public.`,
  auth: false,
  response: { type: type === "application/json" ? "object" : "string" },
  responseType: type,
});

const OPS: Record<Documented, Op> = {
  mcp: {
    id: "mcp",
    tag: "agent",
    summary: "MCP endpoint",
    description: `MCP Streamable HTTP endpoint (JSON-RPC 2.0). Connect an MCP client here with the header Authorization: Bearer <api_key>; do not hand-craft requests. Model tools: ${[...Object.keys(TOOLS), "show_task"].join(", ")}. Additional app-only action: confirm_ask. Interactive ask_eyes prepares a read-only confirmation draft; REST and non-UI ask_eyes dispatch directly (schemas in /llms-full.txt).`,
    auth: true,
    body: { type: "object", description: "An MCP JSON-RPC 2.0 message." },
    response: { type: "object", description: "An MCP JSON-RPC 2.0 response, as JSON or text/event-stream." },
  },
  signup: {
    id: "signup",
    tag: "agent",
    summary: "Create an API key",
    description:
      "Public, no API key needed. Creates an agent and returns api_key (shown only once, store it), top_up_url (a Stripe Checkout link for your human to fund the balance, when payments are live) and email_address (a private address for asking Eyes by email; null when email is not configured; anyone who knows it can spend your balance). Test mode grants 20 USD. Pass owner_email, your human's email address: when email is live (see GET /status), Eyes emails them a private control link to set your spend limits and add funds, and you never see that link. Then send Authorization: Bearer <api_key> on every other call.",
    auth: false,
    body: schema(SignupInput, "input"),
    example: { name: "my-research-agent", owner_email: "owner@example.com" },
    response: schema(SignupOutput),
  },
  quote: toolOp("quote_task", "quote"),
  ask: toolOp("ask_eyes", "ask"),
  report_classifier: toolOp("report_classifier", "report_classifier"),
  get_classifier_report: toolOp("get_classifier_report", "get_classifier_report"),
  await_answer: toolOp("await_answer", "await_answer"),
  get_task: toolOp("get_task", "get_task"),
  list_tasks: toolOp("list_tasks", "list_tasks"),
  cancel_task: toolOp("cancel_task", "cancel_task"),
  accept_answer: toolOp("accept_answer", "accept_answer"),
  dispute_answer: toolOp("dispute_answer", "dispute_answer"),
  get_balance: toolOp("get_balance", "get_balance"),
  get_spend_policy: toolOp("get_spend_policy", "get_spend_policy"),
  llms_txt: docOp("llms_txt", "Start here: what Eyes does, pricing and the quickstart.", "text/plain"),
  llms_full_txt: docOp("llms_full_txt", "Full reference: tool schemas and the error catalog.", "text/plain"),
  openapi: docOp("openapi", "This OpenAPI document.", "application/json"),
  agent_card: docOp("agent_card", "A2A agent card.", "application/json"),
};

const ERROR_SCHEMA = {
  type: "object",
  description:
    "Every error. Extra fields carry context, for example issues for invalid_input, or balance_usd and top_up_url for insufficient_balance.",
  properties: {
    error: { type: "string", enum: Object.keys(ERRORS), description: "Stable error code." },
    message: { type: "string", description: "What went wrong." },
    fix: { type: "string", description: "What to do next. Always present: follow it." },
  },
  required: ["error", "message", "fix"],
  additionalProperties: true,
};

function openapi(): Json {
  const paths: Record<string, Json> = {};
  for (const [route, op] of Object.entries(OPS) as [Documented, Op][]) {
    const [method = "", path = ""] = HTTP_ROUTES[route].split(" ");
    const parameters = [
      ...Object.entries(op.params ?? {}).map(([name, s]) => ({
        name,
        in: "path",
        required: true,
        schema: s,
      })),
      ...Object.entries(op.query ?? {}).map(([name, s]) => ({ name, in: "query", schema: s })),
    ];
    const media = (s: Json, example?: Json) => (example ? { schema: s, example } : { schema: s });
    const key = path.replace(/:(\w+)/g, "{$1}");
    paths[key] = {
      ...paths[key],
      [method.toLowerCase()]: {
        operationId: op.id,
        tags: [op.tag],
        summary: op.summary,
        description: op.description,
        ...(op.auth ? {} : { security: [] }),
        ...(parameters.length ? { parameters } : {}),
        ...(op.body
          ? {
              requestBody: {
                ...((op.body.required as unknown[] | undefined)?.length ? { required: true } : {}),
                content: { "application/json": media(op.body, op.example) },
              },
            }
          : {}),
        responses: {
          "200": {
            description: "Success.",
            content: { [op.responseType ?? "application/json"]: media(op.response) },
          },
          "4XX": { $ref: "#/components/responses/Error" },
          "5XX": { $ref: "#/components/responses/Error" },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Eyes",
      version: VERSION,
      description: `${DESCRIPTION} Paths are relative to this server's origin. Start with /llms.txt, and check GET /status for which parts of this server are live: a simulated deploy sends no texts and has no workers, and with simulated place lookup only {lat, lng} coordinates and the demo places ${DEMO_PLACES} resolve. The same tools are available over MCP at POST /mcp.`,
    },
    servers: [{ url: "/" }],
    security: [{ bearer: [] }],
    tags: [
      { name: "agent", description: "Called by AI agents with a bearer API key (signup is public)." },
      { name: "docs", description: "Public agent-facing documents." },
    ],
    paths,
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "API key from POST /v1/signup." },
      },
      schemas: { Error: ERROR_SCHEMA },
      responses: {
        Error: {
          description: `Error. Status by code: ${Object.entries(ERRORS)
            .map(([code, e]) => `${code} ${e.status}`)
            .join(", ")}.`,
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
  };
}

const jsonBlock = (label: string, value: unknown) => [
  `${label}:`,
  "```json",
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && "format" in v && "pattern" in v ? { ...v, pattern: undefined } : v,
  ),
  "```",
];

function llmsFull(llms: string): string {
  const tools = (Object.entries(OPS) as [Documented, Op][]).filter(([, op]) => op.id in TOOLS);
  const out = [
    llms.trimEnd(),
    "",
    "## Signup (REST only)",
    "",
    `${HTTP_ROUTES.signup}. ${OPS.signup.description}`,
    "",
    ...jsonBlock("Input", OPS.signup.body),
    ...jsonBlock("Output", OPS.signup.response),
    "",
    "## Tools",
    "",
    "These 13 model-visible tools include show_task (the get_task card). The tools below have REST counterparts; task_id goes in the path and other fields in the JSON body or GET query. Interactive MCP ask_eyes returns a read-only confirmation draft instead of posting. REST and non-UI MCP ask_eyes retain direct dispatch. The additional confirm_ask action is app-only, not a model tool or REST endpoint.",
  ];
  for (const [route, op] of tools) {
    const name = op.id as ToolName;
    out.push(
      "",
      `### ${name}: ${TOOL_DOCS[name].title}`,
      "",
      `REST: ${HTTP_ROUTES[route].replace(/:(\w+)/g, "{$1}")}`,
      "",
      TOOL_DOCS[name].summary,
      "",
      `Example: ${name}(${JSON.stringify(TOOL_DOCS[name].example)})`,
      "",
      ...jsonBlock("Input", schema(TOOLS[name].input, "input")),
      ...jsonBlock("Output", schema(TOOLS[name].output)),
      ...(name === "ask_eyes"
        ? [
            "",
            "Interactive MCP preparation uses the draft input and output below (status confirmation_required; no task, escrow or messages). The card confirms the same intent with confirm_ask. Never follow its success with a new paid ask.",
            ...jsonBlock("Interactive MCP input", schema(AskEyesDraftInput, "input")),
            ...jsonBlock("Interactive MCP output", schema(AskEyesDraftOutput)),
          ]
        : []),
    );
  }
  out.push(
    "",
    "## App-only confirmation",
    "",
    "confirm_ask accepts the same input as ask_eyes and returns the MCP dispatch result below. The card calls it only after an explicit user click. Native MCP Apps visibility is app-only and OpenAI visibility is private. Conforming hosts hide this action from the model. This is a host boundary, not cryptographic proof of a human click; clients that ignore visibility are not covered. Authentication, ownership, spending limits, safety checks and atomic idempotency are unchanged.",
    "",
    "The card retains one idempotency_key and frozen submitted parameters for retries, including after a timeout. An intentional Ask Again gets a new key and a fresh confirmation. Identical questions are not globally deduplicated.",
    "",
    ...jsonBlock("Input", schema(TOOLS.ask_eyes.input, "input")),
    ...jsonBlock("Output", schema(AskEyesMcpOutput)),
    "",
    "## Errors",
    "",
    'Every error is JSON: {"error": "<code>", "message": "...", "fix": "...", ...context}. Over REST it comes with the HTTP status below; over MCP the tool result has isError: true and the same JSON as text. A {name} in a fix below is filled from the field of the same name in the error body. One exception: over MCP, arguments that do not match a tool input schema return a plain "Input validation error" text naming each bad field; fix those fields and call again.',
    "",
    ...Object.entries(ERRORS).map(([code, e]) => `- ${code} (HTTP ${e.status}): ${e.message} Fix: ${e.fix}`),
  );
  return `${out.join("\n")}\n`;
}

function agentCard(): Json {
  return {
    name: "Eyes",
    description: DESCRIPTION,
    supportedInterfaces: [
      { url: "/mcp", protocolBinding: MCP_BINDING, protocolVersion: "1.0" },
      { url: "/", protocolBinding: OPENAPI_BINDING, protocolVersion: "1.0" },
    ],
    version: VERSION,
    documentationUrl: "/llms.txt",
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          description: "API key from POST /v1/signup, sent as Authorization: Bearer <api_key>.",
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: (Object.keys(TOOLS) as ToolName[]).map((name) => ({
      id: name,
      name: TOOL_DOCS[name].title,
      description: TOOL_DOCS[name].summary,
      tags: TOOL_DOCS[name].tags,
      examples: [`${name}(${JSON.stringify(TOOL_DOCS[name].example)})`],
    })),
  };
}

export function generateDocs(llms: string): Record<string, string | Json> {
  return {
    "openapi.json": openapi(),
    ".well-known/agent-card.json": agentCard(),
    "llms-full.txt": llmsFull(llms),
  };
}

export function writeDocs(llms: string, dir: URL): void {
  for (const [file, content] of Object.entries(generateDocs(llms))) {
    const text = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
    writeFileSync(new URL(file, dir), text);
  }
}

/* v8 ignore start -- process entry: writes the committed public files; runs only when this file is executed directly */
if (import.meta.main) {
  writeDocs(readFileSync(new URL("llms.txt", PUBLIC_DIR), "utf8"), PUBLIC_DIR);
}
/* v8 ignore stop */
