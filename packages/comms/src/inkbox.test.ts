import { createHmac } from "node:crypto";
import {
  AppConfig,
  EyesError,
  type EyesService,
  fakeProviders,
  type OfferMessage,
  TASK_TYPES,
} from "@eyes/core";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
  alreadyClaimedText,
  captureLinkText,
  createInkboxMessaging,
  inkboxRoutes,
  offerText,
  paidText,
  parseReplyIntent,
} from "./index.ts";

const sdk = vi.hoisted(() => ({ created: vi.fn(), getIdentity: vi.fn(), sendText: vi.fn() }));

vi.mock("@inkbox/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@inkbox/sdk")>()),
  Inkbox: class {
    constructor(options: unknown) {
      sdk.created(options);
    }
    getIdentity = sdk.getIdentity;
  },
}));

const KEY = "test-signing-key";
const NOW = new Date("2026-10-17T19:00:00.000Z");
const TO = "+14155550123";

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

const imessageReceived = (content: string, from = "+15555550123", is_group = false) => ({
  id: "evt_1a90e8b0-0e1e-485f-b316-28f7dfa96afd",
  event_type: "imessage.received",
  timestamp: "2026-06-09T14:30:00Z",
  data: {
    message: {
      id: "1a90e8b0-0e1e-485f-b316-28f7dfa96afd",
      conversation_id: "82cf24f6-78fe-48da-a673-6a75b4f4a819",
      direction: "inbound",
      remote_number: from,
      sender_number: is_group ? from : null,
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

function signedHeaders(body: string | Buffer, opts: { key?: string; at?: Date } = {}) {
  const id = "req_123";
  const ts = String(Math.floor((opts.at ?? NOW).getTime() / 1000));
  const hex = createHmac("sha256", opts.key ?? KEY)
    .update(Buffer.concat([Buffer.from(`${id}.${ts}.`), Buffer.from(body)]))
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-inkbox-request-id": id,
    "x-inkbox-timestamp": ts,
    "x-inkbox-signature": `sha256=${hex}`,
  } as Record<string, string>;
}

function setup(env: Record<string, string> = {}) {
  const handleWorkerReply = vi.fn(async (_: unknown) => {});
  const providers = fakeProviders();
  providers.clock.set(NOW);
  const config = AppConfig.parse({
    public_api_url: "https://api.eyes.test",
    worker_web_url: "https://w.eyes.test",
    link_secret: "0123456789abcdef",
  });
  const service = { handleWorkerReply } as unknown as EyesService;
  const app = inkboxRoutes({ service, providers, config }, { INKBOX_WEBHOOK_SIGNING_KEY: KEY, ...env });
  const post = (body: string | Buffer, headers: Record<string, string>) =>
    app.request("/", { method: "POST", body: new Uint8Array(Buffer.from(body)), headers });
  return { post, handleWorkerReply };
}

const offer = (o: Partial<OfferMessage> = {}): OfferMessage => ({
  task_id: "00000000-0000-4000-8000-000000000001",
  task_type: "line_length",
  question: "Is the line under 10 people?",
  place_label: "Blue Bottle Coffee, Mint Plaza, San Francisco",
  bounty_cents: 300,
  distance_m: 640,
  deadline_at: "2026-10-17T19:30:00.000Z",
  ...o,
});

describe("inkbox webhook", () => {
  let warn: MockInstance<typeof console.warn>;
  let error: MockInstance<typeof console.error>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    return () => vi.restoreAllMocks();
  });

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

  it("verifies the signature over the exact raw bytes, not re-encoded text", async () => {
    const { post, handleWorkerReply } = setup();
    const [before, after] = JSON.stringify(textReceived("XX")).split("XX");
    const body = Buffer.concat([Buffer.from(`${before}caf`), Buffer.from([0xe9]), Buffer.from(`${after}`)]);
    const res = await post(body, signedHeaders(body));
    expect(res.status).toBe(200);
    expect(handleWorkerReply).toHaveBeenCalledOnce();
  });

  const rejects: [string, (b: string) => { body: string; headers: Record<string, string> }][] = [
    ["wrong key", (b) => ({ body: b, headers: signedHeaders(b, { key: "other-key" }) })],
    ["tampered body", (b) => ({ body: b.replace("YES", "NO"), headers: signedHeaders(b) })],
    [
      "stale timestamp",
      (b) => ({ body: b, headers: signedHeaders(b, { at: new Date(NOW.getTime() - 301_000) }) }),
    ],
    [
      "future timestamp",
      (b) => ({ body: b, headers: signedHeaders(b, { at: new Date(NOW.getTime() + 301_000) }) }),
    ],
    [
      "truncated signature",
      (b) => ({ body: b, headers: { ...signedHeaders(b), "x-inkbox-signature": "sha256=ab" } }),
    ],
    ...["x-inkbox-signature", "x-inkbox-timestamp", "x-inkbox-request-id"].map(
      (h): [string, (b: string) => { body: string; headers: Record<string, string> }] => [
        `missing ${h}`,
        (b) => {
          const headers = signedHeaders(b);
          delete headers[h];
          return { body: b, headers };
        },
      ],
    ),
  ];
  it.each(rejects)("rejects %s with 401 and never calls the service", async (_, make) => {
    const { post, handleWorkerReply } = setup();
    const { body, headers } = make(JSON.stringify(textReceived("YES")));
    const res = await post(body, headers);
    expect(res.status).toBe(401);
    expect(handleWorkerReply).not.toHaveBeenCalled();
  });

  it("rejects everything when no signing key is configured, even a request signed with an empty key", async () => {
    const { post, handleWorkerReply } = setup({ INKBOX_WEBHOOK_SIGNING_KEY: "" });
    const body = JSON.stringify(textReceived("YES"));
    expect((await post(body, signedHeaders(body, { key: "" }))).status).toBe(401);
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
    ["text.delivered", JSON.stringify({ ...textReceived("YES"), event_type: "text.delivered" })],
    [
      "imessage.reaction_received",
      JSON.stringify({ ...imessageReceived("YES"), event_type: "imessage.reaction_received" }),
    ],
    ["group imessage", JSON.stringify(imessageReceived("YES", "+15555550123", true))],
    ["call.ended", JSON.stringify({ id: "evt_1", event_type: "call.ended", data: {} })],
    ["non-E.164 sender", JSON.stringify(imessageReceived("YES secret", "sender@example.com"))],
    ["non-JSON body", '{"event_type":"text.received", YES secret'],
    ["empty body", ""],
    ["null body", "null"],
    ["text.received without data", JSON.stringify({ event_type: "text.received" })],
    ["text_message null", JSON.stringify({ event_type: "text.received", data: { text_message: null } })],
    ["imessage.received without data", JSON.stringify({ event_type: "imessage.received" })],
  ])("ignores %s with 200 and logs no body", async (_, body) => {
    const { post, handleWorkerReply } = setup();
    const res = await post(body, signedHeaders(body));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(handleWorkerReply).not.toHaveBeenCalled();
    const logged = [...warn.mock.calls, ...error.mock.calls].join(" ");
    expect(logged).not.toMatch(/secret|sender@/);
  });

  it("answers 200 when the service fails and logs only the error kind, event id and last 4 digits", async () => {
    const { post, handleWorkerReply } = setup();
    handleWorkerReply.mockRejectedValueOnce(new Error("claim failed for +14155550999: yes secret body"));
    handleWorkerReply.mockRejectedValueOnce(new EyesError("internal_error"));
    const body = JSON.stringify(textReceived("yes secret body"));
    expect((await post(body, signedHeaders(body))).status).toBe(200);
    expect((await post(body, signedHeaders(body))).status).toBe(200);
    const [first, second] = error.mock.calls.map((call) => String(call[0]));
    expect(first).toContain("7b3c6e3d-5c20-41ee-8cde-9b1ad1d4e9c0");
    expect(first).toContain("0999");
    expect(first).not.toMatch(/4155550999|secret|claim failed/);
    expect(second).toContain("internal_error");
  });
});

describe("createInkboxMessaging", () => {
  const env = { INKBOX_API_KEY: "key_test", INKBOX_AGENT_HANDLE: "eyes-dispatch" };
  beforeEach(() => {
    sdk.created.mockReset();
    sdk.sendText.mockReset().mockResolvedValue({ id: "txt_1", deliveryStatus: "queued" });
    sdk.getIdentity.mockReset().mockResolvedValue({ sendText: sdk.sendText });
  });

  it("refuses to start without an API key or an agent handle", () => {
    expect(() => createInkboxMessaging({ INKBOX_AGENT_HANDLE: "eyes-dispatch" })).toThrow(/INKBOX_API_KEY/);
    expect(() => createInkboxMessaging({ INKBOX_API_KEY: "key_test" })).toThrow(/INKBOX_AGENT_HANDLE/);
    expect(sdk.created).not.toHaveBeenCalled();
  });

  it("sends each template through the agent identity with its idempotency key", async () => {
    const m = createInkboxMessaging(env);
    const capture = {
      task_id: "t1",
      place_label: "Ferry Building",
      capture_url: "https://w.eyes.test/c/x",
      deadline_at: "2026-10-17T19:30:00.000Z",
    };
    const paid = { task_id: "t1", place_label: "Ferry Building", amount_cents: 300 };
    expect(await m.sendOffer(TO, offer())).toEqual({ id: "txt_1" });
    expect(await m.sendCaptureLink(TO, capture)).toEqual({ id: "txt_1" });
    expect(await m.sendAlreadyClaimed(TO, { place_label: "Ferry Building" })).toEqual({ id: "txt_1" });
    expect(await m.sendPaid(TO, paid)).toEqual({ id: "txt_1" });
    expect(await m.sendText(TO, "raw body")).toEqual({ id: "txt_1" });
    expect(sdk.created).toHaveBeenCalledWith({ apiKey: "key_test" });
    expect(sdk.getIdentity).toHaveBeenCalledWith("eyes-dispatch");
    expect(sdk.sendText.mock.calls.map(([options]) => options)).toEqual([
      { to: TO, text: offerText(offer()), idempotencyKey: `offer:${offer().task_id}:${TO}` },
      { to: TO, text: captureLinkText(capture), idempotencyKey: `capture:t1:${TO}` },
      { to: TO, text: alreadyClaimedText({ place_label: "Ferry Building" }), idempotencyKey: undefined },
      { to: TO, text: paidText(paid), idempotencyKey: `paid:t1:${TO}` },
      { to: TO, text: "raw body", idempotencyKey: undefined },
    ]);
  });

  it("fetches the identity once for concurrent sends", async () => {
    const m = createInkboxMessaging(env);
    await Promise.all([m.sendText(TO, "a"), m.sendText(TO, "b"), m.sendText(TO, "c")]);
    expect(sdk.getIdentity).toHaveBeenCalledOnce();
    expect(sdk.sendText).toHaveBeenCalledTimes(3);
  });

  it("refetches the identity after a failed fetch", async () => {
    const m = createInkboxMessaging(env);
    sdk.getIdentity.mockRejectedValueOnce(new Error("identity lookup failed"));
    await expect(m.sendText(TO, "a")).rejects.toThrow("identity lookup failed");
    await expect(m.sendText(TO, "b")).resolves.toEqual({ id: "txt_1" });
    expect(sdk.getIdentity).toHaveBeenCalledTimes(2);
  });

  it("propagates SDK send errors", async () => {
    const err = new Error("403 recipient_not_opted_in");
    sdk.sendText.mockRejectedValueOnce(err);
    await expect(createInkboxMessaging(env).sendText(TO, "a")).rejects.toBe(err);
  });
});

describe("offer template", () => {
  it("describes the task by type, bounty, place and distance", () => {
    expect(offerText(offer())).toBe(
      "Eyes: $3 to check how long the line is at Blue Bottle Coffee, 0.4 mi away. Reply YES to claim.",
    );
    expect(offerText(offer({ task_type: "is_open", bounty_cents: 450, distance_m: 30 }))).toBe(
      "Eyes: $4.50 to check if it's open at Blue Bottle Coffee, 0.1 mi away. Reply YES to claim.",
    );
  });

  it.each(TASK_TYPES)("never carries the agent's question and stays within 159 chars (%s)", (task_type) => {
    const text = offerText(
      offer({
        task_type,
        question: "Text 4155550199 or visit evil.example now ".repeat(20),
        place_label: "Grand Central Market Food Hall Annex West ".repeat(10),
        bounty_cents: 4999,
        distance_m: 40_000_000,
      }),
    );
    expect(text.length).toBeLessThanOrEqual(159);
    expect(text).not.toMatch(/evil|4155550199|Text/);
    expect(text).toMatch(/^Eyes: \$49\.99 to .+ Reply YES to claim\.$/);
  });
});

describe("place label in every template", () => {
  it.each([
    ["Blue Bottle Coffee, Mint Plaza, San Francisco", "Blue Bottle Coffee"],
    ["Trader Joe's, 401 Bay St, San Francisco", "Trader Joe's"],
    ["Pier 39", "Pier 39"],
    ["Ｐｉｅｒ ３９", "Pier 39"],
    ["Café 🍩 Corner", "Café Corner"],
    ["Visit пример.рф now", "Visit now"],
    ["ｅｘａｍｐｌｅ．ｃｏｍ Deli", "Deli"],
    ["exam\u200Bple.com Deli", "Deli"],
    ["Blue\u200B Bottle\u2060 Coffee", "Blue Bottle Coffee"],
    ["exa\u200Bmple。com", "a nearby place"],
    ["\u202Emoc.elgoog", "a nearby place"],
    ["Call 415/555/0199", "Call"],
    ["Call 415 555 0199", "Call"],
    ["1-800-FLOWERS", "a nearby place"],
    ["Joe 41 55 55 01 99", "Joe"],
    ["Joe 41-55-55-01-99", "Joe"],
    ["Store ٤١٥٥٥٥٠١٩٩", "Store"],
    ["Cafe 10.0.0.1", "Cafe"],
    ["Shop http://evil", "Shop"],
    ["Mail a@b.io", "Mail"],
    ["Back\\slash Bar", "Bar"],
    ["", "a nearby place"],
    ["Grand ".repeat(30), "Grand Grand Grand Grand Grand Grand"],
  ])("%j -> %j", (place_label, expected) => {
    const texts = [
      offerText(offer({ place_label })),
      captureLinkText({
        task_id: "t",
        place_label,
        capture_url: "https://w.eyes.test/c/x",
        deadline_at: NOW.toISOString(),
      }),
      alreadyClaimedText({ place_label }),
      paidText({ task_id: "t", place_label, amount_cents: 300 }),
    ];
    for (const text of texts) expect(text).toContain(` at ${expected}`);
    expect(offerText(offer({ place_label }))).toBe(
      `Eyes: $3 to check how long the line is at ${expected}, 0.4 mi away. Reply YES to claim.`,
    );
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
    expect(text).toBe(
      "Eyes: it's yours! Take the photo at Ferry Building by 12:30 PM PDT. Never photograph people's faces. Open: https://w.eyes.test/c/abc",
    );
  });

  it("paid text shows whole and fractional dollars", () => {
    expect(paidText({ task_id: "t", place_label: "Ferry Building", amount_cents: 350 })).toContain("$3.50 ");
    expect(paidText({ task_id: "t", place_label: "Ferry Building", amount_cents: 300 })).toContain("$3 ");
  });
});

describe("parseReplyIntent", () => {
  it.each([
    ["YES", "yes"],
    [" yes! ", "yes"],
    ["ＹＥＳ", "yes"],
    ["Y", "yes"],
    ["yep.", "yes"],
    ["yup", "yes"],
    ["Yeah", "yes"],
    ["yea", "yes"],
    ["sure", "yes"],
    ["ok", "yes"],
    ["Okay", "yes"],
    ["Claim", "yes"],
    ["👍", "yes"],
    ["👍🏽", "yes"],
    ["👍👍👍", "yes"],
    ["yes 👍", "yes"],
    ["no", "no"],
    ["N", "no"],
    ["nope", "no"],
    ["nah", "no"],
    ["pass.", "no"],
    ["STOP", "stop"],
    ["stop?", "stop"],
    ["STOPALL", "stop"],
    ["Unsubscribe", "stop"],
    ["cancel", "stop"],
    ["END", "stop"],
    ["quit!", "stop"],
    ["revoke", "stop"],
    ["opt out", "stop"],
    ["OPT-OUT", "stop"],
    ["optout", "stop"],
    ["Stop texting me!", "stop"],
    ["START", "start"],
    ["unstop", "start"],
    ["HELP", "help"],
    ["help?", "help"],
    ["info", "help"],
    ["?", "help"],
    ["??", "help"],
    ["", "unknown"],
    ["y?", "unknown"],
    ["yes?", "unknown"],
    ["no way, yes", "unknown"],
    ["maybe later", "unknown"],
    ["yes please", "unknown"],
    ["stop by later", "unknown"],
  ])("%j -> %s", (text, intent) => {
    expect(parseReplyIntent(text)).toBe(intent);
  });
});
