import { createHash, timingSafeEqual } from "node:crypto";
import {
  EyesError,
  type Messaging,
  type OfferMessage,
  type ReplyIntent,
  type RouteDeps,
  type TaskType,
} from "@eyes/core";
import { type AgentIdentity, Inkbox, verifyWebhook } from "@inkbox/sdk";
import { Hono } from "hono";

export type Env = Record<string, string | undefined>;

const SIGNATURE_TOLERANCE_S = 300;
const TIME_ZONE = "America/Los_Angeles";
const E164 = /^\+[1-9]\d{6,14}$/;
const PLACE_MAX_CHARS = 40;
const PLACE_TOKEN = /^[\p{L}\p{M}\p{Nd}'’&-]+$/u;

const TASK_PHRASES: Record<TaskType, string> = {
  is_open: "check if it's open",
  line_length: "check how long the line is",
  in_stock: "check if something is in stock",
  photo_of_place: "take a photo",
  price_check: "check a price",
  crowd_level: "check how crowded it is",
  other_public: "do a quick check",
};

const dollars = (cents: number) => `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;
const miles = (meters: number) => `${Math.max(0.1, meters / 1609.344).toFixed(1)} mi`;
const digitCount = (s: string) => s.match(/\p{Nd}/gu)?.length ?? 0;

const localTime = (iso: string) =>
  new Date(iso)
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: TIME_ZONE,
      timeZoneName: "short",
    })
    .replace(/\s/g, " ");

function placeText(label: string): string {
  const head =
    label
      .normalize("NFKC")
      .replace(/\p{Cf}/gu, "")
      .split(",")[0] ?? "";
  let tokens = head.split(/\s+/).filter((t) => PLACE_TOKEN.test(t) && !/\p{Nd}{3}/u.test(t));
  if (digitCount(tokens.join("")) > 4) tokens = tokens.filter((t) => digitCount(t) === 0);
  let out = "";
  for (const token of tokens) {
    const next = out ? `${out} ${token}` : token;
    if (next.length > PLACE_MAX_CHARS) break;
    out = next;
  }
  return out || "a nearby place";
}

export function offerText(offer: OfferMessage): string {
  return `Eyes: ${dollars(offer.bounty_cents)} to ${TASK_PHRASES[offer.task_type]} at ${placeText(offer.place_label)}, ${miles(offer.distance_m)} away. Reply YES to claim.`;
}

export function captureLinkText(msg: Parameters<Messaging["sendCaptureLink"]>[1]): string {
  return `Eyes: it's yours! Take the photo at ${placeText(msg.place_label)} by ${localTime(msg.deadline_at)}. Never photograph people's faces. Open: ${msg.capture_url}`;
}

export function alreadyClaimedText(msg: Parameters<Messaging["sendAlreadyClaimed"]>[1]): string {
  return `Eyes: the task at ${placeText(msg.place_label)} was already claimed by someone else. Thanks for replying, watch for the next one.`;
}

export function paidText(msg: Parameters<Messaging["sendPaid"]>[1]): string {
  return `Eyes: you've been paid ${dollars(msg.amount_cents)} for the task at ${placeText(msg.place_label)}. Thank you!`;
}

const YES = new Set(["yes", "y", "yep", "yup", "yeah", "yea", "ok", "okay", "sure", "claim", "👍"]);

const INTENTS: Record<string, ReplyIntent> = {
  no: "no",
  n: "no",
  nope: "no",
  nah: "no",
  pass: "no",
  stop: "stop",
  stopall: "stop",
  unsubscribe: "stop",
  cancel: "stop",
  end: "stop",
  quit: "stop",
  revoke: "stop",
  optout: "stop",
  "opt out": "stop",
  "stop texting me": "stop",
  start: "start",
  unstop: "start",
  help: "help",
  info: "help",
};

export function parseReplyIntent(text: string): ReplyIntent {
  const tokens =
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+|👍|\?/gu) ?? [];
  const words = tokens.filter((t) => t !== "?");
  const asked = words.length < tokens.length;
  if (words.length === 0) return asked ? "help" : "unknown";
  const intent = words.every((w) => YES.has(w)) ? "yes" : (INTENTS[words.join(" ")] ?? "unknown");
  return asked && intent !== "stop" && intent !== "help" ? "unknown" : intent;
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

function authentic(raw: Buffer, headers: Record<string, string>, env: Env, now: Date): boolean {
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

type Fields = Record<string, unknown> | null | undefined;
type Received = {
  id?: unknown;
  event_type?: unknown;
  data?: { text_message?: Fields; message?: Fields } | null;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

function inboundReply(body: string): { id: string; phone: string; text: string } | null {
  let evt: Received | null;
  try {
    evt = JSON.parse(body) as Received | null;
  } catch {
    return null;
  }
  const sms = evt?.event_type === "text.received" ? evt.data?.text_message : null;
  const imessage = evt?.event_type === "imessage.received" ? evt.data?.message : null;
  if (sms) {
    return { id: str(evt?.id) || str(sms.id), phone: str(sms.remote_phone_number), text: str(sms.text) };
  }
  if (imessage && !imessage.is_group) {
    return {
      id: str(evt?.id) || str(imessage.id),
      phone: str(imessage.remote_number),
      text: str(imessage.content),
    };
  }
  return null;
}

export function inkboxRoutes(deps: RouteDeps, env: Env): Hono {
  return new Hono().post("/", async (c) => {
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (!authentic(raw, c.req.header(), env, deps.providers.clock.now())) {
      return c.text("invalid signature", 401);
    }
    const reply = inboundReply(raw.toString("utf8"));
    if (!reply) return c.text("ignored");
    if (!E164.test(reply.phone)) {
      console.warn(`inkbox: ignored reply ${reply.id}: sender is not an E.164 phone`);
      return c.text("ignored");
    }
    try {
      const intent = parseReplyIntent(reply.text);
      await deps.service.handleWorkerReply({ phone: reply.phone, intent, text: reply.text });
    } catch (err) {
      const kind =
        err instanceof EyesError ? `${err.name} ${err.code}` : err instanceof Error ? err.name : typeof err;
      console.error(`inkbox: reply ${reply.id} from ...${reply.phone.slice(-4)} failed: ${kind}`);
    }
    return c.text("ok");
  });
}
