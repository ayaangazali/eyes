import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

it("keeps local links in the hackathon records reachable after archiving", () => {
  for (const name of ["STATUS", "PLAN", "DEMO", "SUBMISSION", "hackathon"]) {
    const file = resolve(root, "docs/archive/hackathon", `${name}.md`);
    const text = readFileSync(file, "utf8");
    for (const [, target] of text.matchAll(/\]\(([^\s)]+)\)/g)) {
      if (!target || /^(?:[a-z]+:|#)/i.test(target)) continue;
      const path = decodeURIComponent(target.split("#")[0] ?? "");
      expect(existsSync(resolve(dirname(file), path)), `${name}.md: ${target}`).toBe(true);
    }
  }
});
