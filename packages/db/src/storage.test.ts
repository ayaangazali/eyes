import { afterEach, describe, expect, it, vi } from "vitest";
import { createInsforgeStorage } from "./storage.ts";

const env = { INSFORGE_BASE_URL: "https://eyes.us-west.insforge.app", INSFORGE_API_KEY: "ik_test_key" };

function stubFetch(status: number, body: unknown) {
  const fetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
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
    stubFetch(404, { error: "OBJECT_NOT_FOUND", message: "Object not found", statusCode: 404 });
    await expect(createInsforgeStorage(env).deletePhoto({ key: "task-1/gone.jpg" })).rejects.toThrow(
      "Object not found",
    );
  });
});
