import type { Storage } from "@eyes/core";
import { createAdminClient } from "@insforge/sdk";

type Env = Record<string, string | undefined>;

export function createInsforgeStorage(env: Env): Storage {
  const { INSFORGE_BASE_URL: baseUrl, INSFORGE_API_KEY: apiKey } = env;
  if (!baseUrl || !apiKey)
    throw new Error("INSFORGE_BASE_URL and INSFORGE_API_KEY are required for photo storage");
  const bucket = createAdminClient({ baseUrl, apiKey }).storage.from("photos");
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
  };
}
