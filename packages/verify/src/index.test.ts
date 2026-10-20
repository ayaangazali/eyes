import { distanceMeters, fakeVision, type Task, type VerifyInput, type Vision } from "@eyes/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeVision, createClefVision, verifySubmission } from "./index.ts";

const task: Task = {
  id: "00000000-0000-4000-8000-000000000001",
  agent_id: "00000000-0000-4000-8000-000000000002",
  question: "Is the line out the door?",
  task_type: "line_length",
  place_label: "Blue Bottle Coffee, Mint Plaza, San Francisco",
  lat: 37.78246,
  lng: -122.40776,
  radius_m: 150,
  bounty_cents: 300,
  fee_cents: 50,
  require_photo: true,
  deadline_at: "2026-10-17T19:30:00.000Z",
  status: "claimed",
  claimed_by: "00000000-0000-4000-8000-000000000003",
  claimed_at: "2026-10-17T19:01:00.000Z",
  idempotency_key: null,
  dispute_reason: null,
  created_at: "2026-10-17T19:00:00.000Z",
};

const north = (m: number) => task.lat + m / 111_195;

const input = (
  sub: Partial<VerifyInput["submission"]> = {},
  vision: Vision = fakeVision(),
  t: Partial<Task> = {},
): VerifyInput => ({
  task: { ...task, ...t },
  vision,
  submission: {
    lat: north(100),
    lng: task.lng,
    accuracy_m: 10,
    captured_at: "2026-10-17T19:09:00.000Z",
    received_at: "2026-10-17T19:10:00.000Z",
    photo_url: "https://storage.fake.test/photos/a.jpg",
    answer_text: "About 6 people in line",
    answer_bool: null,
    ...sub,
  },
});

describe("verifySubmission", () => {
  it("auto-approves when gps, freshness and moderation pass, showing vision only the photo", async () => {
    const vision = fakeVision();
    const r = await verifySubmission(input({ answer_text: "Closed, a wrong answer" }, vision));
    expect(r).toMatchObject({ gps_ok: true, fresh_ok: true, vision_ok: true, auto_approve: true });
    expect(r.worker_distance_m).toBeCloseTo(100, 0);
    expect(r.confidence).toBeCloseTo(0.95);
    expect(vision.calls).toEqual([{ photo_url: "https://storage.fake.test/photos/a.jpg" }]);
  });

  it("fails gps outside the radius", async () => {
    const r = await verifySubmission(input({ lat: north(200) }));
    expect(r.gps_ok).toBe(false);
    expect(r.auto_approve).toBe(false);
  });

  it("passes at exactly the radius and fails 1 mm beyond it", async () => {
    const d = distanceMeters({ lat: north(100), lng: task.lng }, task);
    expect((await verifySubmission(input({ accuracy_m: 0 }, fakeVision(), { radius_m: d }))).gps_ok).toBe(
      true,
    );
    expect(
      (await verifySubmission(input({ accuracy_m: 0 }, fakeVision(), { radius_m: d - 0.001 }))).gps_ok,
    ).toBe(false);
  });

  it("lets reported accuracy cover a fix just outside the radius", async () => {
    expect((await verifySubmission(input({ lat: north(190), accuracy_m: 60 }))).gps_ok).toBe(true);
    expect((await verifySubmission(input({ lat: north(190), accuracy_m: 30 }))).gps_ok).toBe(false);
  });

  it("caps the accuracy slack at 50 m beyond the radius", async () => {
    const d = distanceMeters({ lat: north(100), lng: task.lng }, task);
    const fix = { accuracy_m: 100 };
    expect((await verifySubmission(input(fix, fakeVision(), { radius_m: d - 50 }))).gps_ok).toBe(true);
    expect((await verifySubmission(input(fix, fakeVision(), { radius_m: d - 50.001 }))).gps_ok).toBe(false);
  });

  it("never passes a fix with accuracy worse than 100 m, even on the spot", async () => {
    expect((await verifySubmission(input({ lat: task.lat, accuracy_m: 100 }))).gps_ok).toBe(true);
    expect((await verifySubmission(input({ lat: task.lat, accuracy_m: 101 }))).gps_ok).toBe(false);
  });

  it("passes freshness at the deadline and fails 1 ms after it", async () => {
    const at = (received_at: string) => input({ captured_at: "2026-10-17T19:29:30.000Z", received_at });
    expect((await verifySubmission(at("2026-10-17T19:30:00.000Z"))).fresh_ok).toBe(true);
    const late = await verifySubmission(at("2026-10-17T19:30:00.001Z"));
    expect(late.fresh_ok).toBe(false);
    expect(late.auto_approve).toBe(false);
  });

  it("fails freshness for a photo captured more than 5 minutes before upload", async () => {
    expect((await verifySubmission(input({ captured_at: "2026-10-17T19:05:00.000Z" }))).fresh_ok).toBe(true);
    expect((await verifySubmission(input({ captured_at: "2026-10-17T19:04:59.000Z" }))).fresh_ok).toBe(false);
  });

  it("fails freshness for captured_at in the future beyond 60 s of clock skew", async () => {
    expect((await verifySubmission(input({ captured_at: "2026-10-17T19:11:00.000Z" }))).fresh_ok).toBe(true);
    expect((await verifySubmission(input({ captured_at: "2026-10-17T19:11:00.001Z" }))).fresh_ok).toBe(false);
  });

  it("allows ordinary photos even when content confidence is low", async () => {
    const r = await verifySubmission(input({}, fakeVision({ confidence: 0.1 })));
    expect(r.vision_ok).toBe(true);
    expect(r.auto_approve).toBe(true);
  });

  it("holds confirmed gore with the moderation reason", async () => {
    const r = await verifySubmission(
      input({}, fakeVision({ allowed: false, reason: "The photo shows graphic gore." })),
    );
    expect(r).toMatchObject({
      vision_ok: false,
      vision_reason: "The photo shows graphic gore.",
      auto_approve: false,
    });
  });

  it("records an unavailable verdict without leaking the error text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: Vision = {
      judge: async () => {
        throw Object.assign(new Error("upstream detail"), { name: "APIConnectionTimeoutError" });
      },
    };
    const r = await verifySubmission(input({}, broken));
    expect(r).toMatchObject({
      vision_ok: null,
      vision_reason: "Safety check unavailable; the photo needs manual review.",
      auto_approve: false,
    });
    expect(log).toHaveBeenCalledWith(expect.any(String), "APIConnectionTimeoutError");
    expect(JSON.stringify(log.mock.calls)).not.toContain("upstream detail");
    log.mockRestore();
  });

  it("treats a vision call that stalls for 25 s as unavailable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const stalled: Vision = { judge: () => new Promise(() => {}) };
    const pending = verifySubmission(input({}, stalled));
    await vi.advanceTimersByTimeAsync(25_000);
    const r = await pending;
    expect(r).toMatchObject({ vision_ok: null, auto_approve: false });
    expect(r.vision_reason).toMatch(/unavailable/);
    log.mockRestore();
    vi.useRealTimers();
  });

  it("approves on gps and freshness alone when no photo was required or sent", async () => {
    const vision = fakeVision();
    const r = await verifySubmission(input({ photo_url: null }, vision, { require_photo: false }));
    expect(r).toMatchObject({ vision_ok: true, vision_reason: "No photo required", auto_approve: true });
    expect(vision.calls).toHaveLength(0);
    const far = await verifySubmission(
      input({ photo_url: null, lat: north(500) }, vision, { require_photo: false }),
    );
    expect(far.auto_approve).toBe(false);
  });

  it("marks a missing required photo for review without calling vision", async () => {
    const vision = fakeVision();
    const r = await verifySubmission(input({ photo_url: null }, vision));
    expect(r).toMatchObject({ vision_ok: false, vision_reason: "no photo", auto_approve: false });
    expect(vision.calls).toHaveLength(0);
  });

  it("keeps confidence within [0, 1]", async () => {
    const best = await verifySubmission(input({}, fakeVision({ confidence: 5 })));
    const nan = await verifySubmission(input({}, fakeVision({ confidence: Number.NaN })));
    const worst = await verifySubmission(
      input({ lat: north(5000), received_at: "2026-10-17T20:00:00.000Z", photo_url: null }),
    );
    expect(best.confidence).toBe(1);
    expect(nan.confidence).toBe(0.5);
    expect(worst.confidence).toBe(0);
  });
});

const message = (content: unknown[], stop_reason = "end_turn") =>
  new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content,
      stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { headers: { "content-type": "application/json" } },
  );

const judgeInput = { photo_url: "https://storage.fake.test/photos/b.jpg" };

describe("createClaudeVision", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws at construction without ANTHROPIC_API_KEY", () => {
    expect(() => createClaudeVision({})).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("sends only the photo by URL and returns the parsed moderation verdict", async () => {
    const verdict = { gore: false, explicit_sexual: false, reason: "Safe to share.", confidence: 0.8 };
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      message([{ type: "text", text: JSON.stringify(verdict) }]),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(createClaudeVision({ ANTHROPIC_API_KEY: "test" }).judge(judgeInput)).resolves.toEqual({
      allowed: true,
      reason: verdict.reason,
      confidence: verdict.confidence,
    });

    const init = fetch.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    const [image, text] = body.messages[0].content;
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(image.source).toEqual({ type: "url", url: judgeInput.photo_url });
    expect(text.text).toBe("Moderate this photo.");
    expect(JSON.stringify(body.system)).not.toMatch(/answers_question/);
    expect(body.system).toContain("If content is uncertain, set the corresponding flag to false");
    expect(body.system).toContain("Never infer adultery");
    expect(body.system).not.toContain("prominent_faces");
  });

  it.each([
    [false, false, 0.1, true],
    [true, false, 0.79, true],
    [false, true, 0.79, true],
    [true, false, 0.8, false],
    [false, true, 0.8, false],
    [true, false, 0.9, false],
    [false, true, 0.9, false],
  ])("maps gore=%s explicit_sexual=%s to allowed=%s", async (gore, explicit_sexual, confidence, allowed) => {
    vi.stubGlobal("fetch", async () =>
      message([
        { type: "text", text: JSON.stringify({ gore, explicit_sexual, confidence, reason: "Result" }) },
      ]),
    );
    await expect(createClaudeVision({ ANTHROPIC_API_KEY: "test" }).judge(judgeInput)).resolves.toEqual({
      allowed,
      confidence,
      reason: "Result",
    });
  });

  it("rejects a verdict that does not match the schema", async () => {
    vi.stubGlobal("fetch", async () => message([{ type: "text", text: '{"allowed":"yes"}' }]));
    await expect(createClaudeVision({ ANTHROPIC_API_KEY: "test" }).judge(judgeInput)).rejects.toThrow();
  });

  it("rejects when Claude refuses and returns no verdict", async () => {
    vi.stubGlobal("fetch", async () => message([], "refusal"));
    await expect(createClaudeVision({ ANTHROPIC_API_KEY: "test" }).judge(judgeInput)).rejects.toThrow(
      /refusal/,
    );
  });
});

describe("createClefVision", () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "cf-test" };
  const response = (gore: unknown, explicit_sexual: unknown) =>
    Response.json({
      success: true,
      result: {
        answers: {
          gore: { type: "noul", noul: gore },
          explicit_sexual: { type: "noul", noul: explicit_sexual },
        },
      },
    });
  const stub = (gore: number, explicit_sexual: number) => {
    const calls: string[] = [];
    const bodies: { questions: Record<string, unknown>; images: { base64: string }[] }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url) === judgeInput.photo_url) {
        return new Response(new Uint8Array([0xff, 0xd8]), { headers: { "content-type": "image/jpeg" } });
      }
      bodies.push(JSON.parse(String(init?.body)));
      return response(gore, explicit_sexual);
    });
    return Object.assign(calls, { bodies });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends only photo bytes and the two blocked content questions", async () => {
    const calls = stub(0.05, 0.01);
    const v = await createClefVision(env).judge(judgeInput);
    expect(v).toMatchObject({ allowed: true, confidence: 0.95 });
    expect([...calls]).toEqual([
      judgeInput.photo_url,
      expect.stringContaining("/ai/run/@cf/cloudflare/clef-omni"),
    ]);
    expect(Object.keys(calls.bodies[0]?.questions ?? {})).toEqual(["gore", "explicit_sexual"]);
    expect(calls.bodies[0]?.images[0]?.base64).toBe("/9g=");
  });

  it.each([
    [0, 0],
    [0.5, 0.5],
    [0.79, 0.79],
  ])("allows ordinary or uncertain content (%s, %s), even with Claude configured", async (gore, sexual) => {
    const calls = stub(gore, sexual);
    const r = await verifySubmission(
      input(judgeInput, createClefVision({ ...env, ANTHROPIC_API_KEY: "test" })),
    );
    expect(r).toMatchObject({ vision_ok: true, auto_approve: true });
    expect(calls).toHaveLength(2);
  });

  it.each([
    [0.8, 0.01, "gore"],
    [0.01, 0.8, "sexual"],
    [1, 1, "gore"],
  ])("blocks confirmed content (%s, %s)", async (gore, sexual, reason) => {
    stub(gore, sexual);
    const r = await verifySubmission(input(judgeInput, createClefVision(env)));
    expect(r).toMatchObject({ vision_ok: false, auto_approve: false });
    expect(r.vision_reason).toContain(reason);
  });

  it("refuses to construct without both Cloudflare variables", () => {
    expect(() => createClefVision({ CLOUDFLARE_ACCOUNT_ID: "acct" })).toThrow(/must both be set/);
  });

  it("labels a photo served without a content type as JPEG", async () => {
    const bodies: { images: { content_type: string }[] }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === judgeInput.photo_url) return new Response(new Uint8Array([1, 2]));
      bodies.push(JSON.parse(String(init?.body)));
      return response(0, 0);
    });
    await createClefVision(env).judge(judgeInput);
    expect(bodies[0]?.images[0]?.content_type).toBe("image/jpeg");
  });

  it.each([
    ["photo HTTP failure", () => new Response("gone", { status: 404 }), null],
    ["clef HTTP failure", null, () => new Response("err", { status: 500 })],
    ["missing scores", null, () => Response.json({ success: true, result: { answers: {} } })],
    [
      "unsuccessful envelope",
      null,
      () =>
        Response.json({
          success: false,
          result: {
            answers: { gore: { type: "noul", noul: 0 }, explicit_sexual: { type: "noul", noul: 0 } },
          },
        }),
    ],
    ["score above one", null, () => response(1.01, 0)],
    ["score below zero", null, () => response(0, -0.1)],
    ["non-number score", null, () => response("0.1", 0)],
    ["null score", null, () => response(null, 0)],
    [
      "wrong answer type",
      null,
      () =>
        Response.json({
          success: true,
          result: {
            answers: {
              gore: { type: "choice", noul: 0 },
              explicit_sexual: { type: "noul", noul: 0 },
            },
          },
        }),
    ],
    ["malformed JSON", null, () => new Response("{")],
    [
      "network error",
      null,
      () => {
        throw new TypeError("network unavailable");
      },
    ],
  ] as const)("keeps %s unavailable rather than passing safety", async (_, photo, clef) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (url: string) =>
      url === judgeInput.photo_url
        ? (photo?.() ?? new Response(new Uint8Array([1]), { headers: { "content-type": "image/png; q=1" } }))
        : (clef?.() ?? response(0, 0)),
    );
    try {
      await expect(createClefVision(env).judge(judgeInput)).rejects.toThrow();
      const r = await verifySubmission(input(judgeInput, createClefVision(env)));
      expect(r).toMatchObject({ vision_ok: null, auto_approve: false });
      expect(r.vision_reason).toContain("unavailable");
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("uses Claude on clef failure and logs the failure without private URLs", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const hits: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      hits.push(url.includes("anthropic") ? "claude" : url === judgeInput.photo_url ? "photo" : "clef");
      if (url.includes("anthropic"))
        return message([
          {
            type: "text",
            text: JSON.stringify({
              gore: false,
              explicit_sexual: false,
              reason: "Neither confirmed.",
              confidence: 0.2,
            }),
          },
        ]);
      if (url === judgeInput.photo_url) return new Response(new Uint8Array([1]));
      throw new TypeError("private photo URL must not be logged");
    });
    try {
      await expect(
        createClefVision({ ...env, ANTHROPIC_API_KEY: "test" }).judge(judgeInput),
      ).resolves.toEqual({
        allowed: true,
        reason: "Neither confirmed.",
        confidence: 0.2,
      });
      expect(hits).toEqual(["photo", "clef", "claude"]);
      expect(log.mock.calls).toEqual([["verify: clef failed, asking Claude", "TypeError"]]);
    } finally {
      log.mockRestore();
    }
  });

  it.each(["photo", "clef"])("leaves Claude its full time after a stalled %s request", async (stage) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.includes("anthropic")) {
        await new Promise((resolve) => setTimeout(resolve, 14_999));
        return message([
          {
            type: "text",
            text: JSON.stringify({
              gore: false,
              explicit_sexual: false,
              reason: "Neither confirmed.",
              confidence: 0.9,
            }),
          },
        ]);
      }
      if (stage === "clef" && url === judgeInput.photo_url) {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        return new Response(new Uint8Array([1]));
      }
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    try {
      const completed = vi.fn();
      const pending = verifySubmission(
        input(judgeInput, createClefVision({ ...env, ANTHROPIC_API_KEY: "test" })),
      ).then(completed);
      await vi.advanceTimersByTimeAsync(23_000);
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({
          vision_ok: true,
          auto_approve: true,
          vision_reason: "Neither confirmed.",
        }),
      );
      await pending;
    } finally {
      vi.clearAllTimers();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("keeps failure of both providers unavailable", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    try {
      const r = await verifySubmission(
        input(judgeInput, createClefVision({ ...env, ANTHROPIC_API_KEY: "test" })),
      );
      expect(r).toMatchObject({ vision_ok: null, auto_approve: false });
      expect(r.vision_reason).toContain("unavailable");
    } finally {
      log.mockRestore();
    }
  });
});

describe("verifySubmission vision failure that is not an Error", () => {
  it("logs the thrown value's type only", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await verifySubmission(input({}, { judge: () => Promise.reject("secret detail") }));
    expect(r).toMatchObject({ vision_ok: null, auto_approve: false });
    expect(log).toHaveBeenCalledWith("verifySubmission: vision check failed", "string");
    log.mockRestore();
  });
});
