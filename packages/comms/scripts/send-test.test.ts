import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TEXT, sendTest, USAGE } from "./send-test.ts";

const PHONE = "+14155550123";
const env = { INKBOX_API_KEY: "test-key" } as NodeJS.ProcessEnv;

function fake(outcome: { id: string } | Error = { id: "msg_1" }) {
  const sendText = vi.fn(async (_to: string, _text: string) => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const make = vi.fn((_env: NodeJS.ProcessEnv) => ({ sendText }));
  return { make, sendText };
}

describe("sendTest", () => {
  it("sends the default text when only a phone number is given", async () => {
    const { make, sendText } = fake();
    await sendTest([PHONE], env, make);
    expect(sendText).toHaveBeenCalledWith(PHONE, DEFAULT_TEXT);
  });

  it("sends the text argument when one is given", async () => {
    const { make, sendText } = fake();
    await sendTest([PHONE, "Hello there"], env, make);
    expect(sendText).toHaveBeenCalledWith(PHONE, "Hello there");
  });

  it("returns a one-line receipt with the queued message id", async () => {
    const { make } = fake({ id: "msg_42" });
    await expect(sendTest([PHONE], env, make)).resolves.toBe("queued msg_42");
  });

  it("builds the messaging client from the environment it is given", async () => {
    const { make } = fake();
    await sendTest([PHONE], env, make);
    expect(make).toHaveBeenCalledWith(env);
  });

  it("rejects with the usage line when no phone number is given", async () => {
    const { make, sendText } = fake();
    await expect(sendTest([], env, make)).rejects.toThrow(USAGE);
    expect(make).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("treats an empty phone number as missing", async () => {
    const { make } = fake();
    await expect(sendTest(["", "hi"], env, make)).rejects.toThrow(USAGE);
    expect(make).not.toHaveBeenCalled();
  });

  it("propagates provider errors unchanged", async () => {
    const { make } = fake(new Error("rate limited"));
    await expect(sendTest([PHONE], env, make)).rejects.toThrow("rate limited");
  });
});
