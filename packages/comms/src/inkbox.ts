import { createHash, timingSafeEqual } from "node:crypto";
import type { Messaging, OfferMessage, ReplyIntent, RouteDeps } from "@eyes/core";
import {
  type AgentIdentity,
  type IMessageWebhookPayload,
  Inkbox,
  type TextWebhookPayload,
  verifyWebhook,
} from "@inkbox/sdk";
import { Hono } from "hono";

export type Env = Record<string, string | undefined>;

const OFFER_MAX_CHARS = 159;
const SIGNATURE_TOLERANCE_S = 300;
const TIME_ZONE = "America/Los_Angeles";
const E164 = /^\+[1-9]\d{6,14}$/;
const LINKISH = /\S*(?:@|:\/\/|www\.)\S*|\S*[a-z0-9-]\.[a-z]{2,}\b\S*/gi;
const PHONEISH = /\+?\d[\d\s().-]{5,}\d/g;
const graphemes = new Intl.Segmenter("en");

const dollars = (cents: number) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
const miles = (meters: number) => `${Math.max(0.1, meters / 1609.344).toFixed(1)} mi`;

const localTime = (iso: string) =>
  new Date(iso)
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: TIME_ZONE,
      timeZoneName: "short",
    })
    .replace(/\s/g, " ");

function scrub(s: string): string {
  return s
    .replace(LINKISH, " ")
    .replace(PHONEISH, (m) => (m.replace(/\D/g, "").length >= 7 ? " " : m))
    .replace(/\s+/g, " ")
    .trim();
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  for (const { segment } of graphemes.segment(s)) {
    if (out.length + segment.length > max - 3) break;
    out += segment;
  }
  return `${out.trimEnd()}...`;
}

export function offerText(offer: OfferMessage): string {
  const head = `Eyes: ${dollars(offer.bounty_cents)} task, ${miles(offer.distance_m)} away. `;
  const tail = " Reply YES to claim.";
  const room = OFFER_MAX_CHARS - head.length - tail.length - 2;
  const question = scrub(offer.question);
  const place = clip(scrub(offer.place_label), Math.max(50, room - question.length));
  return `${head}${place}: ${clip(question, room - place.length)}${tail}`;
}

export function captureLinkText(msg: Parameters<Messaging["sendCaptureLink"]>[1]): string {
  return `Eyes: it's yours! Take the photo at ${msg.place_label} by ${localTime(msg.deadline_at)}. Never photograph people's faces. Open: ${msg.capture_url}`;
}

export function alreadyClaimedText(msg: Parameters<Messaging["sendAlreadyClaimed"]>[1]): string {
  return `Eyes: the ${msg.place_label} task was already claimed by someone else. Thanks for replying, watch for the next one.`;
}

export function paidText(msg: Parameters<Messaging["sendPaid"]>[1]): string {
  return `Eyes: you've been paid ${dollars(msg.amount_cents)} for the ${msg.place_label} task. Thank you!`;
}

const INTENTS: Record<string, ReplyIntent> = {
  yes: "yes",
  y: "yes",
  yep: "yes",
  yeah: "yes",
  ok: "yes",
  okay: "yes",
  claim: "yes",
  "👍": "yes",
  no: "no",
  n: "no",
  pass: "no",
  stop: "stop",
  unsubscribe: "stop",
  cancel: "stop",
  end: "stop",
  quit: "stop",
  start: "start",
  unstop: "start",
  help: "help",
  info: "help",
  "?": "help",
};

export function parseReplyIntent(text: string): ReplyIntent {
  const key = text.toLowerCase().replace(/[^\p{L}\p{N}👍?]/gu, "");
  const word = key.replace(/\?/g, "") || (key ? "?" : "");
  return INTENTS[word] ?? "unknown";
}

export function createInkboxMessaging(env: Env): Messaging {
  const apiKey = env.INKBOX_API_KEY;
  const handle = env.INKBOX_AGENT_HANDLE;
  if (!apiKey) {
    throw new Error("INKBOX_API_KEY is not set. Create an admin API key at https://inkbox.ai/console.");
  }
  if (!handle) {
    throw new Error(
      "INKBOX_AGENT_HANDLE is not set. Set it to the dispatcher identity handle, e.g. eyes-dispatch.",
    );
  }
  const inkbox = new Inkbox({ apiKey });
  let identity: Promise<AgentIdentity> | undefined;
  const send = async (to: string, text: string, idempotencyKey?: string) => {
    identity ??= inkbox.getIdentity(handle).catch((err: unknown) => {
      identity = undefined;
      throw err;
    });
    const sent = await (await identity).sendText({ to, text, idempotencyKey });
    return { id: sent.id };
  };
  return {
    sendOffer: (to, offer) => send(to, offerText(offer), `offer:${offer.task_id}:${to}`),
    sendCaptureLink: (to, msg) => send(to, captureLinkText(msg), `capture:${msg.task_id}:${to}`),
    sendAlreadyClaimed: (to, msg) => send(to, alreadyClaimedText(msg)),
    sendPaid: (to, msg) => send(to, paidText(msg), `paid:${msg.task_id}:${to}`),
    sendText: (to, body) => send(to, body),
  };
}

const sameSecret = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

function authentic(raw: string, headers: Record<string, string>, env: Env, now: Date): boolean {
  const key = env.INKBOX_WEBHOOK_SIGNING_KEY;
  const token = env.INKBOX_WEBHOOK_AUTH_TOKEN;
  if (!key) return false;
  if (token && !sameSecret(headers.authorization ?? "", `Bearer ${token}`)) return false;
  if (!(Math.abs(now.getTime() / 1000 - Number(headers["x-inkbox-timestamp"])) <= SIGNATURE_TOLERANCE_S)) {
    return false;
  }
  try {
    return verifyWebhook({ payload: raw, headers, secret: key });
  } catch {
    return false;
  }
}

function inboundReply(
  evt: TextWebhookPayload | IMessageWebhookPayload,
): { phone: string; text: string } | null {
  if (evt.event_type === "text.received") {
    const m = evt.data.text_message;
    return { phone: m.remote_phone_number ?? "", text: m.text ?? "" };
  }
  if (evt.event_type === "imessage.received" && evt.data.message && !evt.data.message.is_group) {
    const m = evt.data.message;
    return { phone: m.remote_number ?? "", text: m.content ?? "" };
  }
  return null;
}

export function inkboxRoutes(deps: RouteDeps, env: Env): Hono {
  return new Hono().post("/", async (c) => {
    const raw = await c.req.text();
    if (!authentic(raw, c.req.header(), env, deps.providers.clock.now())) {
      return c.text("invalid signature", 401);
    }
    const evt = JSON.parse(raw) as TextWebhookPayload | IMessageWebhookPayload;
    const reply = inboundReply(evt);
    if (!reply) return c.text("ignored");
    if (!E164.test(reply.phone)) {
      console.warn(`inkbox: ignored ${evt.event_type} ${evt.id} from a non-E.164 sender`);
      return c.text("ignored");
    }
    try {
      const intent = parseReplyIntent(reply.text);
      await deps.service.handleWorkerReply({ phone: reply.phone, intent, text: reply.text });
    } catch (err) {
      const detail = scrub(err instanceof Error ? err.message : String(err));
      console.error(`inkbox: reply from ...${reply.phone.slice(-4)} (${evt.id}) failed: ${detail}`);
    }
    return c.text("ok");
  });
}
