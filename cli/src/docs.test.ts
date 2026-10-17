import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { generateDocs, PUBLIC_DIR } from "./docs.ts";

const read = (file: string) => readFileSync(new URL(file, PUBLIC_DIR), "utf8");

it("committed docs/public files match a fresh generation (fix: pnpm --filter @eyes/cli gen:docs)", () => {
  for (const [file, content] of Object.entries(generateDocs(read("llms.txt")))) {
    if (typeof content === "string") expect(read(file), file).toBe(content);
    else expect(JSON.parse(read(file)), file).toEqual(content);
  }
});
