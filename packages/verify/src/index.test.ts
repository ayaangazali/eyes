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

  it("rejects photos with prominent faces and says so", async () => {
    const r = await verifySubmission(input({}, fakeVision({ prominent_faces: true })));
    expect(r.vision_ok).toBe(false);
    expect(r.vision_reason).toMatch(/face/i);
    expect(r.auto_approve).toBe(false);
  });

  it("holds a photo that moderation blocks, with the moderation reason", async () => {
    const r = await verifySubmission(
      input({}, fakeVision({ allowed: false, reason: "A screen shows personal details." })),
    );
    expect(r).toMatchObject({
      vision_ok: false,
      vision_reason: "A screen shows personal details.",
      auto_approve: false,
    });
  });

  it("turns a vision failure into vision_ok false without leaking the error text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: Vision = {
      judge: async () => {
        throw Object.assign(new Error("upstream detail"), { name: "APIConnectionTimeoutError" });
      },
    };
    const r = await verifySubmission(input({}, broken));
    expect(r).toMatchObject({
      vision_ok: false,
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
    expect(r).toMatchObject({ vision_ok: false, auto_approve: false });
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
    const verdict = { allowed: true, reason: "Safe to share.", prominent_faces: false, confidence: 0.8 };
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      message([{ type: "text", text: JSON.stringify(verdict) }]),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(createClaudeVision({ ANTHROPIC_API_KEY: "test" }).judge(judgeInput)).resolves.toEqual(
      verdict,
    );

    const init = fetch.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    const [image, text] = body.messages[0].content;
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(image.source).toEqual({ type: "url", url: judgeInput.photo_url });
    expect(text.text).toBe("Moderate this photo.");
    expect(JSON.stringify(body.system)).not.toMatch(/answers_question/);
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
  const stub = (safe: number, faces: number) => {
    const calls: string[] = [];
    const bodies: { questions: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url) === judgeInput.photo_url) {
        return new Response(new Uint8Array([0xff, 0xd8]), { headers: { "content-type": "image/jpeg" } });
      }
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        result: { answers: { safe_to_share: { noul: safe }, prominent_faces: { noul: faces } } },
      });
    });
    return Object.assign(calls, { bodies });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns clef's moderation verdict when it is sure, sending only the photo bytes", async () => {
    const calls = stub(0.95, 0.05);
    const v = await createClefVision(env).judge(judgeInput);
    expect(v).toMatchObject({ allowed: true, prominent_faces: false, confidence: 0.95 });
    expect([...calls]).toEqual([
      judgeInput.photo_url,
      expect.stringContaining("/ai/run/@cf/cloudflare/clef-omni"),
    ]);
    expect(Object.keys(calls.bodies[0]?.questions ?? {})).toEqual(["safe_to_share", "prominent_faces"]);
  });

  it("blocks a photo clef is sure is unsafe", async () => {
    stub(0.05, 0.05);
    expect(await createClefVision(env).judge(judgeInput)).toMatchObject({ allowed: false, confidence: 0.95 });
  });

  it("sends an unsure photo to human review when Claude is not configured", async () => {
    stub(0.6, 0.05);
    expect(await createClefVision(env).judge(judgeInput)).toMatchObject({
      allowed: false,
      prominent_faces: false,
      reason: expect.stringContaining("a person will review it"),
    });
  });

  it("fails closed when clef is down and Claude is not configured", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    await expect(createClefVision(env).judge(judgeInput)).rejects.toThrow();
  });
});
