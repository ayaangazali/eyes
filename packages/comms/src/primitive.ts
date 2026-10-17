import { setTimeout as sleep } from "node:timers/promises";
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
const MAX_REFERENCES = 20;
const AWAIT_ROUNDS = 300;
const AWAIT_RETRY_MS = 5_000;
const ENDED_UNANSWERED = new Set(["expired", "refunded"]);
const QUOTE_START =
  /^(?:--\s?|_{3,}|-{3,}\s*original message\s*-{3,}|on .+ wrote:|from: .+|sent from my .+)$/i;
const DIRECTIVE = /^\s*(location|at|type)\s*:\s*(.*)$/i;

const usd = (amount: number) => `$${amount.toFixed(2)}`;
const errorName = (err: unknown) =>
  err instanceof EyesError ? err.code : err instanceof Error ? err.name : typeof err;

async function download(attachment: EmailAttachment) {
  const res = await fetch(attachment.url, { signal: AbortSignal.timeout(20_000) });
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (!res.ok || declared > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment ${attachment.filename}: HTTP ${res.status}, ${declared} bytes`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`attachment ${attachment.filename} is over ${MAX_ATTACHMENT_BYTES} bytes`);
  }
  return {
    filename: attachment.filename,
    content_type: attachment.content_type,
    content_base64: bytes.toString("base64"),
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

export function parseTaskEmail(
  subject: string | null,
  text: string | null,
): { question: string; location: string | null; task_type: TaskType } {
  const body: string[] = [];
  let location: string | null = null;
  let type: string | null = null;
  for (const line of (text ?? "").split(/\r?\n/)) {
    if (QUOTE_START.test(line.trim())) break;
    if (line.trimStart().startsWith(">")) continue;
    const directive = line.match(DIRECTIVE);
    if (!directive) body.push(line);
    else if (directive[1]?.toLowerCase() === "type") type ??= directive[2]?.trim() ?? null;
    else location ??= directive[2]?.trim() || null;
  }
  const title = (subject ?? "").replace(/^\s*(?:(?:re|fwd?|aw)\s*:\s*)+/i, "").trim();
  const rest = body.join(" ").replace(/\s+/g, " ").trim();
  const question = [title, rest].filter(Boolean).join(/[.?!:]$/.test(title) ? " " : ". ");
  return {
    question: question.slice(0, QUESTION_MAX_CHARS).replace(/\p{Cs}$/u, ""),
    location,
    task_type: TaskType.safeParse(type?.toLowerCase().replace(/[\s-]+/g, "_")).data ?? "other_public",
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
  for (let round = 0; round < AWAIT_ROUNDS; round++) {
    let result: ToolOutput<"await_answer">;
    try {
      result = await deps.service.awaitAnswer(agent, { task_id: task.task_id, timeout_seconds: 55 });
    } catch (err) {
      console.error(`primitive: awaitAnswer for task ${task.task_id} failed: ${errorName(err)}`);
      await sleep(AWAIT_RETRY_MS);
      continue;
    }
    if (result.answer) {
      const text = answerText(result.answer);
      const photo = result.answer.photo_url;
      if (!photo) return reply(text);
      return reply(text, [{ filename: "eyes-photo.jpg", content_type: "image/jpeg", url: photo }]).catch(() =>
        reply(text),
      );
    }
    if (ENDED_UNANSWERED.has(result.status)) {
      return reply(
        `Task ${task.task_id} ended without an answer (${result.status}). The ${usd(task.escrowed_usd)} escrow is refunded to your balance.`,
      );
    }
  }
}

async function handleEmail(deps: RouteDeps, agent: Agent, email: ReceivedEmail, following: Set<string>) {
  const messageId = email.thread.messageId ?? undefined;
  const reply: Reply = (text, attachments) =>
    deps.providers.email.send({
      to: email.replyTarget.address,
      subject: email.replySubject,
      text,
      in_reply_to: messageId,
      references: [...email.thread.references, ...(messageId ? [messageId] : [])].slice(-MAX_REFERENCES),
      attachments,
    });
  const parsed = parseTaskEmail(email.subject, email.text);
  if (!parsed.location) {
    return reply(
      `Eyes needs to know where to look. Please send the question again with the place on its own line, for example:\n\nLocation: Blue Bottle Coffee, Mint Plaza, San Francisco\n\nOptionally add a line "Type: <type>" with one of ${TASK_TYPES.join(", ")}.`,
    );
  }
  const input = AskEyesInput.safeParse({
    question: parsed.question,
    location: parsed.location,
    task_type: parsed.task_type,
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
            fix: "Put the question (5 to 500 characters) in the subject or body and the place on its own line as Location: <place> (200 characters or fewer).",
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
  if (!following.has(task.task_id)) {
    const id = task.task_id;
    following.add(id);
    void follow(deps, agent, task, reply)
      .catch((err: unknown) =>
        console.error(`primitive: answer reply for task ${id} failed: ${errorName(err)}`),
      )
      .finally(() => following.delete(id));
  }
  return reply(
    `Got it: task ${task.task_id}, ${task.workers_notified} workers notified, escrowed ${usd(task.escrowed_usd)}. We'll reply here with the answer.`,
  );
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

export function primitiveRoutes(deps: RouteDeps, env: Env): Hono {
  const following = new Set<string>();
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
    const agentId = email.receivedByAll
      .map((address) => agentIdFromEmailAddress(deps.config.link_secret, address))
      .find((id) => id !== null);
    const agent = agentId ? await deps.service.agentById(agentId) : null;
    if (!agent) return c.text("ignored");
    await handleEmail(deps, agent, email, following);
    return c.text("ok");
  });
}
