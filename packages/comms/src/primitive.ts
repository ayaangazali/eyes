import {
  type Agent,
  type Answer,
  AskEyesInput,
  agentIdFromEmailAddress,
  type Email,
  type EmailAttachment,
  EyesError,
  type RouteDeps,
  TASK_TYPES,
  TaskType,
  type ToolOutput,
  toErrorBody,
} from "@eyes/core";
import {
  createPrimitiveClient,
  type EmailReceivedEvent,
  isTrustedSender,
  normalizeReceivedEmail,
  PRIMITIVE_SIGNATURE_HEADER,
  type ReceivedEmail,
  safeValidateEmailReceivedEvent,
  verifyWebhookSignature,
} from "@primitivedotdev/sdk";
import { Hono } from "hono";
import type { Env } from "./inkbox.ts";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const QUESTION_MAX_CHARS = 500;
const SUBJECT_MAX_CHARS = 200;
const MAX_REFERENCES = 20;
const AWAIT_ROUNDS = 300;
const AWAIT_MAX_FAILURES = 5;
const AWAIT_RETRY_MS = 5_000;
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
const SEEN_MAX = 10_000;
const BODY_MAX_CHARS = 20_000;
const WAITING = new Set(["dispatched", "claimed", "submitted"]);
const REFUNDED = new Set(["expired", "refunded"]);
const QUOTE_START = /^(?:--\s?|_{3,}|-{3,}\s*original message\s*-{3,}|sent from my .+)$/i;
const DIRECTIVE = /^\s*(location|at|type|bounty|deadline)\s*:\s*(.*)$/i;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };

const usd = (amount: number) => `$${amount.toFixed(2)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errorName = (err: unknown) =>
  err instanceof EyesError ? err.code : err instanceof Error ? err.name : typeof err;

async function download(attachment: EmailAttachment) {
  const res = await fetch(attachment.url, { signal: AbortSignal.timeout(20_000) });
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (!res.ok || !res.body || declared > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment ${attachment.filename}: HTTP ${res.status}, ${declared} bytes`);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    size += part.value.byteLength;
    if (size > MAX_ATTACHMENT_BYTES) {
      await reader.cancel();
      throw new Error(`attachment ${attachment.filename} is over ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    chunks.push(part.value);
  }
  const header = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  const contentType = header.startsWith("image/") ? header : attachment.content_type;
  return {
    filename: attachment.filename.includes(".")
      ? attachment.filename
      : `${attachment.filename}.${contentType.split("/")[1]}`,
    content_type: contentType,
    content_base64: Buffer.concat(chunks).toString("base64"),
  };
}

export function createPrimitiveEmail(env: Env): Email {
  const apiKey = env.PRIMITIVE_API_KEY;
  const domain = env.PRIMITIVE_DOMAIN;
  if (!apiKey) {
    throw new Error("PRIMITIVE_API_KEY is not set. Create one at https://www.primitive.dev/developers.");
  }
  if (!domain) {
    throw new Error(
      "PRIMITIVE_DOMAIN is not set. Set it to the org's managed subdomain, e.g. brave-otter.primitive.email.",
    );
  }
  const client = createPrimitiveClient({ apiKey });
  return {
    async send(msg) {
      const attachments = await Promise.all((msg.attachments ?? []).map(download));
      const sent = await client.send({
        from: `eyes@${domain}`,
        to: msg.to,
        subject: msg.subject,
        bodyText: msg.text,
        bodyHtml: msg.html,
        thread: { inReplyTo: msg.in_reply_to, references: msg.references },
        attachments,
      });
      if (sent.status === "gate_denied" || sent.status === "agent_failed") {
        throw new Error(`Primitive send ${sent.status} (request ${sent.requestId})`);
      }
      return { id: sent.id, message_id: null };
    },
  };
}

const htmlToText = (html: string) =>
  html
    .slice(0, BODY_MAX_CHARS)
    .replace(/<(style|script)\b[^<>]*>[^<]*<\/\1>/gi, "")
    .replace(/<br\b[^<>]*>|<\/(?:p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^<>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ENTITIES[name] ?? "");

export function parseTaskEmail(
  subject: string | null,
  text: string | null,
  html: string | null = null,
): {
  question: string;
  location: string | null;
  task_type: TaskType;
  bounty_usd?: number;
  deadline_minutes?: number;
} {
  const lines = (text?.slice(0, BODY_MAX_CHARS) ?? (html ? htmlToText(html) : "")).split(/\r?\n/);
  const body: string[] = [];
  const fields: Record<string, string> = {};
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (/wrote:$/i.test(trimmed)) {
      if (/^on\s/i.test(body.at(-1)?.trim() ?? "")) body.pop();
      break;
    }
    if (QUOTE_START.test(trimmed)) break;
    if (/^from:/i.test(trimmed) && lines.slice(i + 1, i + 4).some((l) => /^\s*(sent|date):/i.test(l))) break;
    if (trimmed.startsWith(">")) continue;
    const directive = line.match(DIRECTIVE);
    const key = directive?.[1]?.toLowerCase();
    if (!key) body.push(line);
    else fields[key === "at" ? "location" : key] ??= directive?.[2]?.trim() ?? "";
  }
  const title = (subject ?? "").replace(/^\s*(?:(?:re|fwd?|aw)\s*:\s*)+/i, "").trim();
  const rest = body.join(" ").replace(/\s+/g, " ").trim();
  const question = [title, rest].filter(Boolean).join(/[.?!:]$/.test(title) ? " " : ". ");
  return {
    question: question.slice(0, QUESTION_MAX_CHARS).replace(/\p{Cs}$/u, ""),
    location: fields.location || null,
    task_type: TaskType.safeParse(fields.type?.toLowerCase().replace(/[\s-]+/g, "_")).data ?? "other_public",
    bounty_usd:
      fields.bounty === undefined
        ? undefined
        : Number(fields.bounty.replace(/^\$\s*|\s*(?:usd|dollars?)$/gi, "")),
    deadline_minutes:
      fields.deadline === undefined
        ? undefined
        : Number(fields.deadline.replace(/\s*(?:minutes?|mins?)$/i, "")),
  };
}

function answerText(a: Answer): string {
  const check = (ok: boolean) => (ok ? "passed" : "failed");
  return [
    `Answer for task ${a.task_id}: ${a.answer_text}`,
    ...(a.answer_bool === null ? [] : [`Yes/no: ${a.answer_bool ? "yes" : "no"}`]),
    `Verification: GPS ${check(a.verification.gps_ok)}, fresh photo ${check(a.verification.fresh_ok)}, vision ${check(a.verification.vision_ok)} (${a.verification.vision_reason})`,
    `The worker was ${Math.round(a.worker_distance_m)} m from the place. Confidence ${a.confidence.toFixed(2)}. Cost ${usd(a.cost_usd)}.`,
    `Captured at ${a.captured_at}.${a.photo_url ? ` Photo attached, also at ${a.photo_url}` : ""}`,
  ].join("\n");
}

function errorText(err: unknown): string {
  const body = toErrorBody(err);
  return `Eyes could not post this task: ${body.message}\n\nHow to fix: ${body.fix}`;
}

type Reply = (text: string, attachments?: EmailAttachment[]) => Promise<unknown>;

async function follow(deps: RouteDeps, agent: Agent, task: ToolOutput<"ask_eyes">, reply: Reply) {
  let failures = 0;
  for (let round = 0; round < AWAIT_ROUNDS; round++) {
    let result: ToolOutput<"await_answer">;
    try {
      result = await deps.service.awaitAnswer(agent, { task_id: task.task_id, timeout_seconds: 55 });
      failures = 0;
    } catch (err) {
      console.error(`primitive: awaitAnswer for task ${task.task_id} failed: ${errorName(err)}`);
      if (++failures >= AWAIT_MAX_FAILURES) break;
      await sleep(AWAIT_RETRY_MS);
      continue;
    }
    if (result.answer) {
      const photo = result.answer.photo_url;
      return reply(
        answerText(result.answer),
        photo ? [{ filename: "eyes-photo", content_type: "image/jpeg", url: photo }] : undefined,
      );
    }
    if (!WAITING.has(result.status)) {
      return reply(
        `Task ${task.task_id} ended without an answer (${result.status}).${
          REFUNDED.has(result.status)
            ? ` The ${usd(task.escrowed_usd)} escrow is refunded to your balance.`
            : " Call get_task with this task_id for details."
        }`,
      );
    }
  }
  return reply(
    `Eyes stopped waiting on task ${task.task_id}. Call get_task with this task_id for its status.`,
  );
}

async function handleEmail(deps: RouteDeps, agent: Agent, email: ReceivedEmail) {
  const messageId = email.thread.messageId ?? undefined;
  const send = (text: string, attachments?: EmailAttachment[]) =>
    deps.providers.email.send({
      to: email.sender.address,
      subject: email.replySubject
        .replace(/[\r\n]/g, " ")
        .slice(0, SUBJECT_MAX_CHARS)
        .replace(/\p{Cs}$/u, ""),
      text,
      in_reply_to: messageId,
      references: [...email.thread.references, ...(messageId ? [messageId] : [])].slice(-MAX_REFERENCES),
      attachments,
    });
  const reply: Reply = (text, attachments) =>
    send(text, attachments)
      .catch((err: unknown) => (attachments ? send(text) : Promise.reject(err)))
      .catch((err: unknown) => console.error(`primitive: reply to ${email.id} failed: ${errorName(err)}`));
  const parsed = parseTaskEmail(email.subject, email.text, email.raw.email.parsed.body_html);
  if (!parsed.location) {
    return reply(
      `Eyes needs to know where to look. Please send the question again and add a line that starts with the word Location and a colon, followed by the place, for example a store name, street and city.\n\nYou can also add lines that start with Type, Bounty (USD) or Deadline (minutes) and a colon. Types: ${TASK_TYPES.join(", ")}.`,
    );
  }
  const input = AskEyesInput.safeParse({
    ...parsed,
    idempotency_key: (messageId ?? email.id).slice(0, 128),
  });
  if (!input.success) {
    const issues = input.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return reply(
      errorText(
        new EyesError(
          "invalid_input",
          {},
          {
            message: `The email did not make a valid task (${issues}).`,
            fix: "Put the question (5 to 500 characters) in the subject or body, the place on a line starting with the word Location and a colon (200 characters or fewer), and keep Bounty between 1 and 50 USD and Deadline between 5 and 240 minutes.",
          },
        ),
      ),
    );
  }
  let task: ToolOutput<"ask_eyes">;
  try {
    task = await deps.service.askEyes(agent, input.data);
  } catch (err) {
    if (!(err instanceof EyesError)) console.error(`primitive: askEyes failed: ${errorName(err)}`);
    return reply(errorText(err));
  }
  const id = task.task_id;
  void follow(deps, agent, task, reply).catch((err: unknown) =>
    console.error(`primitive: answer loop for task ${id} failed: ${errorName(err)}`),
  );
  return reply(
    `Got it: task ${id}, ${task.workers_notified} workers notified, escrowed ${usd(task.escrowed_usd)}. We'll reply here with the answer.`,
  );
}

function trustedSender(event: EmailReceivedEvent, domain: string, sender: string): boolean {
  try {
    return isTrustedSender(event, { domain, sender }).trusted;
  } catch {
    return false;
  }
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

export function primitiveRoutes(deps: RouteDeps, env: Env): Hono {
  const seen = new Map<string, number>();
  const firstDelivery = (keys: string[]) => {
    const now = deps.providers.clock.now().getTime();
    for (const [key, expires] of seen) {
      if (expires > now && seen.size < SEEN_MAX) break;
      seen.delete(key);
    }
    if (keys.some((key) => seen.has(key))) return false;
    for (const key of keys) seen.set(key, now + SEEN_TTL_MS);
    return true;
  };
  return new Hono().post("/", async (c) => {
    const raw = Buffer.from(await c.req.arrayBuffer());
    try {
      verifyWebhookSignature({
        rawBody: raw,
        signatureHeader: c.req.header(PRIMITIVE_SIGNATURE_HEADER) ?? "",
        secret: env.PRIMITIVE_WEBHOOK_SECRET ?? "",
        nowSeconds: Math.floor(deps.providers.clock.now().getTime() / 1000),
      });
    } catch {
      return c.text("invalid signature", 401);
    }
    const event = safeValidateEmailReceivedEvent(parseJson(raw));
    if (!event.success) {
      console.warn(`primitive: ignored a signed event that failed validation (${event.error.code})`);
      return c.text("ignored");
    }
    if (event.data.event !== "email.received") return c.text("ignored");
    const email = normalizeReceivedEmail(event.data);
    const sender = email.sender.address.toLowerCase();
    const senderDomain = sender.slice(sender.lastIndexOf("@") + 1);
    const ownDomains = [env.PRIMITIVE_DOMAIN, deps.config.email_domain].map((d) => d?.toLowerCase());
    if (!trustedSender(event.data, senderDomain, sender) || ownDomains.includes(senderDomain)) {
      console.warn(`primitive: ignored ${email.id}: sender not authenticated or our own`);
      return c.text("ignored");
    }
    const agentId = email.receivedByAll
      .map((address) => agentIdFromEmailAddress(deps.config.link_secret, address))
      .find((id) => id !== null);
    const agent = agentId ? await deps.service.agentById(agentId) : null;
    if (!agent) return c.text("ignored");
    if (!firstDelivery([event.data.id, `${agent.id}:${email.thread.messageId ?? email.id}`])) {
      return c.text("duplicate");
    }
    await handleEmail(deps, agent, email);
    return c.text("ok");
  });
}
