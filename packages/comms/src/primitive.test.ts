import { createHmac } from "node:crypto";
import {
  type Agent,
  type Answer,
  AppConfig,
  agentEmailAddress,
  EyesError,
  type EyesService,
  fakeProviders,
  type OutboundEmail,
  type ToolOutput,
} from "@eyes/core";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createPrimitiveEmail, parseTaskEmail, primitiveRoutes } from "./index.ts";

const sdk = vi.hoisted(() => ({ created: vi.fn(), send: vi.fn() }));

vi.mock("@primitivedotdev/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@primitivedotdev/sdk")>()),
  createPrimitiveClient: (options: unknown) => {
    sdk.created(options);
    return { send: sdk.send };
  },
}));

const NOW = new Date("2026-10-17T19:00:00.000Z");
const SECRET = "primitive-webhook-secret";
const LINK_SECRET = "0123456789abcdef";
const DOMAIN = "brave-otter.primitive.email";
const AGENT_ID = "11111111-2222-4333-8444-555555555555";
const ADDRESS = agentEmailAddress(LINK_SECRET, AGENT_ID, DOMAIN);
const AGENT = { id: AGENT_ID } as Agent;

const TASK: ToolOutput<"ask_eyes"> = {
  task_id: "99999999-8888-4777-8666-555555555555",
  status: "dispatched",
  workers_notified: 3,
  escrowed_usd: 3.5,
  deadline_at: "2026-10-17T19:30:00.000Z",
  next_step: "Call await_answer.",
};

const ANSWER: Answer = {
  task_id: TASK.task_id,
  answer_text: "About 6 people in line.",
  answer_bool: true,
  photo_url: "https://storage.eyes.test/photos/abc.jpg",
  captured_at: "2026-10-17T19:12:00.000Z",
  worker_distance_m: 41.6,
  verification: {
    gps_ok: true,
    fresh_ok: true,
    vision_ok: true,
    vision_reason: "Line visible at the counter.",
  },
  confidence: 0.91,
  worker_rating: 5,
  cost_usd: 3.5,
};

const pending = (status: ToolOutput<"await_answer">["status"]): ToolOutput<"await_answer"> => ({
  task_id: TASK.task_id,
  status,
  answered: false,
  answer: null,
  next_step: "Call await_answer again.",
});
const answered: ToolOutput<"await_answer"> = {
  task_id: TASK.task_id,
  status: "verified",
  answered: true,
  answer: ANSWER,
  next_step: "Done.",
};

function emailEvent(
  o: {
    event?: string;
    rcpt?: string[];
    subject?: string | null;
    text?: string | null;
    messageId?: string | null;
    references?: string[] | null;
    id?: string;
    from?: string;
    replyTo?: string;
    html?: string;
    auth?: Record<string, unknown>;
  } = {},
) {
  const rcpt = o.rcpt ?? [ADDRESS];
  return {
    id: o.id ?? `evt_${"a".repeat(64)}`,
    event: o.event ?? "email.received",
    version: "2025-12-14",
    delivery: { endpoint_id: "ep_1", attempt: 1, attempted_at: NOW.toISOString() },
    email: {
      id: "em_1",
      thread_id: null,
      received_at: NOW.toISOString(),
      smtp: { helo: "mail.agent.test", mail_from: "agent@agent.test", rcpt_to: rcpt },
      headers: {
        message_id: o.messageId === undefined ? "<m1@agent.test>" : o.messageId,
        subject: o.subject === undefined ? "Line check" : o.subject,
        from: o.from ?? "Agent <agent@agent.test>",
        to: rcpt.join(", "),
        date: null,
      },
      content: { raw: null, download: null },
      parsed: {
        status: "complete",
        error: null,
        body_text:
          o.text === undefined
            ? "How many people are in line right now?\nLocation: Blue Bottle Coffee, Mint Plaza, San Francisco\nType: line_length"
            : o.text,
        body_html: o.html ?? null,
        reply_to: o.replyTo ? [{ address: o.replyTo, name: null }] : null,
        cc: null,
        bcc: null,
        to_addresses: rcpt.map((address) => ({ address, name: null })),
        in_reply_to: null,
        references: o.references === undefined ? ["<m0@agent.test>"] : o.references,
        attachments: [],
        attachments_download_url: null,
      },
      analysis: {},
      auth: {
        spf: "pass",
        dmarc: "pass",
        dmarcPolicy: "none",
        dmarcFromDomain: "agent.test",
        dmarcSpfAligned: true,
        dmarcDkimAligned: true,
        dmarcSpfStrict: false,
        dmarcDkimStrict: false,
        dkimSignatures: [],
        ...o.auth,
      },
    },
  };
}

function signed(body: string, opts: { secret?: string; at?: Date } = {}): Record<string, string> {
  const t = Math.floor((opts.at ?? NOW).getTime() / 1000);
  const v1 = createHmac("sha256", opts.secret ?? SECRET)
    .update(`${t}.${body}`)
    .digest("hex");
  return { "content-type": "application/json", "primitive-signature": `t=${t},v1=${v1}` };
}

function setup(
  service: Partial<
    Record<"agentById" | "askEyes" | "awaitAnswer", (...args: never[]) => Promise<unknown>>
  > = {},
  env: Record<string, string> = { PRIMITIVE_WEBHOOK_SECRET: SECRET },
) {
  const providers = fakeProviders();
  providers.clock.set(NOW);
  const config = AppConfig.parse({
    public_api_url: "https://api.eyes.test",
    worker_web_url: "https://w.eyes.test",
    link_secret: LINK_SECRET,
    email_domain: DOMAIN,
  });
  const svc = {
    agentById: vi.fn(async (id: string) => (id === AGENT_ID ? AGENT : null)),
    askEyes: vi.fn(async (_agent: Agent, _input: unknown): Promise<ToolOutput<"ask_eyes">> => TASK),
    awaitAnswer: vi.fn(
      async (_agent: Agent, _input: unknown): Promise<ToolOutput<"await_answer">> => answered,
    ),
    ...service,
  };
  const app = primitiveRoutes({ service: svc as unknown as EyesService, providers, config }, env);
  const post = (body: string, headers = signed(body, { at: providers.clock.now() })) =>
    app.request("/", { method: "POST", body, headers });
  return { post, svc, outbox: providers.email.outbox, email: providers.email, clock: providers.clock };
}

const directiveFree = (text: string | undefined) => parseTaskEmail("", text ?? "").location === null;

const thread = { to: "agent@agent.test", subject: "Re: Line check", in_reply_to: "<m1@agent.test>" };
const references = ["<m0@agent.test>", "<m1@agent.test>"];

let warn: MockInstance<typeof console.warn>;
let error: MockInstance<typeof console.error>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("primitive webhook signature", () => {
  const body = JSON.stringify(emailEvent());
  it.each([
    ["wrong secret", body, signed(body, { secret: "other" })],
    ["tampered body", body.replace("Line check", "Line chick"), signed(body)],
    ["stale timestamp", body, signed(body, { at: new Date(NOW.getTime() - 301_000) })],
    ["future timestamp", body, signed(body, { at: new Date(NOW.getTime() + 61_000) })],
    ["missing header", body, { "content-type": "application/json" }],
    ["malformed header", body, { "primitive-signature": "t=1,v1=zz" }],
  ])("rejects %s with 401 before touching the service", async (_, sentBody, headers) => {
    const { post, svc, outbox } = setup();
    const res = await post(sentBody, headers);
    expect(res.status).toBe(401);
    expect(svc.agentById).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(0);
  });

  it("fails closed when PRIMITIVE_WEBHOOK_SECRET is not set, even for a body signed with an empty secret", async () => {
    const { post, svc } = setup({}, {});
    expect((await post(body, signed(body, { secret: "" }))).status).toBe(401);
    expect(svc.agentById).not.toHaveBeenCalled();
  });

  it("accepts a correctly signed email and posts the task with the Message-ID as idempotency key", async () => {
    const { post, svc } = setup();
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(svc.agentById).toHaveBeenCalledWith(AGENT_ID);
    expect(svc.askEyes).toHaveBeenCalledWith(AGENT, {
      question: "Line check. How many people are in line right now?",
      location: "Blue Bottle Coffee, Mint Plaza, San Francisco",
      task_type: "line_length",
      idempotency_key: "<m1@agent.test>",
      bounty_usd: 3,
      deadline_minutes: 30,
      require_photo: true,
    });
  });
});

describe("recipient address", () => {
  const forged = ADDRESS.replace(/[a-z0-9_-]@/i, (m) => `${m[0]?.toLowerCase() === "x" ? "y" : "x"}@`);
  it.each([
    ["a forged MAC", [forged]],
    ["the shared tasks address", [`tasks@${DOMAIN}`]],
    ["another agent's id with this MAC", [ADDRESS.replace("11111111", "11111112")]],
  ])("ignores mail to %s without calling the service or replying", async (_, rcpt) => {
    const { post, svc, outbox } = setup();
    const res = await post(JSON.stringify(emailEvent({ rcpt })));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(svc.agentById).not.toHaveBeenCalled();
    expect(svc.askEyes).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(0);
  });

  it("uses the first recipient that is a valid agent address", async () => {
    const { post, svc } = setup();
    await post(JSON.stringify(emailEvent({ rcpt: [`tasks@${DOMAIN}`, forged, ADDRESS] })));
    expect(svc.agentById).toHaveBeenCalledWith(AGENT_ID);
    expect(svc.askEyes).toHaveBeenCalledOnce();
  });

  it("ignores a valid address whose agent no longer exists", async () => {
    const { post, svc, outbox } = setup({ agentById: async () => null });
    expect(await (await post(JSON.stringify(emailEvent()))).text()).toBe("ignored");
    expect(svc.askEyes).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(0);
  });

  it.each([
    ["a bounce event", JSON.stringify(emailEvent({ event: "email.bounced" }))],
    ["a payload that fails validation", JSON.stringify({ event: "email.received", secret: "body text" })],
    ["a non-JSON body", "not json, secret body text"],
  ])("ignores %s with 200 and logs no body", async (_, body) => {
    const { post, svc } = setup();
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(svc.agentById).not.toHaveBeenCalled();
    expect([...warn.mock.calls, ...error.mock.calls].join(" ")).not.toContain("body text");
  });
});

describe("sender authentication", () => {
  it("replies only to the DMARC-authenticated From address, never to Reply-To", async () => {
    const { post, outbox } = setup();
    await post(JSON.stringify(emailEvent({ replyTo: "victim@third.test" })));
    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    expect(outbox.map((m) => m.to)).toEqual(["agent@agent.test", "agent@agent.test"]);
  });

  it.each([
    [
      "a spoofed From with spf and dmarc failing",
      {
        from: "CEO <ceo@bank.test>",
        auth: { spf: "fail", dmarc: "fail", dmarcPolicy: "reject", dmarcFromDomain: "bank.test" },
      },
    ],
    ["no DMARC result", { auth: { dmarc: "none", dmarcPolicy: null } }],
    ["a DMARC temperror", { auth: { dmarc: "temperror" } }],
    ["DMARC passing for a different domain than From", { auth: { dmarcFromDomain: "relay.test" } }],
    ["a sender on our own domain", { from: `Eyes <eyes@${DOMAIN}>`, auth: { dmarcFromDomain: DOMAIN } }],
  ])("processes nothing and sends nothing for %s", async (_, overrides) => {
    const { post, svc, outbox } = setup();
    const res = await post(JSON.stringify(emailEvent({ ...overrides, replyTo: "victim@third.test" })));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ignored");
    expect(svc.agentById).not.toHaveBeenCalled();
    expect(svc.askEyes).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(0);
  });
});

describe("redelivery", () => {
  it("sends nothing for a redelivered event or Message-ID after the answer went out, until the TTL passes", async () => {
    const { post, svc, outbox, clock } = setup();
    await post(JSON.stringify(emailEvent()));
    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    expect(await (await post(JSON.stringify(emailEvent()))).text()).toBe("duplicate");
    expect(await (await post(JSON.stringify(emailEvent({ id: `evt_${"b".repeat(64)}` })))).text()).toBe(
      "duplicate",
    );
    expect(svc.askEyes).toHaveBeenCalledOnce();
    expect(outbox).toHaveLength(2);
    clock.advance(24 * 60 * 60 * 1000 + 1000);
    expect(await (await post(JSON.stringify(emailEvent()))).text()).toBe("ok");
    expect(svc.askEyes).toHaveBeenCalledTimes(2);
  });

  it("treats the same Message-ID for a different agent as a new email", async () => {
    const other = "22222222-2222-4333-8444-555555555555";
    const { post, svc } = setup({ agentById: async (id: string) => ({ id }) as Agent });
    await post(JSON.stringify(emailEvent()));
    await post(
      JSON.stringify(
        emailEvent({ id: `evt_${"c".repeat(64)}`, rcpt: [agentEmailAddress(LINK_SECRET, other, DOMAIN)] }),
      ),
    );
    expect(svc.askEyes).toHaveBeenCalledTimes(2);
  });
});

describe("parseTaskEmail", () => {
  it.each([
    [
      "subject and body",
      "Line check",
      "How long is the line?\nLocation: Ferry Building, San Francisco",
      {
        question: "Line check. How long is the line?",
        location: "Ferry Building, San Francisco",
        task_type: "other_public",
      },
    ],
    [
      "At: line, Type with spaces and case",
      "Is the pharmacy open?",
      "At: Walgreens, 135 Powell St\nType: Is Open",
      { question: "Is the pharmacy open?", location: "Walgreens, 135 Powell St", task_type: "is_open" },
    ],
    [
      "first location and first type win",
      "Re: Fwd: Oat milk",
      "Location: Trader Joe's, 401 Bay St\nLocation: somewhere else\nType: in_stock\nType: price_check\nIs oat milk on the shelf?",
      {
        question: "Oat milk. Is oat milk on the shelf?",
        location: "Trader Joe's, 401 Bay St",
        task_type: "in_stock",
      },
    ],
    [
      "unknown type falls back to other_public",
      "How busy is it?",
      "Location: Dolores Park\nType: queue",
      { question: "How busy is it?", location: "Dolores Park", task_type: "other_public" },
    ],
    [
      "quoted reply and Gmail attribution stripped",
      "Re: Line check",
      "Location: Ferry Building\n\nOn Fri, Oct 17, 2026 at 12:00 PM Eyes <eyes@x> wrote:\n> Location: Old place\n> old question",
      { question: "Line check", location: "Ferry Building", task_type: "other_public" },
    ],
    [
      "inline quotes and signature stripped",
      "",
      "> earlier text\nHow crowded is the park?\nLocation: Dolores Park\n-- \nBot v2\nLocation: signature place",
      { question: "How crowded is the park?", location: "Dolores Park", task_type: "other_public" },
    ],
    [
      "Outlook original message stripped",
      "Price check",
      "What does a latte cost?\nAt: Sightglass\n-----Original Message-----\nFrom: Eyes\nType: in_stock",
      { question: "Price check. What does a latte cost?", location: "Sightglass", task_type: "other_public" },
    ],
    [
      "no location line",
      "Is it open?",
      "Please check the bakery.",
      { question: "Is it open? Please check the bakery.", location: null, task_type: "other_public" },
    ],
    [
      "empty location value",
      "Is it open?",
      "Location:   ",
      { question: "Is it open?", location: null, task_type: "other_public" },
    ],
    ["null subject and body", null, null, { question: "", location: null, task_type: "other_public" }],
    [
      "Gmail attribution wrapped over two lines",
      "Re: Line check",
      "Location: Ferry Building\nOn Fri, Oct 17, 2026 at 12:00 PM Eyes <\neyes@brave-otter.primitive.email> wrote:\n\nLocation: quoted place",
      { question: "Line check", location: "Ferry Building", task_type: "other_public" },
    ],
    [
      "From: line without Sent or Date stays in the question",
      "Note",
      "From: the front window, is the sign lit?\nLocation: Castro Theatre",
      {
        question: "Note. From: the front window, is the sign lit?",
        location: "Castro Theatre",
        task_type: "other_public",
      },
    ],
    [
      "Outlook header block with Sent stops the body",
      "Is it open?",
      "Location: Tartine\nFrom: Eyes\nSent: Friday, October 17, 2026\nTo: agent\nLocation: quoted place",
      { question: "Is it open?", location: "Tartine", task_type: "other_public" },
    ],
    [
      "Bounty and Deadline lines",
      "Is the line long?",
      "Location: Tartine\nBounty: $5\nDeadline: 45 minutes",
      {
        question: "Is the line long?",
        location: "Tartine",
        task_type: "other_public",
        bounty_usd: 5,
        deadline_minutes: 45,
      },
    ],
    [
      "unreadable Bounty and Deadline become NaN for the schema to reject",
      "Is the line long?",
      "Location: Tartine\nBounty: five bucks\nDeadline: soon",
      {
        question: "Is the line long?",
        location: "Tartine",
        task_type: "other_public",
        bounty_usd: Number.NaN,
        deadline_minutes: Number.NaN,
      },
    ],
  ])("%s", (_, subject, text, expected) => {
    expect(parseTaskEmail(subject, text)).toEqual(expected);
  });

  it("falls back to body_html with tags and entities stripped when there is no plain text", () => {
    const html =
      "<div>Is the <b>patio</b> open &amp; busy?</div><div>Location: Zeitgeist, Valencia St</div><style>p{}</style><blockquote>Location: quoted</blockquote>";
    expect(parseTaskEmail("Patio", null, html)).toEqual({
      question: "Patio. Is the patio open & busy?",
      location: "Zeitgeist, Valencia St",
      task_type: "other_public",
    });
    expect(parseTaskEmail("Patio", "plain wins\nLocation: A", html).location).toBe("A");
  });

  it("caps the question at 500 chars without leaving half a surrogate pair", () => {
    const { question } = parseTaskEmail("Q", `${"a".repeat(496)}${"🍩".repeat(10)}`);
    expect(question.length).toBeLessThanOrEqual(500);
    expect(question).not.toMatch(/\p{Cs}/u);
  });
});

describe("in-thread replies", () => {
  it("asks for a location, in words the parser cannot mistake for a directive, and posts no task", async () => {
    const { post, svc, outbox } = setup();
    await post(JSON.stringify(emailEvent({ text: "Is it open?" })));
    expect(svc.askEyes).not.toHaveBeenCalled();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ ...thread, references });
    expect(outbox[0]?.text).toContain("Eyes needs to know where to look");
    expect(outbox[0]?.text).toContain("starts with the word Location and a colon");
    expect(directiveFree(outbox[0]?.text)).toBe(true);
  });

  it("replies with an invalid_input explanation naming the bad field", async () => {
    const { post, svc, outbox } = setup();
    await post(
      JSON.stringify(emailEvent({ subject: "Line?", text: "Location: Ferry Building\nBounty: $80" })),
    );
    expect(svc.askEyes).not.toHaveBeenCalled();
    expect(outbox[0]?.text).toContain("bounty_usd");
    expect(outbox[0]?.text).toContain("How to fix:");
    expect(directiveFree(outbox[0]?.text)).toBe(true);
  });

  it("passes Bounty and Deadline lines to askEyes", async () => {
    const { post, svc } = setup();
    await post(
      JSON.stringify(emailEvent({ text: "How long is the line?\nAt: Tartine\nBounty: 5 USD\nDeadline: 60" })),
    );
    expect(svc.askEyes).toHaveBeenCalledWith(
      AGENT,
      expect.objectContaining({ bounty_usd: 5, deadline_minutes: 60 }),
    );
  });

  it("falls back to Primitive's email id when the Message-ID header is missing", async () => {
    const { post, svc, outbox } = setup();
    await post(JSON.stringify(emailEvent({ messageId: null })));
    expect(svc.askEyes).toHaveBeenCalledWith(AGENT, expect.objectContaining({ idempotency_key: "em_1" }));
    expect(outbox[0]).toMatchObject({ in_reply_to: undefined, references: ["<m0@agent.test>"] });
  });

  it("caps the reply subject at 200 characters", async () => {
    const { post, outbox } = setup();
    await post(JSON.stringify(emailEvent({ subject: `Q ${"x".repeat(300)}` })));
    expect(outbox[0]?.subject.length).toBeLessThanOrEqual(200);
  });

  it("answers 200 and logs when every reply send fails", async () => {
    const { post, email } = setup();
    email.send = async () => Promise.reject(new Error("recipient_not_allowed"));
    const res = await post(JSON.stringify(emailEvent()));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(error.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(error.mock.calls.join(" ")).not.toContain("agent@agent.test");
  });

  it("turns an EyesError from askEyes into an in-thread reply with the message and fix", async () => {
    const err = new EyesError("insufficient_balance", {
      top_up_url: "https://api.eyes.test/topup/t",
      max_affordable_bounty_usd: 1,
    });
    const { post, outbox } = setup({ askEyes: async () => Promise.reject(err) });
    const res = await post(JSON.stringify(emailEvent()));
    expect(res.status).toBe(200);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ ...thread, references });
    expect(outbox[0]?.text).toContain(err.message);
    expect(outbox[0]?.text).toContain("https://api.eyes.test/topup/t");
  });

  it("never leaks an unexpected error's message into the reply", async () => {
    const { post, outbox } = setup({ askEyes: async () => Promise.reject(new Error("db password=hunter2")) });
    await post(JSON.stringify(emailEvent()));
    expect(outbox[0]?.text).not.toContain("hunter2");
    expect(outbox[0]?.text).toContain("Something went wrong");
    expect(error.mock.calls.join(" ")).not.toContain("hunter2");
  });
});

describe("answer loop", () => {
  it("acknowledges before waiting, then replies once in-thread with the answer and the photo", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const awaitAnswer = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate;
        return pending("claimed");
      })
      .mockImplementationOnce(async () => answered);
    const { post, outbox } = setup({ awaitAnswer });
    const res = await post(JSON.stringify(emailEvent()));
    expect(res.status).toBe(200);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ ...thread, references, attachments: undefined });
    expect(outbox[0]?.text).toBe(
      `Got it: task ${TASK.task_id}, 3 workers notified, escrowed $3.50. We'll reply here with the answer.`,
    );
    release();
    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    const reply = outbox[1] as OutboundEmail;
    expect(reply).toMatchObject({
      ...thread,
      references,
      attachments: [{ filename: "eyes-photo", content_type: "image/jpeg", url: ANSWER.photo_url }],
    });
    for (const part of [
      "About 6 people in line.",
      "Yes/no: yes",
      "GPS passed",
      "42 m",
      "0.91",
      "$3.50",
      ANSWER.photo_url,
    ]) {
      expect(reply.text).toContain(part);
    }
    expect(awaitAnswer).toHaveBeenCalledTimes(2);
    expect(awaitAnswer).toHaveBeenCalledWith(AGENT, { task_id: TASK.task_id, timeout_seconds: 55 });
  });

  it("sends exactly one refund reply and stops when the task expires", async () => {
    const awaitAnswer = vi.fn().mockResolvedValue(pending("expired"));
    const { post, outbox } = setup({ awaitAnswer });
    await post(JSON.stringify(emailEvent()));
    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outbox).toHaveLength(2);
    expect(awaitAnswer).toHaveBeenCalledOnce();
    expect(outbox[1]).toMatchObject({ ...thread, references });
    expect(outbox[1]?.text).toContain("ended without an answer (expired)");
    expect(outbox[1]?.text).toContain("$3.50 escrow is refunded");
  });

  it("treats disputed as terminal and points to get_task", async () => {
    const awaitAnswer = vi.fn().mockResolvedValue(pending("disputed"));
    const { post, outbox } = setup({ awaitAnswer });
    await post(JSON.stringify(emailEvent()));
    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    expect(awaitAnswer).toHaveBeenCalledOnce();
    expect(outbox[1]?.text).toContain("ended without an answer (disputed). Call get_task");
  });

  it("sleeps and retries after an awaitAnswer error, then sends the answer", async () => {
    vi.useFakeTimers();
    const awaitAnswer = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(answered);
    const { post, outbox } = setup({ awaitAnswer });
    await post(JSON.stringify(emailEvent()));
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(awaitAnswer).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(awaitAnswer).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    expect(outbox[1]?.text).toContain(ANSWER.answer_text);
  });

  it("gives up after 5 consecutive awaitAnswer errors with one get_task reply", async () => {
    vi.useFakeTimers();
    const awaitAnswer = vi.fn().mockRejectedValue(new Error("db down"));
    const { post, outbox } = setup({ awaitAnswer });
    await post(JSON.stringify(emailEvent()));
    for (let failures = 1; failures < 5; failures++) {
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(failures));
      await vi.advanceTimersByTimeAsync(5_000);
    }
    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    expect(awaitAnswer).toHaveBeenCalledTimes(5);
    expect(outbox[1]?.text).toContain(`Eyes stopped waiting on task ${TASK.task_id}. Call get_task`);
  });

  it("falls back to a reply without the attachment when the photo cannot be attached", async () => {
    const { post, outbox, email } = setup();
    const send = email.send;
    email.send = async (msg) => (msg.attachments ? Promise.reject(new Error("fetch failed")) : send(msg));
    await post(JSON.stringify(emailEvent()));
    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    expect(outbox[1]?.attachments).toBeUndefined();
    expect(outbox[1]?.text).toContain(ANSWER.photo_url);
  });

  it("starts one loop and sends one ack when Primitive redelivers while the loop is waiting", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const awaitAnswer = vi.fn(async () => {
      await gate;
      return answered;
    });
    const { post, outbox } = setup({ awaitAnswer });
    await post(JSON.stringify(emailEvent()));
    expect(await (await post(JSON.stringify(emailEvent()))).text()).toBe("duplicate");
    release();
    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(awaitAnswer).toHaveBeenCalledOnce();
    expect(outbox).toHaveLength(2);
  });
});

describe("createPrimitiveEmail", () => {
  const env = { PRIMITIVE_API_KEY: "prim_test", PRIMITIVE_DOMAIN: DOMAIN };
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  beforeEach(() => {
    sdk.created.mockReset();
    sdk.send.mockReset().mockResolvedValue({ id: "se_1", status: "queued", requestId: "req_1" });
  });

  it("refuses to start without an API key or domain", () => {
    expect(() => createPrimitiveEmail({ PRIMITIVE_DOMAIN: DOMAIN })).toThrow(/PRIMITIVE_API_KEY/);
    expect(() => createPrimitiveEmail({ PRIMITIVE_API_KEY: "prim_test" })).toThrow(/PRIMITIVE_DOMAIN/);
  });

  it("sends from eyes@ the domain with threading headers and the photo inlined as base64", async () => {
    const fetchMock = vi.fn(
      async () => new Response(photo, { headers: { "content-type": "image/png; charset=binary" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await createPrimitiveEmail(env).send({
      to: "agent@agent.test",
      subject: "Re: Line check",
      text: "Answer",
      in_reply_to: "<m1@agent.test>",
      references: ["<m0@agent.test>", "<m1@agent.test>"],
      attachments: [{ filename: "eyes-photo", content_type: "image/jpeg", url: ANSWER.photo_url as string }],
    });
    expect(result).toEqual({ id: "se_1", message_id: null });
    expect(sdk.created).toHaveBeenCalledWith({ apiKey: "prim_test" });
    expect(fetchMock).toHaveBeenCalledWith(ANSWER.photo_url, expect.anything());
    expect(sdk.send).toHaveBeenCalledWith({
      from: `eyes@${DOMAIN}`,
      to: "agent@agent.test",
      subject: "Re: Line check",
      bodyText: "Answer",
      bodyHtml: undefined,
      thread: { inReplyTo: "<m1@agent.test>", references: ["<m0@agent.test>", "<m1@agent.test>"] },
      attachments: [
        {
          filename: "eyes-photo.png",
          content_type: "image/png",
          content_base64: Buffer.from(photo).toString("base64"),
        },
      ],
    });
  });

  it("keeps the caller's image type when the download is not labelled as an image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(photo, { headers: { "content-type": "application/octet-stream" } })),
    );
    await createPrimitiveEmail(env).send({
      to: "agent@agent.test",
      subject: "s",
      text: "t",
      attachments: [
        { filename: "eyes-photo", content_type: "image/jpeg", url: "https://storage.eyes.test/p" },
      ],
    });
    expect(sdk.send).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [expect.objectContaining({ filename: "eyes-photo.jpeg", content_type: "image/jpeg" })],
      }),
    );
  });

  it("stops reading and cancels a body with no content-length once it passes 10 MiB", async () => {
    let pulled = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(endless)),
    );
    const send = createPrimitiveEmail(env).send({
      to: "agent@agent.test",
      subject: "s",
      text: "t",
      attachments: [{ filename: "p", content_type: "image/jpeg", url: "https://storage.eyes.test/p" }],
    });
    await expect(send).rejects.toThrow(/over/);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(15);
    expect(sdk.send).not.toHaveBeenCalled();
  });

  it.each([
    [
      "declared too large",
      () => new Response(photo, { headers: { "content-length": String(11 * 1024 * 1024) } }),
    ],
    ["actually too large", () => new Response(new Uint8Array(10 * 1024 * 1024 + 1))],
    ["not found", () => new Response("missing", { status: 404 })],
  ])("throws without sending when the attachment is %s", async (_, response) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );
    const send = createPrimitiveEmail(env).send({
      to: "agent@agent.test",
      subject: "s",
      text: "t",
      attachments: [
        { filename: "p.jpg", content_type: "image/jpeg", url: "https://storage.eyes.test/p.jpg" },
      ],
    });
    await expect(send).rejects.toThrow(/attachment/);
    expect(sdk.send).not.toHaveBeenCalled();
  });

  it("throws when Primitive answers gate_denied instead of sending", async () => {
    sdk.send.mockResolvedValueOnce({ id: "se_2", status: "gate_denied", requestId: "req_2" });
    await expect(createPrimitiveEmail(env).send({ to: "x@y.test", subject: "s", text: "t" })).rejects.toThrow(
      /gate_denied/,
    );
  });
});
