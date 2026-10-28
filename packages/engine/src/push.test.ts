import { expect, it, vi } from "vitest";
import { createPusher } from "./push.ts";

const reply = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });

it("posts one message per token to Expo", async () => {
  const rpc = vi.fn().mockResolvedValueOnce([{ token: "ExponentPushToken[a]" }]);
  const send = vi.fn().mockResolvedValue(reply([{ status: "ok" }]));
  await createPusher(rpc as never, send)({ agentId: "a1" }, { title: "T", body: "B" });
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]?.[0]).toBe("https://exp.host/--/api/v2/push/send");
  expect(JSON.parse(send.mock.calls[0]?.[1].body)).toEqual([
    { to: "ExponentPushToken[a]", sound: "default", title: "T", body: "B" },
  ]);
  expect(rpc).toHaveBeenCalledTimes(1);
});

it("removes only the token Expo reports as DeviceNotRegistered", async () => {
  const rpc = vi
    .fn()
    .mockResolvedValueOnce([{ token: "ExponentPushToken[a]" }, { token: "ExponentPushToken[b]" }])
    .mockResolvedValue([]);
  const send = vi
    .fn()
    .mockResolvedValue(
      reply([{ status: "ok" }, { status: "error", details: { error: "DeviceNotRegistered" } }]),
    );
  await createPusher(rpc as never, send)({ workerIds: ["w"] }, { title: "T", body: "B" });
  expect(rpc).toHaveBeenLastCalledWith("eyes_remove_push_tokens", { p_tokens: ["ExponentPushToken[b]"] });
});

it("swallows an Expo outage and keeps the tokens", async () => {
  const rpc = vi.fn().mockResolvedValueOnce([{ token: "ExponentPushToken[a]" }]);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const send = vi.fn().mockResolvedValue(reply([], 503));
  await expect(
    createPusher(rpc as never, send)({ workerIds: ["w"] }, { title: "T", body: "B" }),
  ).resolves.toBeUndefined();
  expect(rpc).toHaveBeenCalledTimes(1);
});

it("logs a non-Error failure as unknown", async () => {
  const rpc = vi.fn().mockRejectedValue("boom");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await createPusher(rpc as never, vi.fn())({ agentId: "a" }, { title: "T", body: "B" });
  expect(log).toHaveBeenCalledWith("push failed: unknown");
});
