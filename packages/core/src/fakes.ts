import type {
  Clock,
  Email,
  Geo,
  Messaging,
  OutboundEmail,
  Payments,
  PaymentsEvent,
  Providers,
  Storage,
  Vision,
  VisionVerdict,
} from "./providers.ts";

export const FAKE_STRIPE_SIGNATURE = "fake-signature";

export const FAKE_PLACES: Record<string, { lat: number; lng: number; label: string }> = {
  "blue bottle coffee, mint plaza, san francisco": {
    lat: 37.78246,
    lng: -122.40776,
    label: "Blue Bottle Coffee, Mint Plaza, San Francisco",
  },
  "ferry building, san francisco": { lat: 37.79554, lng: -122.39377, label: "Ferry Building, San Francisco" },
  "trader joe's, 401 bay st, san francisco": {
    lat: 37.80584,
    lng: -122.41481,
    label: "Trader Joe's, 401 Bay St, San Francisco",
  },
};

type Outbox<T> = T[];

export function fakeMessaging() {
  const outbox: Outbox<{ to: string; kind: string; payload: unknown }> = [];
  const record = async (to: string, kind: string, payload: unknown) => {
    outbox.push({ to, kind, payload });
    return { id: `msg_${outbox.length}` };
  };
  const messaging: Messaging = {
    sendOffer: (to, offer) => record(to, "offer", offer),
    sendCaptureLink: (to, msg) => record(to, "capture_link", msg),
    sendAlreadyClaimed: (to, msg) => record(to, "already_claimed", msg),
    sendPaid: (to, msg) => record(to, "paid", msg),
    sendText: (to, body) => record(to, "text", body),
  };
  return Object.assign(messaging, { outbox });
}

export function fakeEmail() {
  const outbox: Outbox<OutboundEmail> = [];
  const email: Email = {
    send: async (msg) => {
      outbox.push(msg);
      return { id: `email_${outbox.length}`, message_id: `<fake-${outbox.length}@eyes.test>` };
    },
  };
  return Object.assign(email, { outbox });
}

export function fakePayments() {
  const transfers: { account_id: string; amount_cents: number; task_id: string; idempotency_key: string }[] =
    [];
  const byKey = new Map<string, string>();
  const reversals: { transfer_id: string; amount_cents: number; idempotency_key: string }[] = [];
  let reversalError: string | null = null;
  let seq = 0;
  const payments: Payments = {
    createTopupCheckout: async (i) => {
      seq += 1;
      const done = new URL(i.success_url);
      done.searchParams.set("simulated", "1");
      return { url: done.href, session_id: `cs_fake_${seq}` };
    },
    createWorkerAccount: async (i) => ({ account_id: `acct_fake_${i.worker_id}` }),
    createOnboardingLink: async (i) => ({ url: `https://connect.fake.test/onboard/${i.account_id}` }),
    payoutWorker: async (i) => {
      const existing = byKey.get(i.idempotency_key);
      if (existing) return { transfer_id: existing };
      transfers.push(i);
      const transfer_id = `tr_fake_${transfers.length}_${crypto.randomUUID()}`;
      byKey.set(i.idempotency_key, transfer_id);
      return { transfer_id };
    },
    reverseTransfer: async (i) => {
      if (reversalError) throw Object.assign(new Error(reversalError), { code: reversalError });
      const at = reversals.findIndex((r) => r.idempotency_key === i.idempotency_key);
      if (at < 0) reversals.push(i);
      return { reversal_id: `trr_fake_${at < 0 ? reversals.length : at + 1}` };
    },
    parseWebhook: async (rawBody, signature) => {
      if (signature !== FAKE_STRIPE_SIGNATURE) throw new Error("invalid webhook signature");
      return JSON.parse(rawBody) as PaymentsEvent;
    },
  };
  return Object.assign(payments, {
    transfers,
    reversals,
    // Make the next reversals fail with this Stripe error code (null: succeed).
    failReversals: (code: string | null) => {
      reversalError = code;
    },
  });
}

export function fakeStorage() {
  const objects = new Map<string, { bytes: Uint8Array; content_type: string }>();
  const storage: Storage = {
    putPhoto: async (i) => {
      objects.set(i.key, { bytes: i.bytes, content_type: i.content_type });
      return { url: `https://storage.fake.test/photos/${i.key}` };
    },
    deletePhoto: async (i) => {
      objects.delete(i.key);
    },
  };
  return Object.assign(storage, { objects });
}

export function fakeVision(initial: Partial<VisionVerdict> = {}) {
  let verdict: VisionVerdict = {
    allowed: true,
    reason: "The photo is safe to share.",
    prominent_faces: false,
    confidence: 0.9,
    ...initial,
  };
  const calls: unknown[] = [];
  const vision: Vision = {
    judge: async (i) => {
      calls.push(i);
      return verdict;
    },
  };
  return Object.assign(vision, {
    calls,
    setVerdict: (v: Partial<VisionVerdict>) => {
      verdict = { ...verdict, ...v };
    },
  });
}

export function fakeGeo(extra: Record<string, { lat: number; lng: number; label: string }> = {}): Geo {
  const places = { ...FAKE_PLACES, ...extra };
  return {
    geocode: async (query) => {
      const coords = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (coords) return { lat: Number(coords[1]), lng: Number(coords[2]), label: query.trim() };
      return places[query.trim().toLowerCase()] ?? null;
    },
  };
}

export function fakeClock(start = new Date("2026-10-17T19:00:00.000Z")) {
  let current = start.getTime();
  const clock: Clock = { now: () => new Date(current) };
  return Object.assign(clock, {
    set: (d: Date) => {
      current = d.getTime();
    },
    advance: (ms: number) => {
      current += ms;
    },
  });
}

export function fakeProviders() {
  return {
    messaging: fakeMessaging(),
    email: fakeEmail(),
    payments: fakePayments(),
    storage: fakeStorage(),
    vision: fakeVision(),
    geo: fakeGeo(),
    clock: fakeClock(),
  } satisfies Providers;
}
export type FakeProviders = ReturnType<typeof fakeProviders>;
