import { createHmac } from "node:crypto";
import { AppConfig, type EyesService, fakeProviders, type OfferMessage } from "@eyes/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  alreadyClaimedText,
  captureLinkText,
  inkboxRoutes,
  offerText,
  paidText,
  parseReplyIntent,
} from "./index.ts";

const KEY = "test-signing-key";
const NOW = new Date("2026-10-17T19:00:00.000Z");
const URLISH = /https?:|www\.|[a-z0-9-]\.[a-z]{2,}|@/i;
const PHONEISH = /\d[\d\s().-]{5,}\d/;

const textReceived = (text: string) => ({
  event_type: "text.received",
  timestamp: "2026-04-10T18:24:17.038Z",
  data: {
    text_message: {
      id: "7b3c6e3d-5c20-41ee-8cde-9b1ad1d4e9c0",
      direction: "inbound",
      local_phone_number: "+14155550100",
      remote_phone_number: "+14155550999",
      text,
      type: "sms",
      media: null,
      is_read: false,
      delivery_status: null,
      origin: "user_initiated",
      error_code: null,
      error_detail: null,
      sent_at: null,
      delivered_at: null,
      failed_at: null,
      conversation_id: "82cf24f6-78fe-48da-a673-6a75b4f4a819",
      sender_phone_number: "+14155550999",
      recipients: null,
      created_at: "2026-04-10T18:24:16.912Z",
      updated_at: "2026-04-10T18:24:16.912Z",
    },
    contacts: [{ id: "550e8400-e29b-41d4-a716-446655440000", name: "Jane Doe" }],
    agent_identities: [],
    recipient_phone_number: null,
  },
});

const imessageReceived = (content: string, is_group = false) => ({
  id: "evt_1a90e8b0-0e1e-485f-b316-28f7dfa96afd",
  event_type: "imessage.received",
  timestamp: "2026-06-09T14:30:00Z",
  data: {
    message: {
      id: "1a90e8b0-0e1e-485f-b316-28f7dfa96afd",
      conversation_id: "82cf24f6-78fe-48da-a673-6a75b4f4a819",
      direction: "inbound",
      remote_number: "+15555550123",
      sender_number: is_group ? "+15555550123" : null,
      is_group,
      content,
      message_type: "message",
      service: "imessage",
      status: "received",
      created_at: "2026-06-09T14:30:00Z",
      updated_at: "2026-06-09T14:30:00Z",
    },
    reaction: null,
    contacts: [],
    agent_identities: [],
  },
});

function signedHeaders(body: string, opts: { key?: string; at?: Date; id?: string } = {}) {
  const id = opts.id ?? "req_123";
  const ts = String(Math.floor((opts.at ?? NOW).getTime() / 1000));
  const hex = createHmac("sha256", opts.key ?? KEY)
    .update(`${id}.${ts}.${body}`)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-inkbox-request-id": id,
    "x-inkbox-timestamp": ts,
    "x-inkbox-signature": `sha256=${hex}`,
  } as Record<string, string>;
}

function setup(env: Record<string, string> = {}) {
  const handleWorkerReply = vi.fn(async () => {});
  const providers = fakeProviders();
  providers.clock.set(NOW);
  const config = AppConfig.parse({
    public_api_url: "https://api.eyes.test",
    worker_web_url: "https://w.eyes.test",
    link_secret: "0123456789abcdef",
  });
  const service = { handleWorkerReply } as unknown as EyesService;
  const app = inkboxRoutes({ service, providers, config }, { INKBOX_WEBHOOK_SIGNING_KEY: KEY, ...env });
  const post = (body: string, headers: Record<string, string>) =>
    app.request("/", { method: "POST", body, headers });
  return { app, post, handleWorkerReply };
}

afterEach(() => vi.restoreAllMocks());

describe("inkbox webhook", () => {
  it("passes a signed text.received reply to the service with the parsed intent", async () => {
    const { post, handleWorkerReply } = setup();
    const body = JSON.stringify(textReceived("Yes!"));
    const res = await post(body, signedHeaders(body));
    expect(res.status).toBe(200);
    expect(handleWorkerReply).toHaveBeenCalledWith({ phone: "+14155550999", intent: "yes", text: "Yes!" });
  });

  it("passes a signed 1:1 imessage.received reply to the service", async () => {
    const { post, handleWorkerReply } = setup();
    const body = JSON.stringify(imessageReceived("STOP"));
    const res = await post(body, signedHeaders(body));
    expect(res.status).toBe(200);
    expect(handleWorkerReply).toHaveBeenCalledWith({ phone: "+15555550123", intent: "stop", text: "STOP" });
  });

  const rejects: [string, (b: string) => { body: string; headers: Record<string, string> }][] = [
    ["wrong key", (b: string) => ({ body: b, headers: signedHeaders(b, { key: "other-key" }) })],
    ["tampered body", (b: string) => ({ body: b.replace("YES", "NO"), headers: signedHeaders(b) })],
    [
      "stale timestamp",
      (b: string) => ({ body: b, headers: signedHeaders(b, { at: new Date(NOW.getTime() - 301_000) }) }),
    ],
    [
      "future timestamp",
      (b: string) => ({ body: b, headers: signedHeaders(b, { at: new Date(NOW.getTime() + 301_000) }) }),
    ],
    [
      "truncated signature",
      (b: string) => ({ body: b, headers: { ...signedHeaders(b), "x-inkbox-signature": "sha256=ab" } }),
    ],
    ...["x-inkbox-signature", "x-inkbox-timestamp", "x-inkbox-request-id"].map(
      (h) =>
        [
          `missing ${h}`,
          (b: string) => {
            const headers = signedHeaders(b);
            delete headers[h];
            return { body: b, headers };
          },
        ] as [string, (b: string) => { body: string; headers: Record<string, string> }],
    ),
  ];
  it.each(rejects)("rejects %s with 401 and never calls the service", async (_, make) => {
    const { post, handleWorkerReply } = setup();
    const { body, headers } = make(JSON.stringify(textReceived("YES")));
    const res = await post(body, headers);
    expect(res.status).toBe(401);
    expect(handleWorkerReply).not.toHaveBeenCalled();
  });

  it("rejects everything when no signing key is configured", async () => {
    const { post, handleWorkerReply } = setup({ INKBOX_WEBHOOK_SIGNING_KEY: "" });
    const body = JSON.stringify(textReceived("YES"));
    expect((await post(body, signedHeaders(body))).status).toBe(401);
    expect(handleWorkerReply).not.toHaveBeenCalled();
  });

  it("enforces the bearer token when one is configured", async () => {
    const { post, handleWorkerReply } = setup({ INKBOX_WEBHOOK_AUTH_TOKEN: "tok_abc" });
    const body = JSON.stringify(textReceived("YES"));
    expect((await post(body, signedHeaders(body))).status).toBe(401);
    expect((await post(body, { ...signedHeaders(body), authorization: "Bearer nope" })).status).toBe(401);
    expect(handleWorkerReply).not.toHaveBeenCalled();
    expect((await post(body, { ...signedHeaders(body), authorization: "Bearer tok_abc" })).status).toBe(200);
    expect(handleWorkerReply).toHaveBeenCalledOnce();
  });

  it.each([
    ["text.delivered", { ...textReceived("YES"), event_type: "text.delivered" }],
    ["imessage.reaction_received", { ...imessageReceived("YES"), event_type: "imessage.reaction_received" }],
    ["group imessage", imessageReceived("YES", true)],
    [
      "call.ended",
      { id: "evt_1", event_type: "call.ended", timestamp: "2026-07-06T18:32:11.402Z", data: {} },
    ],
  ])("ignores %s with 200", async (_, payload) => {
    const { post, handleWorkerReply } = setup();
    const body = JSON.stringify(payload);
    const res = await post(body, signedHeaders(body));
    expect(res.status).toBe(200);
    expect(handleWorkerReply).not.toHaveBeenCalled();
  });

  it("answers 200 when the service fails and logs neither the full phone nor the body", async () => {
    const { post, handleWorkerReply } = setup();
    handleWorkerReply.mockRejectedValueOnce(new Error("claim failed for +14155550999"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = JSON.stringify(textReceived("yes secret body"));
    const res = await post(body, signedHeaders(body));
    expect(res.status).toBe(200);
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).not.toContain("4155550999");
    expect(line).not.toContain("secret body");
  });
});

const offer = (o: Partial<OfferMessage> = {}): OfferMessage => ({
  task_id: "00000000-0000-4000-8000-000000000001",
  question: "Is the line under 10 people?",
  place_label: "Blue Bottle Coffee, Mint Plaza, San Francisco",
  bounty_cents: 300,
  distance_m: 640,
  deadline_at: "2026-10-17T19:30:00.000Z",
  ...o,
});

describe("offer template", () => {
  it("carries bounty, distance, place, question and the claim instruction", () => {
    expect(offerText(offer())).toBe(
      "Eyes: $3 task, 0.4 mi away. Blue Bottle Coffee, Mint Plaza, San Francisco: Is the line under 10 people? Reply YES to claim.",
    );
  });

  it.each([
    ["long question", offer({ question: "Is the oat milk in stock and how many cartons? ".repeat(20) })],
    ["long place", offer({ place_label: "The Very Long Named Neighborhood Market And Deli ".repeat(10) })],
    ["both long", offer({ question: "q".repeat(500), place_label: "p".repeat(500), bounty_cents: 4999 })],
    ["emoji question", offer({ question: "🧑‍🤝‍🧑🍩".repeat(80) })],
    [
      "links and phones",
      offer({
        question:
          "Call (415) 555-0123 or +1 415.555.0199, see https://x.co/a, www.shop.com, shop.com/menu, a@b.io",
        place_label: "Joe's, 4155550123, joes.example.com",
      }),
    ],
  ])("stays within 159 chars with no link or phone number (%s)", (_, o) => {
    const text = offerText(o);
    expect(text.length).toBeLessThanOrEqual(159);
    expect(text).toMatch(/Reply YES to claim\.$/);
    expect(text).toContain(o.bounty_cents === 300 ? "$3 " : "$49.99 ");
    expect(text).not.toMatch(URLISH);
    expect(text).not.toMatch(PHONEISH);
    expect(text).not.toMatch(/\p{Cs}/u);
  });
});

describe("post-reply templates", () => {
  it("capture link has the url, place, local deadline and the no-faces rule", () => {
    const text = captureLinkText({
      task_id: "t",
      place_label: "Ferry Building, San Francisco",
      capture_url: "https://w.eyes.test/c/abc",
      deadline_at: "2026-10-17T19:30:00.000Z",
    });
    expect(text).toContain("https://w.eyes.test/c/abc");
    expect(text).toContain("Ferry Building, San Francisco");
    expect(text).toContain("12:30 PM PDT");
    expect(text).toMatch(/faces/);
  });

  it("paid and already-claimed texts name the place and the dollar amount", () => {
    expect(paidText({ task_id: "t", place_label: "Ferry Building", amount_cents: 350 })).toContain("$3.50");
    expect(paidText({ task_id: "t", place_label: "Ferry Building", amount_cents: 300 })).toContain("$3 ");
    expect(alreadyClaimedText({ place_label: "Ferry Building" })).toContain("Ferry Building");
  });
});

describe("parseReplyIntent", () => {
  it.each([
    ["YES", "yes"],
    [" yes! ", "yes"],
    ["Y", "yes"],
    ["yep.", "yes"],
    ["Yeah", "yes"],
    ["ok", "yes"],
    ["Claim", "yes"],
    ["👍", "yes"],
    ["👍🏽", "yes"],
    ["yes?", "yes"],
    ["no", "no"],
    ["N", "no"],
    ["pass.", "no"],
    ["STOP", "stop"],
    ["Unsubscribe", "stop"],
    ["cancel", "stop"],
    ["END", "stop"],
    ["quit!", "stop"],
    ["START", "start"],
    ["unstop", "start"],
    ["HELP", "help"],
    ["info", "help"],
    ["?", "help"],
    ["??", "help"],
    ["", "unknown"],
    ["no way, yes", "unknown"],
    ["maybe later", "unknown"],
    ["yes please", "unknown"],
  ])("%j -> %s", (text, intent) => {
    expect(parseReplyIntent(text)).toBe(intent);
  });
});
