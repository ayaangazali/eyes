# Eyes task card widget (W1, placeholder)

One compact card prototype for MCP Apps hosts (ChatGPT, Claude). This package runs on fixture data and a mock bridge only. It is **not registered in the MCP server**, makes no network calls, and nothing outside this folder imports it. Current state-v2 server source binds `show_task` to the same vanilla `ui://eyes/scene-card-v2.html` widget as `get_task`, implemented in [`apps/mcp/src/widget.ts`](../../mcp/src/widget.ts). The former `apps/mcp/views/task-card/` React view and its build are gone; this prototype is not the live card.

## Run it

```sh
pnpm install
pnpm --filter @eyes/widget-task-card preview
pnpm --filter @eyes/widget-task-card shots
pnpm exec vitest run --project unit apps/web/widget-task-card
```

`preview` starts the Vite dev server and opens `/preview/`. `shots` rewrites `docs/manufact/widget/*.png`. The last line runs the widget's unit tests.

The preview shows all ten states in a 320px and a 420px column, a Dark/Light toggle (the first theme follows the OS), and a demo card at the top. **Demo play** steps that card through quote, dispatched, claimed, verifying and answered every 1.8 s, for screen recording. Buttons call the mock bridge, which logs the call to the console and shows it in a toast, such as `Mock call: dispute_answer {"task_id":"...","reason":"Disputed from the Eyes task card"}`.

`shots` starts Vite in-process, screenshots every state at 420px in light and dark (plus the answered state at 320px) with headless Chromium, clicks Dispute to check the toast, fails if the page requests anything off the dev server, and closes everything it started.

## Files

| Path | What |
|---|---|
| `src/types.ts` | `CardData`, the adapter shape the card renders: core `quote_task` / `get_task` / `ask_eyes` types plus the fields core does not have yet. |
| `src/card.ts` | `cardView(data, key)` turns `CardData` into what the card shows (pill, media, lines, badges, footer, buttons and their tool calls); `cardTree` renders a view and wires each button to `bridge.callTool` and the toast; `TaskCard` holds the React state (bridge snapshot, theme, idempotency key, toast) and calls `cardTree`. |
| `src/card.css` | Flat styles, light and dark tokens keyed on `data-theme`, reduced-motion guard on the pulse. |
| `src/photo.ts` | `safePhotoUrl`: the photo allowlist. |
| `src/bridge.ts` | `WidgetBridge`, `MockBridge`, `HostBridge` stub. |
| `fixtures/*.json` | One snapshot per state; `fixtures/index.ts` names them in display order. |
| `preview/` | The preview page. |
| `scripts/shots.ts` | The screenshot script. |
| `src/card.test.ts` | Unit tests, run by the root Vitest `unit` project. |

## Why the components are `.ts`, not `.tsx`

The tests must render the card, and the root Vitest `unit` project only picks up `*.test.ts`. A `.test.ts` that imports a `.tsx` pulls it into the root `pnpm typecheck`, which has no `jsx` option and fails with `TS6142: Module './card.tsx' was resolved to ..., but '--jsx' is not set`. Changing the root tsconfig is out of scope, so the components call `React.createElement` (as `h`) in plain `.ts`. The side effect is good: the root typecheck now covers every line of the widget, and neither Vite nor Vitest needs a JSX transform or plugin. The proposed W2 React-view integration below was not deployed; the live card uses vanilla HTML.

## States

| State | From | Pill | Shows | Buttons |
|---|---|---|---|---|
| quote | `kind: "quote"` | Quote | "3 workers nearby, ~5 min, $3.50", map | Confirm $3.50 |
| cached | `kind: "cached"` | Cached | cached answer, photo, badges, "Checked 4 min ago, free" | Request fresh check ($3.50) |
| dispatched | task `dispatched` | Dispatched | map, pulse dot, "3 workers notified" | |
| claimed | task `claimed` | On the way | map, "Worker 120 m away, walking over", ETA | |
| verifying | task `submitted` | Verifying | photo, answer, amber badges | |
| answered | task `verified` / `paid` | Verified | photo, answer, badges, "$3.50 total, answered in 4 min" | Tip, Dispute |
| needs_review | task `needs_review` / `disputed` | Needs review / Disputed | amber pill, vision reason, "Payout held, under review" | Dispute (not when disputed) |
| expired_refunded | task `expired` / `refunded` | Refunded | "No one available. $3.50 refunded." (or "Cancelled.") | |
| rejected_safety | `kind: "rejected"` | Can't check | "Eyes only checks public places. Try a store, venue, or line." plus the reason | |
| error | `kind: "error"` | Error | "Eyes hit a snag. Try again in a moment." plus the message | Retry |

A Sandbox pill shows whenever `sandbox` is true. Badges: green passed, amber pending, red failed, each with a ✓ / … / ✕ glyph and screen-reader text so colour is never the only signal.

## Bridge

`WidgetBridge` is `callTool(name, args)` (resolves to the toast text), `getToolOutput()`, `onUpdate(cb)` (returns an unsubscribe, the shape `useSyncExternalStore` wants) and `getTheme()`.

`MockBridge` records every call in `calls`, logs `Mock call: <tool> <args as JSON>` with `console.info`, and resolves that line as the toast text. Button calls:

- Confirm $3.50 and Request fresh check: `ask_eyes` with the fixture's ask args plus an `idempotency_key` made once per mounted card, so a double click is one charge.
- Dispute: `dispute_answer` with `{ task_id, reason: "Disputed from the Eyes task card" }`.
- Retry: the failed call stored in the error snapshot, unchanged (an `ask_eyes` retry keeps its original key).
- Tip: `tip_worker` with `{ task_id }`. **`tip_worker` is not an Eyes tool.** It is a local intent so the button has something to log; W2 must decide whether tipping exists before wiring it.

`HostBridge` is a stub: every method throws `Error("W2: HostBridge is not wired to the MCP Apps host yet")`.

## Security

- Every worker- or agent-supplied string (answer text, vision reason, refusal reason, error message) is a React text child. The package has no `dangerouslySetInnerHTML` and no `innerHTML`.
- `safePhotoUrl` shows a photo only when the URL parses with origin exactly `https://7t6779x4.us-east.insforge.app`, has no username or password, and its path is `/api/storage/buckets/photos/objects/` followed by exactly the engine's key shape, `<task uuid>/<uuid>.jpg` (`packages/engine/src/index.ts`), with the `/` written literally or as `%2F`, since the InsForge SDK builds object URLs with `encodeURIComponent(key)`; the bundled fixture photo is the exact string `fixture:line-photo`. Anything else (other hosts, `http:`, `javascript:`, `data:`, protocol-relative, relative, credentials, other ports, look-alike or IDN hosts, backslashes, `../` out of the bucket, percent-encoded traversal such as `..%2f` or `%252e%252e/`, `%5c`, any other key shape, empty keys) shows the map placeholder. The `<img>` sends no referrer, and one that fails to load also falls back to the placeholder.
- No fetch, fonts, external images or scripts. The map and the sample photo are inline SVG.

## Historical W2 proposal (not deployed)

Core gaps, each carried by a local field in `CardData` today:

- `sandbox`: the T4.29 sandbox is a separate server (`EYES_SANDBOX=1`). Its `ask_eyes` and `await_answer` `next_step` start with the sandbox sentence, but `get_task` and `quote_task` carry no flag, so W2 needs a server-level signal. Sandbox `photo_url`s point at `storage.fake.test`, which the allowlist rejects, so sandbox cards show the map.
- `as_of`: the card computes "2 min ago" against the snapshot time; W2 sets it when the tool result arrives.
- `fee_usd` on quotes: `quote_task` returns `suggested_bounty_usd` but not the fee, so the quote total needs the 0.50 USD fee from somewhere.
- `workers_notified` on a task: `ask_eyes` returns it, `get_task` does not.
- `worker.distance_m` and `worker.eta_minutes` while claimed: core has no live worker position or ETA.
- `kind: "cached"` (`checked_at`, cached `answer`): core has no cached checks.
- `kind: "rejected"`: an `unsafe_task` error from `ask_eyes`, or `quote_task` with `allowed: false`; but `allowed: false` also covers balance and cap limits, and core gives no machine-readable code to tell a safety refusal apart.
- `ask` on quote and cached cards (question, bounty, deadline, photo flag): no core source, because `quote_task` input is only `{ location, task_type }`; W2 has to carry the agent's intended `ask_eyes` args alongside the quote.
- `kind: "error"` with `retry`: the host bridge must remember the failed call to retry it. In W2, Retry must accept only the expected tool names, validate the args with `TOOLS[name].input` before sending, and show the amount on the button when the retry spends money (an `ask_eyes` retry).
- Verifying badges: core sets `gps_ok`, `fresh_ok` and `vision_ok` at submission; the card shows them amber while the status is `submitted`.
- Tip: `tip_worker` does not exist.
- Dispute reason is a fixed string; W2 should collect one, or use `sendFollowUp` so the model asks the user.

Wiring:

- `HostBridge`: `getToolOutput` maps `useToolContext().toolOutput` (structuredContent) into `CardData`; `callTool` uses `useCallTool` / `useDynamicTool` and resolves to `toolResultText` for the toast; `getTheme` reads `useViewTheme()`; `onUpdate` fires on host context and tool result changes.
- Bind the view to a tool. A new view-bound tool (as T4.30 did with `show_task`) keeps every existing tool's JSON result unchanged. Add the photo origin to the view's `csp.resourceDomains`.
- Import `src/card.css` from the view entry.
- If the photos bucket becomes private, InsForge serves presigned URLs that may live on another host; the allowlist and CSP must follow.
- Replace the hard-coded photo origin with the deployment's `INSFORGE_BASE_URL` origin, as `show_task` does for its CSP.
- Require the photo key's first UUID to equal the card's `task_id`, so a card can only show its own task's photo.

## What CI runs

- `pnpm lint` (Biome), `pnpm typecheck` (root tsconfig, now including every widget `.ts`) and `pnpm test` (the unit project picks up `src/card.test.ts`).
- Not run in CI: the preview and `shots`. CSS colours, the reduced-motion guard and the look of each theme are checked only by the committed PNGs, which CI does not regenerate; unit tests check only that the theme reaches `data-theme`. The root Playwright config has fixed test directories, so the screenshots are generated locally and committed. The package has no `build` script, so `pnpm build` skips it.
