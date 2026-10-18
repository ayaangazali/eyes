import { createHmac, timingSafeEqual } from "node:crypto";
import type { LatLng } from "./schemas.ts";

export const usdToCents = (usd: number): number => Math.round(usd * 100);
export const centsToUsd = (cents: number): number => cents / 100;

const EARTH_RADIUS_M = 6_371_000;

const COORDS = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/**
 * A place label people can read. Agents that ask by coordinates get a "lat,lng" label; people see it
 * as "Near 37.761, -122.386", rounded to 3 decimals (about 100 m) so pages never show exact points.
 */
export function placeName(label: string): string {
  const m = COORDS.exec(label);
  return m ? `Near ${Number(m[1]).toFixed(3)}, ${Number(m[2]).toFixed(3)}` : label;
}

export function distanceMeters(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("base64url");

export function signToken(secret: string, payload: string, expiresAt?: Date): string {
  const body = Buffer.from(JSON.stringify({ p: payload, e: expiresAt?.getTime() ?? null })).toString(
    "base64url",
  );
  return `${body}.${sign(secret, body)}`;
}

export function verifyToken(secret: string, token: string, now = new Date()): string | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const { p, e } = JSON.parse(Buffer.from(body, "base64url").toString()) as { p: string; e: number | null };
  if (e !== null && now.getTime() > e) return null;
  return p;
}

const emailMac = (secret: string, agentId: string) => sign(secret, `e:${agentId}`).slice(0, 16);

export function agentEmailAddress(secret: string, agentId: string, domain: string): string {
  return `ask+${agentId.replaceAll("-", "")}-${emailMac(secret, agentId)}@${domain}`;
}

export function agentIdFromEmailAddress(secret: string, address: string): string | null {
  const m = address
    .trim()
    .toLowerCase()
    .match(/^ask\+([0-9a-f]{32})-([a-z0-9_-]{16})@/);
  if (!m?.[1] || !m[2]) return null;
  const h = m[1];
  const agentId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  const expected = Buffer.from(emailMac(secret, agentId).toLowerCase());
  const given = Buffer.from(m[2]);
  return expected.length === given.length && timingSafeEqual(expected, given) ? agentId : null;
}

const URLISH = /(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:[/?]\S*)?/gi;
const PAIR = /^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/;
// Copied coordinates have 4-6 decimals; 3+ keeps prices like "4.50, 3.20" from moving a spot.
const PLAIN_PAIR = /(?<![\w.-])-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}(?![\w.])/;

// Same checks as POST /w/location: in range, and not 0,0.
function pin(value: string | null | undefined): LatLng | null {
  const m = value ? PAIR.exec(value.trim()) : null;
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0) ? { lat, lng } : null;
}

/**
 * Coordinates from an Apple or Google Maps link, or a plain "lat, lng" decimal pair, anywhere in a text.
 * Never fetches anything: short links (maps.app.goo.gl, goo.gl/maps) carry no coordinates, so they
 * come back as "short_link".
 */
export function parseMapLink(text: string): LatLng | "short_link" | null {
  let short = false;
  for (const [raw] of text.matchAll(URLISH)) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      continue;
    }
    const host = url.hostname.replace(/^www\./, "");
    const q = (key: string) => url.searchParams.get(key);
    if (host === "maps.app.goo.gl" || (host === "goo.gl" && url.pathname.startsWith("/maps"))) short = true;
    const candidates =
      host === "maps.apple.com"
        ? [q("coordinate"), q("ll"), q("q"), q("sll")]
        : /^(maps\.)?google\.[a-z.]+$/.test(host) &&
            (host.startsWith("maps.") || url.pathname.startsWith("/maps"))
          ? [/\/@([^/]+)/.exec(url.pathname)?.[1], q("q"), q("query"), q("ll")]
          : [];
    const found = candidates.map(pin).find((p) => p !== null);
    if (found) return found;
  }
  return pin(PLAIN_PAIR.exec(text.replace(URLISH, " "))?.[0]) ?? (short ? "short_link" : null);
}
