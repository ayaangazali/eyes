import { fakeProviders } from "@eyes/core";
import { describe, expect, it } from "vitest";
import { withShortLinks } from "./short-links.ts";

const config = { public_api_url: "https://api.eyes.test", worker_web_url: "https://w.eyes.test" };
const now = () => new Date("2026-10-18T00:00:00Z");

function setup(worker: { id: string } | null = { id: "w1" }) {
  const { messaging } = fakeProviders();
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc = async <T>(fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return (fn === "eyes_worker" && worker ? [worker] : []) as T[];
  };
  const short = withShortLinks(messaging, rpc, config, now);
  const outbox = messaging.outbox as { payload: unknown }[];
  const stored = () => calls.filter((c) => c.fn === "eyes_add_short_link").map((c) => c.args);
  return { short, outbox, stored };
}

describe("withShortLinks", () => {
  it("swaps every link on our origins for a 33-character /s/ link and stores the full target", async () => {
    const { short, outbox, stored } = setup();
    const me = "https://w.eyes.test/me#c=abc.def";
    const pay = "https://api.eyes.test/w/connect/tok.sig";
    await short.sendText(
      "+15550000000",
      `1. Pay: ${pay}\nYour setup: ${me}. Join at https://w.eyes.test or https://x.test/a`,
    );
    const text = String(outbox.at(-1)?.payload);
    const links = text.match(/https:\/\/api\.eyes\.test\/s\/[0-9A-Za-z]{8}/g) ?? [];
    expect(links).toHaveLength(2);
    expect(links[0]?.length).toBeLessThanOrEqual(35);
    expect(text).toBe(
      `1. Pay: ${links[0]}\nYour setup: ${links[1]}. Join at https://w.eyes.test or https://x.test/a`,
    );
    expect(stored()).toEqual([
      {
        p_id: links[0]?.slice(-8),
        p_target: pay,
        p_worker_id: "w1",
        p_expires_at: "2026-10-25T00:00:00.000Z",
      },
      {
        p_id: links[1]?.slice(-8),
        p_target: me,
        p_worker_id: "w1",
        p_expires_at: "2026-10-25T00:00:00.000Z",
      },
    ]);
  });

  it("sends a text without our links unchanged and stores nothing", async () => {
    const { short, outbox, stored } = setup();
    await short.sendText("+15550000000", "Eyes: you're opted out. See https://x.test/a");
    expect(outbox.at(-1)?.payload).toBe("Eyes: you're opted out. See https://x.test/a");
    expect(stored()).toEqual([]);
  });

  it("shortens the capture and earnings links, and stores no worker for an unknown phone", async () => {
    const { short, outbox, stored } = setup(null);
    const capture = "https://w.eyes.test/capture.html?t=x.y";
    await short.sendCaptureLink("+15550000001", {
      task_id: "t1",
      place_label: "Cafe",
      capture_url: capture,
      deadline_at: "2026-10-18T01:00:00Z",
    });
    await short.sendPaid("+15550000001", {
      task_id: "t1",
      place_label: "Cafe",
      amount_cents: 500,
      earnings_url: "https://api.eyes.test/w/earnings/e.f",
      live_payouts: true,
    });
    const [sentCapture, sentPaid] = outbox.slice(-2).map((m) => m.payload as Record<string, string>);
    expect(sentCapture?.capture_url).toMatch(/^https:\/\/api\.eyes\.test\/s\/[0-9A-Za-z]{8}$/);
    expect(sentPaid?.earnings_url).toMatch(/^https:\/\/api\.eyes\.test\/s\/[0-9A-Za-z]{8}$/);
    expect(stored().map((a) => [a.p_target, a.p_worker_id])).toEqual([
      [capture, null],
      ["https://api.eyes.test/w/earnings/e.f", null],
    ]);
  });
});
