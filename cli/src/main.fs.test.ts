import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type Deps, run } from "./main.ts";

const disk = vi.hoisted(() => ({ full: false }));

// Only the exclusive pending-record create fails, the way a full disk fails it.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      const options = args[2] as { flag?: string } | undefined;
      if (disk.full && options?.flag === "wx") {
        return Promise.reject(
          Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }),
        );
      }
      return actual.writeFile(...args);
    },
  };
});

it("an ask that cannot create its pending record sends nothing and says so", async () => {
  const calls: string[] = [];
  const errs: string[] = [];
  const deps: Deps = {
    fetch: async (url) => {
      calls.push(String(url));
      return new Response("{}", { status: 200 });
    },
    env: { EYES_API_URL: "https://eyes.test", EYES_API_KEY: "eyes_env_key" },
    configPath: join(mkdtempSync(join(tmpdir(), "eyes-fs-")), "eyes", "config.json"),
    out: () => {},
    err: (line) => errs.push(line),
    sleep: async () => {},
    now: () => 0,
  };
  disk.full = true;
  try {
    expect(
      await run(
        ["ask", "How long is the line?", "--at", "Ferry Building, San Francisco", "--type", "line_length"],
        deps,
      ),
    ).toBe(1);
  } finally {
    disk.full = false;
  }
  expect(calls).toEqual([]);
  expect(errs.join("\n")).toContain("ENOSPC");
  expect(errs.join("\n")).toContain("Nothing was sent");
});
