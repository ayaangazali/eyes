import { afterEach, describe, expect, it, vi } from "vitest";
import { createInsforgeStorage } from "./storage.ts";

const env = { INSFORGE_BASE_URL: "https://eyes.us-west.insforge.app", INSFORGE_API_KEY: "ik_test_key" };
const base = env.INSFORGE_BASE_URL;
const strategyUrl = `${base}/api/storage/buckets/photos/upload-strategy`;
const photo = { key: "task-1/a.jpg", bytes: new Uint8Array([1, 2, 3]), content_type: "image/jpeg" };

function stubFetch(status: number, body: unknown) {
  const fetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("createInsforgeStorage().deletePhoto", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends DELETE for the encoded object key in the photos bucket with the admin key", async () => {
    const fetch = stubFetch(200, { message: "Object deleted successfully" });
    await createInsforgeStorage(env).deletePhoto({ key: "task-1/photo 1.jpg" });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://eyes.us-west.insforge.app/api/storage/buckets/photos/objects/task-1%2Fphoto%201.jpg",
    );
    expect(init).toMatchObject({ method: "DELETE", headers: { Authorization: "Bearer ik_test_key" } });
  });

  it("rejects when InsForge refuses the delete", async () => {
    stubFetch(404, { error: "STORAGE_NOT_FOUND", message: "Object not found", statusCode: 404 });
    await expect(createInsforgeStorage(env).deletePhoto({ key: "task-1/gone.jpg" })).rejects.toThrow(
      "Object not found",
    );
  });
});

describe("createInsforgeStorage().putPhoto", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses to build without the InsForge base URL and key", () => {
    expect(() => createInsforgeStorage({ INSFORGE_API_KEY: "ik_test_key" })).toThrow(
      "INSFORGE_BASE_URL and INSFORGE_API_KEY are required for photo storage",
    );
    expect(() => createInsforgeStorage({ INSFORGE_BASE_URL: base })).toThrow(
      "INSFORGE_BASE_URL and INSFORGE_API_KEY are required for photo storage",
    );
  });

  it("uploads through a presigned URL and returns the public object URL", async () => {
    const s3 = "https://s3.example.test/upload";
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === strategyUrl) {
        return json({ method: "presigned", uploadUrl: s3, key: photo.key, fields: { policy: "p1" } });
      }
      if (url === s3) return new Response(null, { status: 204 });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    const out = await createInsforgeStorage(env).putPhoto(photo);

    expect(out).toEqual({ url: `${base}/api/storage/buckets/photos/objects/task-1%2Fa.jpg` });
    const s3Call = fetch.mock.calls.find(([url]) => url === s3);
    const body = s3Call?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("policy")).toBe("p1");
  });

  it("uploads directly when InsForge asks for a direct PUT and returns the URL it reports", async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === strategyUrl) return json({ method: "direct" });
      if (url === `${base}/api/storage/buckets/photos/objects/task-1%2Fa.jpg`) {
        return json({ url: "https://cdn.example.test/a.jpg" });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    const out = await createInsforgeStorage(env).putPhoto(photo);

    expect(out).toEqual({ url: "https://cdn.example.test/a.jpg" });
    const put = fetch.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(put?.[1]?.body).toBeInstanceOf(FormData);
  });

  it("throws when the presigned storage upload is refused", async () => {
    const s3 = "https://s3.example.test/upload";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === strategyUrl) return json({ method: "presigned", uploadUrl: s3, key: photo.key });
        return new Response("denied", { status: 403, statusText: "Forbidden" });
      }),
    );
    await expect(createInsforgeStorage(env).putPhoto(photo)).rejects.toThrow(
      "Upload to storage failed: Forbidden",
    );
  });

  it("throws when InsForge will not issue an upload strategy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ message: "storage quota exceeded" }, 507)),
    );
    await expect(createInsforgeStorage(env).putPhoto(photo)).rejects.toThrow();
  });

  it("throws on an upload method the SDK does not know", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ method: "carrier-pigeon" })),
    );
    await expect(createInsforgeStorage(env).putPhoto(photo)).rejects.toThrow(
      "Unsupported upload method: carrier-pigeon",
    );
  });
});

describe("createInsforgeStorage signed photo links", () => {
  const key = "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg";
  const storage = createInsforgeStorage({ ...env, EYES_PUBLIC_API_URL: "https://api.test" });
  const parts = (signed: string) => {
    const u = new URL(signed);
    return {
      key: u.searchParams.get("k") ?? "",
      exp: u.searchParams.get("exp") ?? "",
      sig: u.searchParams.get("sig") ?? "",
    };
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("serves a signed link until it expires, then refuses it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetch = stubFetch(200, {});
    const signed = storage.signPhoto(`${base}/api/storage/buckets/photos/objects/${encodeURIComponent(key)}`);
    expect(signed.startsWith("https://api.test/photos?")).toBe(true);
    expect(await storage.readPhoto(parts(signed))).not.toBeNull();
    expect(fetch.mock.calls[0]?.[0]).toContain(`/buckets/photos/objects/${encodeURIComponent(key)}`);
    vi.setSystemTime(Date.now() + 3601_000);
    expect(await storage.readPhoto(parts(signed))).toBeNull();
  });

  it("refuses a tampered key or signature without reading the bucket", async () => {
    const fetch = stubFetch(200, {});
    const p = parts(storage.signPhoto(`${base}/photos/${key}`));
    const other = key.replace("1111", "3333");
    expect(await storage.readPhoto({ ...p, key: other })).toBeNull();
    expect(await storage.readPhoto({ ...p, sig: "0".repeat(64) })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns the stored URL unsigned when it has no photo key or no public API URL is set", () => {
    expect(storage.signPhoto("https://x.test/legacy.jpg")).toBe("https://x.test/legacy.jpg");
    const bare = createInsforgeStorage(env);
    expect(bare.signPhoto(`${base}/photos/${key}`)).toBe(`${base}/photos/${key}`);
  });

  it("returns null when the bucket no longer has the object", async () => {
    const p = parts(storage.signPhoto(`${base}/photos/${key}`));
    stubFetch(404, { error: "STORAGE_NOT_FOUND" });
    expect(await storage.readPhoto(p)).toBeNull();
  });
});
