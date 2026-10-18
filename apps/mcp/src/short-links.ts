import { randomBytes } from "node:crypto";
import type { Messaging } from "@eyes/core";
import type { Rpc } from "@eyes/db";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LINK_MS = 7 * 24 * 3_600_000;

/**
 * Live texts carry `<api>/s/<id>` (about 33 characters) instead of ~200-character signed URLs.
 * Only URLs on our own origins are shortened; the target keeps its token (and #c= fragment), is
 * stored for the redirect, and is never logged. The target's own expiry still applies.
 */
export function withShortLinks(
  messaging: Messaging,
  rpc: Rpc,
  config: { public_api_url: string; worker_web_url: string },
  now: () => Date,
): Messaging {
  const origins = [config.public_api_url, config.worker_web_url].map((o) =>
    o.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
  );
  const ours = new RegExp(`(?:${origins.join("|")})/\\S*[^\\s.,)]`, "g");
  const shorten = async (to: string, url: string) => {
    const worker = (await rpc<{ id: string }>("eyes_worker", { p_worker_id: null, p_phone: to }))[0];
    // ponytail: modulo bias over 62 symbols is tiny; 8 symbols is ~47 bits against guessing.
    const id = Array.from(randomBytes(8), (b) => BASE62[b % 62]).join("");
    await rpc("eyes_add_short_link", {
      p_id: id,
      p_target: url,
      p_worker_id: worker?.id ?? null,
      p_expires_at: new Date(now().getTime() + LINK_MS).toISOString(),
    });
    return `${config.public_api_url}/s/${id}`;
  };
  return {
    ...messaging,
    sendText: async (to, body) => {
      let text = body;
      for (const url of body.match(ours) ?? []) text = text.replace(url, await shorten(to, url));
      return messaging.sendText(to, text);
    },
    sendCaptureLink: async (to, msg) =>
      messaging.sendCaptureLink(to, { ...msg, capture_url: await shorten(to, msg.capture_url) }),
    sendPaid: async (to, msg) =>
      messaging.sendPaid(to, { ...msg, earnings_url: await shorten(to, msg.earnings_url) }),
  };
}
