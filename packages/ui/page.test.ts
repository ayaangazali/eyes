import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAGE_CSS, PAGE_HEADER } from "./page.ts";

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

describe("PAGE_CSS", () => {
  it("inlines tokens, then components, then the page skeleton, in that order", () => {
    const tokens = read("tokens.css");
    const components = read("components.css");
    expect(PAGE_CSS.startsWith(tokens)).toBe(true);
    expect(PAGE_CSS.slice(tokens.length, tokens.length + components.length)).toBe(components);
    // SKELETON opens with a newline, so the page skeleton starts one char after the components.
    expect(PAGE_CSS.slice(tokens.length + components.length)).toMatch(/^\nbody\.ui\{/);
  });

  it("styles the page skeleton with the design tokens it depends on", () => {
    expect(PAGE_CSS).toContain("var(--eyes-surface)");
    expect(PAGE_CSS).toContain(".page-head{");
    expect(PAGE_CSS).toContain(".page h1{");
  });

  it("honours reduced motion for buttons", () => {
    expect(PAGE_CSS).toMatch(
      /@media \(prefers-reduced-motion:reduce\)\{\.page \.button,\.page button\{transition:none\}\}/,
    );
  });
});

describe("PAGE_HEADER", () => {
  it("links the wordmark to the home page and hides the decorative mark", () => {
    expect(PAGE_HEADER.startsWith('<header class="page-head">')).toBe(true);
    expect(PAGE_HEADER).toContain('href="https://eyes.pictures"');
    expect(PAGE_HEADER).toContain('<span class="mark" aria-hidden="true"></span>');
    expect(PAGE_HEADER).toContain(">Eyes</a></header>");
  });
});
