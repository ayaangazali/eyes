import type { TaskType } from "./schemas.ts";

export type SentMessage = { id: string };

export type OfferMessage = {
  task_id: string;
  task_type: TaskType;
  question: string;
  place_label: string;
  bounty_cents: number;
  distance_m: number;
  deadline_at: string;
  live_payouts: boolean;
};

export interface Messaging {
  sendOffer(to: string, offer: OfferMessage): Promise<SentMessage>;
  sendCaptureLink(
    to: string,
    msg: { task_id: string; place_label: string; capture_url: string; deadline_at: string },
  ): Promise<SentMessage>;
  sendAlreadyClaimed(to: string, msg: { place_label: string }): Promise<SentMessage>;
  sendPaid(
    to: string,
    msg: {
      task_id: string;
      place_label: string;
      amount_cents: number;
      me_url: string;
      live_payouts: boolean;
    },
  ): Promise<SentMessage>;
  sendText(to: string, body: string): Promise<SentMessage>;
}

export const REPLY_INTENTS = [
  "yes",
  "no",
  "stop",
  "start",
  "help",
  "here",
  "shortcut",
  "app",
  "install",
  "task",
  "location_share",
  "media",
  "unknown",
] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export type EmailAttachment = { filename: string; content_type: string; url: string };

export type OutboundEmail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  in_reply_to?: string;
  references?: string[];
  attachments?: EmailAttachment[];
  /** Where replies go, e.g. the Primitive inbound address while another provider sends. */
  reply_to?: string;
};

export interface Email {
  send(msg: OutboundEmail): Promise<{ id: string; message_id: string | null }>;
}

export type PaymentsEvent =
  | {
      type: "topup.completed";
      agent_id: string;
      amount_cents: number;
      ref: string;
      payer_email: string | null;
    }
  | { type: "worker.onboarded"; account_id: string };

export interface Payments {
  createTopupCheckout(i: {
    agent_id: string;
    amount_cents: number;
    success_url: string;
    cancel_url: string;
  }): Promise<{ url: string; session_id: string }>;
  createWorkerAccount(i: {
    worker_id: string;
    phone: string;
    email: string | null;
    name: string;
  }): Promise<{ account_id: string }>;
  createOnboardingLink(i: {
    account_id: string;
    refresh_url: string;
    return_url: string;
  }): Promise<{ url: string }>;
  payoutWorker(i: {
    account_id: string;
    amount_cents: number;
    task_id: string;
    idempotency_key: string;
  }): Promise<{ transfer_id: string }>;
  // Reverses a payout transfer (confirmed fraud). Throws when Stripe refuses, e.g. the connected
  // account has no balance left (code balance_insufficient).
  reverseTransfer(i: { transfer_id: string; amount_cents: number; idempotency_key: string }): Promise<{
    reversal_id: string;
  }>;
  parseWebhook(rawBody: string, signature: string | null): Promise<PaymentsEvent | null>;
}

export interface Storage {
  putPhoto(i: { key: string; bytes: Uint8Array; content_type: string }): Promise<{ url: string }>;
  deletePhoto(i: { key: string }): Promise<void>;
  // The bucket is private. signPhoto turns a stored photo URL into a short-lived link (ADR-048);
  // readPhoto returns the object for a valid, unexpired link and null otherwise.
  signPhoto(url: string): string;
  readPhoto(i: { key: string; exp: string; sig: string }): Promise<Response | null>;
}

// Moderation only: the photo is judged on whether it is safe to share, never on whether it
// answers the question (ADR-025).
export type VisionJudgeInput = { photo_url: string };

export type VisionVerdict = {
  allowed: boolean;
  reason: string;
  confidence: number;
};

export interface Vision {
  judge(i: VisionJudgeInput): Promise<VisionVerdict>;
}

export interface Geo {
  geocode(query: string): Promise<{ lat: number; lng: number; label: string } | null>;
}

export interface Clock {
  now(): Date;
}

export type Providers = {
  messaging: Messaging;
  email: Email;
  payments: Payments;
  storage: Storage;
  vision: Vision;
  geo: Geo;
  clock: Clock;
};
