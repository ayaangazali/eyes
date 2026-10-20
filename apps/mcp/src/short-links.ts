import { randomBytes } from "node:crypto";
import type { Messaging } from "@eyes/core";
import type { Rpc } from "@eyes/db";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LINK_MS = 7 * 24 * 3_600_000;

/**
 * Shorten links without #c= codes; keep codes out of short_links.
 * Stored targets keep their tokens and expiry, and are never logged.
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
    if (url.includes("#c=")) return url;
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
      // An /s/ link is already short (the engine stores mailto links itself).
      for (const url of body.match(ours) ?? [])
        if (!url.startsWith(`${config.public_api_url}/s/`)) text = text.replace(url, await shorten(to, url));
      return messaging.sendText(to, text);
    },
    sendCaptureLink: async (to, msg) =>
      messaging.sendCaptureLink(to, { ...msg, capture_url: await shorten(to, msg.capture_url) }),
    sendPaid: async (to, msg) => messaging.sendPaid(to, { ...msg, me_url: await shorten(to, msg.me_url) }),
  };
}
