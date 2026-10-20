# @eyes/ui

The Eyes design system: CSS tokens, shared components, the icon sprite, the site header, and the styles for server-rendered pages.
It has no runtime dependencies and no build step.
The sources and tests live in `src/`; the public import paths below do not include `src`.

## Exports

From `package.json`:

- `@eyes/ui/tokens.css`: design tokens (colors, type, spacing, motion), light and dark.
- `@eyes/ui/components.css`: shared component classes, for example `.ui-site-head`.
- `@eyes/ui/tailwind.css`: the Tailwind 4 entry. It loads the tokens and components and maps them to Tailwind theme names.
- `@eyes/ui/chatgpt.css`: points the Eyes tokens at the host variables inside a ChatGPT app widget. Do not load it with `tailwind.css`.
- `@eyes/ui/icons.svg`: the SVG icon sprite.
- `@eyes/ui/header`: `siteHeader({ home, nav, cta })` returns the site header HTML.
- `@eyes/ui/page`: `PAGE_CSS` (tokens, components, and a page skeleton in one string) and `PAGE_HEADER` for HTML pages that the API renders.

## Use in the repo

- `apps/web/landing` and `apps/web/worker` import `tailwind.css`, `siteHeader`, and the icon sprite.
- `apps/mcp` and `packages/payments` use `PAGE_CSS` and `PAGE_HEADER` for their server-rendered pages.
- `apps/mcp/src/widget.ts` inlines `tokens.css`, `components.css`, and `icons.svg`.

## Tests

```sh
pnpm vitest run --project unit packages/ui
```

## See also

- [Architecture](../../docs/architecture.md)
- [Contributing](../../CONTRIBUTING.md)
