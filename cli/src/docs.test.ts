import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { generateDocs, PUBLIC_DIR, writeDocs } from "./docs.ts";

const read = (file: string) => readFileSync(new URL(file, PUBLIC_DIR), "utf8");

it("committed docs/public files match a fresh generation (fix: pnpm --filter @eyes/cli gen:docs)", () => {
  for (const [file, content] of Object.entries(generateDocs(read("llms.txt")))) {
    if (typeof content === "string") expect(read(file), file).toBe(content);
    else expect(JSON.parse(read(file)), file).toEqual(content);
  }
});

it("writeDocs writes every generated file, pretty-printing JSON with a trailing newline", () => {
  const dir = mkdtempSync(join(tmpdir(), "eyes-docs-"));
  try {
    mkdirSync(join(dir, ".well-known"));
    writeDocs("# eyes\n", pathToFileURL(`${dir}/`));
    const docs = generateDocs("# eyes\n");
    expect(readFileSync(join(dir, "llms-full.txt"), "utf8")).toBe(docs["llms-full.txt"]);
    expect(readFileSync(join(dir, "openapi.json"), "utf8")).toBe(
      `${JSON.stringify(docs["openapi.json"], null, 2)}\n`,
    );
    expect(readFileSync(join(dir, ".well-known/agent-card.json"), "utf8")).toBe(
      `${JSON.stringify(docs[".well-known/agent-card.json"], null, 2)}\n`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
