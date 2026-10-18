import { describe, expect, it, vi } from "vitest";

// index.ts must load the background task before it registers the root component: iOS relaunches the
// JS bundle in the background for that task, and the task has to exist before React mounts.
const { order, register } = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    register: vi.fn((component: unknown) => {
      order.push("register");
      return component;
    }),
  };
});

vi.mock("expo", () => ({ registerRootComponent: register }));
vi.mock("./App", () => ({ default: "APP_COMPONENT" }));
vi.mock("./src/background.ts", () => {
  order.push("background");
  return {};
});

describe("mobile entry", () => {
  it("loads the background task before registering App as the root component", async () => {
    await import("./index.ts");
    expect(order).toEqual(["background", "register"]);
    expect(register).toHaveBeenCalledWith("APP_COMPONENT");
  });
});
