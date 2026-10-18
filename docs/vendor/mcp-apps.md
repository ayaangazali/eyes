# MCP Apps widgets (MCP Apps spec, mcp-use views, ChatGPT Apps SDK) - vendor note

Fetched: 2026-10-17. Sources read:
- https://docs.mcp-use.com/llms.txt (page index)
- https://docs.mcp-use.com/v2/typescript/mcp-apps.md (overview: views, result channels)
- https://docs.mcp-use.com/v2/typescript/mcp-apps/quickstart.md
- https://docs.mcp-use.com/v2/typescript/mcp-apps/interactivity.md
- https://docs.mcp-use.com/v2/typescript/mcp-apps/content-security-policy.md
- https://docs.mcp-use.com/v2/typescript/mcp-apps/chatgpt-extensions.md (display modes, sizing)
- https://docs.mcp-use.com/typescript/api-reference/react/themeprovider.md
- MCP Apps spec: https://raw.githubusercontent.com/modelcontextprotocol/ext-apps/main/specification/2026-01-26/apps.mdx and the overview at https://apps.extensions.modelcontextprotocol.io/api/documents/Overview.html (modelcontextprotocol.github.io/ext-apps 301s there)
- OpenAI Apps SDK: https://developers.openai.com/apps-sdk/build/chatgpt-ui and https://developers.openai.com/apps-sdk/reference
- Local mcp-use docs clone (HEAD 8f84452b, 2026-09-20): `docs/v2/typescript/mcp-apps.mdx`, `mcp-apps/{interactivity,content-security-policy}.mdx`
- npm `mcp-use@2.10.0` as installed for `@eyes/mcp`: `dist/react/index.d.ts` and `dist/react/hooks/{use-tool-context,use-call-tool,use-view-theme,use-host-context,use-display-mode,use-send-size-changed}.d.ts`, `dist/react/runtime/view-config.d.ts`

## What Eyes uses it for
- `show_task` already renders `apps/mcp/views/task-card/view.tsx` (T4.30). W1 builds a richer task card in `apps/web/widget-task-card/` against a mock bridge; W2 wires it to a host through the APIs below.

## Model
- An MCP App is a `ui://` resource with MIME type `text/html;profile=mcp-app`, linked from a tool by `_meta.ui.resourceUri`. The host renders it in a sandboxed iframe behind a sandbox proxy on a different origin (spec, "Sandbox"; the sandbox gets `allow-scripts` and `allow-same-origin`).
- Lifecycle (spec): the view sends `ui/initialize`, gets the host context, then sends `ui/notifications/initialized`; the host sends nothing before that.
- mcp-use: a tool gets `view: { name }`, the name matches a folder `views/<name>/` holding `view.tsx` (default-exported React component, no props). "The View-bound tool must declare an `outputSchema`." "Each View can be bound to at most one tool." (mcp-apps.md)

## Receiving tool output
- Spec notifications host to view: `ui/notifications/tool-input`, `ui/notifications/tool-input-partial`, `ui/notifications/tool-result`, `ui/notifications/tool-cancelled`, `ui/notifications/host-context-changed`.
- Result channels (mcp-apps.md table): `content` goes to the model and the view (`content`); `structuredContent` goes to the model and the view as `toolOutput`; `_meta` goes to the view only, as `meta`. "Do not place secrets in any result channel."
- mcp-use hook: `useToolContext<"tool-name">()` returns `{ status: "pending" | "ready" | "error", toolInput, toolOutput, content, meta, error }`. It "latches the first structured success or tool error for the View's lifetime" (use-tool-context.d.ts), so one mounted view shows one result; later results do not replace it.
- ChatGPT alias: `window.openai.toolOutput` / `toolInput` / `toolResponseMetadata`, plus the `openai:set_globals` event. OpenAI says new UI should use the shared MCP Apps fields and bridge (chatgpt-ui page).

## Theme
- Spec host context: `theme` (`"light"` or `"dark"`), `styles.variables` (CSS custom properties such as `--color-background-primary`, `--color-text-primary`, `--font-sans`), `displayMode`, `containerDimensions`, `locale`. Views should use the variables with fallbacks, for example `var(--color-background-primary, #ffffff)` (overview).
- mcp-use: `useViewTheme()` returns `"light" | "dark"` and re-renders only on theme change; `"light"` until the host reports one (use-view-theme.d.ts). `useHostContext()` gives `theme`, `locale`, `maxHeight`, `maxWidth`, `hostCapabilities`, `isAvailable` and the raw `hostContext`.
- `ThemeProvider` sets `class` (`light`/`dark`), `data-theme` and `color-scheme` on `document.documentElement`, falls back to `prefers-color-scheme` when the host sends no theme, and applies `hostContext.styles.variables` (themeprovider.md).
- ChatGPT alias: `window.openai.theme`.

## Calling tools
- Spec: the view sends `tools/call`; the host proxies it to the server. Tools with `visibility: ["app"]` are callable by the view and hidden from the model (overview).
- mcp-use: `useCallTool("tool-name")` returns `{ callTool(args), data, error, isPending }`; `callTool` rejects with `ToolError` on `isError: true` and also stores it in `error` (interactivity.md, use-call-tool.d.ts). `useDynamicTool<Args, Result>(name)` is the untyped escape hatch. `toolResultText(result)` is exported for text content.
- Other view actions: `useSendFollowUp()` (spec `ui/message`, a user-authored prompt; check `hostCapabilities?.message`), `useOpenExternal()` (spec `ui/open-link`, check `hostCapabilities?.openLinks`), `useDisplayMode()` (spec `ui/request-display-mode`), `useViewTool()` (model calls into the mounted view).
- ChatGPT alias: `window.openai.callTool(name, args)`.

## CSP and domains
- Declared per resource in `_meta.ui.csp` with `connectDomains` (fetch, XHR, WebSocket), `resourceDomains` (scripts, images, styles, fonts, media), `frameDomains`, `baseUriDomains` (spec).
- Spec default when `csp` is omitted: `default-src 'none'`; scripts and styles `'self'` plus `'unsafe-inline'`; images and media `'self'` plus `data:`; `connect-src 'none'`. So a photo on InsForge needs its origin in `resourceDomains`, and a widget that fetches anything needs `connectDomains`.
- mcp-use: `view: { name, csp: { connectDomains, resourceDomains, frameDomains } }` on the tool. Merge order per `resources/read`: author `view.csp`, then `CSP_*_DOMAINS` / `CSP_URLS` env vars, then auto-append (`MCP_URL` to `connectDomains`, assets origin to `resourceDomains`) (content-security-policy.md). Inspector has a "Widget-Declared" CSP mode that enforces the declared CSP.
- `_meta.ui.domain`: dedicated sandbox origin, host-dependent format (spec). ChatGPT requires it for plugin submission and defaults it to `https://web-sandbox.oaiusercontent.com`; `openai/widgetCSP` and `openai/widgetDomain` are legacy aliases, with `openai/widgetCSP` still needed only for `redirect_domains` (reference page).
- `_meta.ui.prefersBorder`: `true` asks the host for a border and background, `false` for none (spec).

## Sizing
- Spec: the view reports its size with `ui/notifications/size-changed`; the host reports `containerDimensions` as `height` or `maxHeight` and `width` or `maxWidth`.
- mcp-use: `viewConfig.autoResize` defaults to `true` (ext-apps measures the document and reports size). Set it to `false` and call `useSendSizeChanged()` only when height derives from width (view-config.d.ts, use-send-size-changed.d.ts). `useHostContext().maxHeight` / `maxWidth` give the layout budget, `undefined` meaning unbounded.
- Display modes: `inline`, `fullscreen`, `pip`; ChatGPT supports `inline` and `fullscreen`. `viewConfig.displayModes` must include `inline`; `preferredDisplayMode` is a hint (chatgpt-extensions.md).
- ChatGPT alias: `window.openai.maxHeight`, `notifyIntrinsicHeight`.

## What this means for the Eyes card
- Read data from `useToolContext().toolOutput`, theme from `useViewTheme()`, call tools with `useCallTool`. These map onto `WidgetBridge.getToolOutput`, `getTheme` and `callTool`.
- Keep `autoResize` on: the card's height follows its content, not its width.
- Keep the card free of network calls; only the photo needs a CSP entry, the InsForge origin in `resourceDomains`.
- Treat every string in the result as untrusted text.
