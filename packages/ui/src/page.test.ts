import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { siteHeader } from "./header.ts";
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
    expect(PAGE_CSS).toContain(".page h1{");
  });

  it("lines the site header up with the page column and loads the display face from the API", () => {
    expect(PAGE_CSS).toContain("--ui-column:40rem}");
    expect(PAGE_CSS).toContain(".page{max-width:var(--ui-column);");
    expect(PAGE_CSS).toContain('font-family:"Instrument Sans Variable"');
    expect(PAGE_CSS).toContain("src:url(/fonts/instrument-sans.woff2)");
  });

  it("honours reduced motion for buttons: the press scale is a token that reduced motion sets to 1", () => {
    expect(PAGE_CSS).toContain("transform:scale(var(--eyes-press-scale))");
    expect(PAGE_CSS).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{\s*:root,\s*\[data-theme\]\s*\{\s*--eyes-press-scale: 1;/,
    );
  });
});

describe("siteHeader", () => {
  it("links the wordmark home, hides the decorative mark, and is the API pages' header", () => {
    expect(PAGE_HEADER).toBe(siteHeader());
    expect(PAGE_HEADER).toBe(
      '<header class="ui-site-head"><div class="ui-site-head__inner"><a class="ui-site-head__home" href="https://eyes.pictures"><span class="ui-mark" aria-hidden="true"></span>Eyes</a></div></header>',
    );
  });

  it("puts the nav, then the call to action, after the wordmark", () => {
    const html = siteHeader({ home: "/", nav: "<nav>N</nav>", cta: '<a class="ui-button">C</a>' });
    expect(html).toContain('<a class="ui-site-head__home" href="/">');
    expect(html).toMatch(/Eyes<\/a><nav>N<\/nav><a class="ui-button">C<\/a><\/div><\/header>$/);
  });
});
