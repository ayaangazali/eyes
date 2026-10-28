import { createHmac, timingSafeEqual } from "node:crypto";
import type { Storage } from "@eyes/core";
import { createAdminClient } from "@insforge/sdk";

type Env = Record<string, string | undefined>;

export const PHOTO_URL_TTL_S = 3600;
// Keys are always `<task uuid>/<uuid>.jpg` (see submitCapture); the stored URL ends with one.
const KEY = /([0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg)$/i;

export function createInsforgeStorage(env: Env): Storage {
  const { INSFORGE_BASE_URL: baseUrl, INSFORGE_API_KEY: apiKey, EYES_PUBLIC_API_URL: publicUrl } = env;
  if (!baseUrl || !apiKey)
    throw new Error("INSFORGE_BASE_URL and INSFORGE_API_KEY are required for photo storage");
  const bucket = createAdminClient({ baseUrl, apiKey }).storage.from("photos");
  const mac = (key: string, exp: string) =>
    createHmac("sha256", apiKey).update(`${key}\n${exp}`).digest("hex");
  return {
    async putPhoto({ key, bytes, content_type }) {
      const { data, error } = await bucket.upload(
        key,
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: content_type }),
      );
      if (!data) throw error;
      return { url: data.url };
    },
    async deletePhoto({ key }) {
      const { error } = await bucket.remove(key);
      if (error) throw error;
    },
    // The bucket is private: agents and owners get a link to our own /photos route that expires.
    signPhoto(url) {
      const key = KEY.exec(decodeURIComponent(url))?.[1];
      if (!key || !publicUrl) return url;
      const exp = String(Math.floor(Date.now() / 1000) + PHOTO_URL_TTL_S);
      const q = new URLSearchParams({ k: key, exp, sig: mac(key, exp) });
      return `${publicUrl.replace(/\/+$/, "")}/photos?${q}`;
    },
    async readPhoto({ key, exp, sig }) {
      const good = Buffer.from(mac(key, exp));
      const given = Buffer.from(sig);
      if (!KEY.test(key) || Number(exp) * 1000 < Date.now()) return null;
      if (good.length !== given.length || !timingSafeEqual(good, given)) return null;
      const res = await fetch(
        `${baseUrl.replace(/\/+$/, "")}/api/storage/buckets/photos/objects/${encodeURIComponent(key)}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      );
      return res.ok && res.body ? res : null;
    },
  };
}
