---
task: W1
title: Eyes task card widget, placeholder phase (fixtures, mock bridge, not registered)
agent: builder
pr: https://github.com/ayaangazali/eyes/pull/87
spec_refs: [§6, §7, §10, §12]
vendor_refs: [docs/vendor/mcp-apps.md]
status: in_review
files:
  - apps/web/widget-task-card/package.json
  - apps/web/widget-task-card/README.md
  - apps/web/widget-task-card/src/types.ts
  - apps/web/widget-task-card/src/card.ts
  - apps/web/widget-task-card/src/card.css
  - apps/web/widget-task-card/src/photo.ts
  - apps/web/widget-task-card/src/bridge.ts
  - apps/web/widget-task-card/src/card.test.ts
  - apps/web/widget-task-card/fixtures/index.ts
  - apps/web/widget-task-card/fixtures/quote.json
  - apps/web/widget-task-card/fixtures/cached.json
  - apps/web/widget-task-card/fixtures/dispatched.json
  - apps/web/widget-task-card/fixtures/claimed.json
  - apps/web/widget-task-card/fixtures/verifying.json
  - apps/web/widget-task-card/fixtures/answered.json
  - apps/web/widget-task-card/fixtures/needs_review.json
  - apps/web/widget-task-card/fixtures/expired_refunded.json
  - apps/web/widget-task-card/fixtures/rejected_safety.json
  - apps/web/widget-task-card/fixtures/error.json
  - apps/web/widget-task-card/preview/index.html
  - apps/web/widget-task-card/preview/main.ts
  - apps/web/widget-task-card/scripts/shots.ts
  - docs/vendor/mcp-apps.md
  - docs/manufact/widget/quote-light.png
  - docs/manufact/widget/quote-dark.png
  - docs/manufact/widget/cached-light.png
  - docs/manufact/widget/cached-dark.png
  - docs/manufact/widget/dispatched-light.png
  - docs/manufact/widget/dispatched-dark.png
  - docs/manufact/widget/claimed-light.png
  - docs/manufact/widget/claimed-dark.png
  - docs/manufact/widget/verifying-light.png
  - docs/manufact/widget/verifying-dark.png
  - docs/manufact/widget/answered-light.png
  - docs/manufact/widget/answered-dark.png
  - docs/manufact/widget/answered-light-320.png
  - docs/manufact/widget/answered-dark-320.png
  - docs/manufact/widget/needs_review-light.png
  - docs/manufact/widget/needs_review-dark.png
  - docs/manufact/widget/expired_refunded-light.png
  - docs/manufact/widget/expired_refunded-dark.png
  - docs/manufact/widget/rejected_safety-light.png
  - docs/manufact/widget/rejected_safety-dark.png
  - docs/manufact/widget/error-light.png
  - docs/manufact/widget/error-dark.png
  - pnpm-lock.yaml
  - intent/INDEX.md
---
## Why
The `show_task` card from T4.30 shows one finished task. A chat user sees Eyes at more moments than that: a quote before paying, a cached answer that is free, a task waiting for a worker, a worker walking over, a photo being checked, a held payout, a refund, a refusal, an error. W1 designs that one compact card for all ten moments and proves it renders safely, on fixture data and a mock bridge, without touching anything that ships. W2 wires it to a real MCP Apps host.

## What
- `apps/web/widget-task-card/package.json`: the `@eyes/widget-task-card` workspace package (picked up by the existing `apps/web/*` glob). `preview` runs Vite on `/preview/`, `shots` writes the screenshots. No `build` script, so `pnpm build` skips it.
- `src/types.ts`: `CardData`, the adapter the card renders. It reuses core's `quote_task` and `get_task` outputs, `ask_eyes` input and `Answer` types read-only, and adds only what core lacks (sandbox flag, snapshot time, quote fee, workers notified, walking worker, cached check, refusal, error with retry).
- `src/card.ts`: `cardView(data, key)` maps a snapshot to everything the card shows, including each button's tool call. `cardTree` renders a view and wires each button to `bridge.callTool` and the toast, and `TaskCard` holds the React state and calls it. Task statuses map to card states through a `Record<TaskStatus, CardState>`, so a new core status fails the root typecheck.
- `src/card.css`: flat light and dark tokens on `data-theme`, max 420px, wraps cleanly at 320px, pulse dot off under `prefers-reduced-motion`.
- `src/photo.ts`: the photo allowlist (InsForge origin, photos bucket path, the engine's `<uuid>/<uuid>.jpg` key shape, the bundled fixture photo).
- `src/bridge.ts`: `WidgetBridge`, `MockBridge` (records calls, logs and toasts `Mock call: <tool> <args JSON>`, `play()` for the demo) and the `HostBridge` stub.
- `src/card.test.ts`: 44 unit tests run by the root `unit` project.
- `fixtures/*.json` and `fixtures/index.ts`: one snapshot per state and their display order.
- `preview/index.html`, `preview/main.ts`: every state in 320px and 420px columns, theme toggle, demo play.
- `scripts/shots.ts`: in-process Vite plus headless Chromium; writes the PNGs, clicks Dispute and checks the toast, fails on any request off the dev server.
- `README.md`: how to run it, states, bridge calls, security, W2 handoff, CI coverage.
- `docs/vendor/mcp-apps.md`: cited notes on receiving tool output, theme, calling tools, CSP and sizing in MCP Apps, mcp-use 2.10 and the ChatGPT Apps SDK.
- `docs/manufact/widget/*.png`: 22 screenshots, every state light and dark at 420px plus answered at 320px.
- `pnpm-lock.yaml` (generated, +42 lines: the new importer, `@types/react`, `@types/react-dom`, `csstype`) and `intent/INDEX.md` (generated by `node scripts/check-intent.ts --write-index`).

## Decisions & alternatives rejected
- Components in `.ts` with `React.createElement`, not `.tsx`. The brief asked for `.tsx` components with `.ts` tests, but tests must render the card and the root `unit` project only runs `*.test.ts`; a `.test.ts` importing a `.tsx` pulls it into the root `pnpm typecheck`, which failed with `TS6142: Module './a.tsx' was resolved to ..., but '--jsx' is not set` in a scratch check. The root tsconfig is out of scope. Rejected: hiding the import from tsc with a non-literal dynamic import (tests lose types and it reads as dodging the checker). Result: the root typecheck covers every line of the widget, and Vite and Vitest need no JSX transform or plugin.
- No code comments. The owner's text asked for `// TODO(W2): map from core` comments, but the repo's standing rule is zero added comments, so every W2 gap is a bullet in the README "W2 handoff" and below, and `HostBridge` throws `W2: HostBridge is not wired to the MCP Apps host yet`.
- `apps/web/widget-task-card/` (owner's choice) instead of `apps/mcp/views/`: a folder under `views/` is picked up by `mcp-use build`, which would change the shipped server build.
- New deps only in the widget package, exact versions: `@types/react` 19.3.0 and `@types/react-dom` 19.3.0 (both published 2026-09-09; React 19 ships no types and the root strict typecheck needs them), which bring `csstype` 3.2.3 (2025-11-17). `react`, `react-dom` 19.3.0 and `vite` 8.3.4 match versions already in the lockfile. `@playwright/test` resolves from the root. No JSX plugin.
- Button wiring is tested through `cardTree`, a plain function the tests call with a `MockBridge` and then click every rendered button on. Rejected: happy-dom as a widget devDependency. It is an optional peer of vitest, so installing it rewrote the root importer's `vitest` entry in `pnpm-lock.yaml`, which is more than "the widget's deps". Without a DOM, the image `onError` fallback and the one-key-per-mounted-card guard stay untested (both live in hooks); the preview and `shots` exercise them in a real browser.
- Photo keys must match the engine's shape, `${task.id}/${randomUUID()}.jpg` (`packages/engine/src/index.ts`), with the separator written as `/` or `%2F`. The verifier suggested rejecting `%2f` outright, but the InsForge SDK builds object URLs with `encodeURIComponent(key)` (`@insforge/sdk` 1.5.2 `dist/index.js`, and `packages/db/src/storage.test.ts` expects `task-1%2Fphoto%201.jpg`), so a live photo URL most likely reads `<uuid>%2F<uuid>.jpg`. The strict key pattern already rejects `..%2f`, `%252e%252e/`, `%5c` and anything else in the key.
- `new URL` in a `try`, not `URL.parse`, so Safari and WebViews older than 18 fall back to the placeholder instead of throwing.
- Screenshots are committed under `docs/manufact/widget/` because the owner's brief asked for it and main already keeps `docs/manufact/*.png` (T4.30). They are 22 small PNGs, 828 KB in total.
- One idempotency key per mounted card. A host view latches one tool result for its lifetime, so Confirm or Request fresh check clicked twice is one charge.
- Untrusted strings only as React text; the media falls back to the map placeholder for any photo URL off the allowlist, and on load error.
- Retry resends the stored failed call unchanged; an `ask_eyes` retry keeps its original key.
- The error fixture's stored key is the short `retry-key-1`, not a UUID. gitleaks' `generic-api-key` rule flags UUID-like values outside `*.test.ts`, `secrets-scan` is a required check that replays every PR commit, and silencing it would mean editing `.gitleaksignore`. The first push of this work (#86) carried a UUID there, so it was closed and replaced by this clean history instead of being force-pushed.
- `disputed` shares the needs_review card (pill "Disputed", no Dispute button); `refunded` shares the expired card ("Cancelled. $3.50 refunded.").

## W2 handoff
- `sandbox`: T4.29's sandbox is a separate server; `ask_eyes` and `await_answer` `next_step` carry the sandbox sentence, `get_task` and `quote_task` carry no flag. Sandbox photo URLs (`storage.fake.test`) fail the allowlist and show the map.
- `as_of`: set when the tool result arrives.
- Quote fee: `quote_task` has no fee field; the card adds `fee_usd`.
- `workers_notified`: in `ask_eyes` output, not in `get_task`.
- Walking worker distance and ETA: not in core.
- Cached checks: not in core.
- Safety refusal: `unsafe_task` from `ask_eyes`, or `quote_task` `allowed: false`, which also covers balance and caps with no machine-readable code.
- `ask` on quote and cached cards (question, bounty, deadline, photo flag): no core source, because `quote_task` input is only `{ location, task_type }` (`packages/core/src/schemas.ts`); W2 carries the intended `ask_eyes` args with the quote.
- Photo key: require the key's first UUID to equal the card's `task_id`, so a card can only show its own task's photo (optional hardening from security round 2).
- Error retry: the host bridge must remember the failed call; Retry must accept only expected tool names, validate args with `TOOLS[name].input`, and show the amount when the retry spends money.
- Verifying badges: shown amber while `submitted`, though core already has the booleans.
- Tip: `tip_worker` is not an Eyes tool, only a logged intent.
- Dispute reason is fixed; collect one or use `sendFollowUp`.
- `HostBridge`: `useToolContext().toolOutput` to `CardData`, `useCallTool`/`useDynamicTool` plus `toolResultText`, `useViewTheme()`; bind a new view-bound tool so existing tools' results stay unchanged; photo origin from `INSFORGE_BASE_URL` in `csp.resourceDomains`; import `src/card.css`. A private bucket's presigned URLs may need another host.

## Assumptions
- Live photos are public objects at `https://7t6779x4.us-east.insforge.app/api/storage/buckets/photos/objects/<key>` (owner's placeholder origin; docs/vendor/insforge.md gives the URL shape).
- Live photo URLs carry the engine key `<task uuid>/<uuid>.jpg`, URL-encoded by the SDK as `<task uuid>%2F<uuid>.jpg`. Not yet seen live: STATUS says no capture has gone through InsForge storage.
- The 0.50 USD fee matches core's `fee_cents` default (50).

## Verification
- `pnpm verify:fast` passes on top of 668754a (after T4.29, #84), first run, no flake: Biome "Checked 124 files ... No fixes applied", `tsc` clean, unit 580 passed in 18 files (536 before, plus the widget's 44), contract 12 passed, safety 139 passed, "intent check ok: 48 changed files, 1 intent files".
- `pnpm exec vitest run --project unit apps/web/widget-task-card`: 44 passed:
  - 10 fixture renders.
  - Fixtures parse with core's `QuoteTaskOutput`, `AskEyesInput`, `Answer`, `GetTaskOutput` and the retry tool's input schema.
  - Escaping.
  - Two allowlisted photo URLs (`/` and `%2F`).
  - 27 rejected photo URLs. Each URL with a host, scheme, credential, prefix, anchor or extension defect carries a valid `<uuid>/<uuid>.jpg` key, so it breaks exactly one check.
  - Every rendered button clicked through `cardTree` into `MockBridge`, with the toast and console line checked.
  - Theme and toast passed through `cardTree` and `TaskCard`.
  - A rejected bridge call toasting its error.
- Mutation matrix at round 3, each mutant applied, run, then reverted (sources byte-identical after); all 21 caught, failures out of 44:

  | Mutant | Failed |
  |---|---|
  | Allowlist bypassed (return any URL) | 26 |
  | Origin check removed | 7 |
  | Both credential checks removed | 3 |
  | Username check removed | 1 |
  | Password check removed | 1 |
  | Path prefix check removed | 1 |
  | Key `^` anchor removed | 1 |
  | Key `$` anchor removed | 2 |
  | `.jpg` widened to any extension | 1 |
  | Separator widened to `%5c` | 1 |
  | Any `fixture:` URL accepted | 1 |
  | Every rendered button fires `buttons[0].call` | 1 |
  | `run` calls `.callTool("noop", {})` | 1 |
  | Refusal note via `dangerouslySetInnerHTML` | 1 |
  | Dispute sends `cancel_task` | 1 |
  | Confirm without `idempotency_key` | 1 |
  | `cardTree` ignores theme | 1 |
  | Toast row dropped | 1 |
  | `TaskCard` ignores the bridge theme | 1 |
  | Toast without args | 1 |
  | No `console.info` | 1 |
- `shots` rerun after round 1 (head 631c128): both themes print the same lines and all 22 PNGs are byte-identical (`git status` clean), so the refactor changed no rendering. Round 3 changes only tests and docs.
- `pnpm --filter @eyes/widget-task-card shots`: "light: 11 shots, Dispute click logged, no foreign requests" and the same for dark; 22 PNGs, 25 to 48 KB each, 828 KB total.
- Preview, driven headlessly on a Vite dev server (port 5199, stopped by PID after): Demo play went "quote -> dispatched -> claimed -> verifying -> answered"; the toggle set `data-theme="dark"` on the cards and the page; Confirm $3.50 showed "Mock call: ask_eyes"; the pulse had `animation-name: eyes-pulse`, and `none` under reduced motion; no console errors.
- `pnpm build`: worker and `@eyes/mcp` build as before ("built views/entry.ts + views (task-card)"); the widget has no `build` script and is skipped.
- `pnpm exec playwright test --list`: "Total: 27 tests in 4 files", none from the widget folder.
- `pnpm install --frozen-lockfile` after the lockfile change: "Already up to date".
- gitleaks v8.28.0 (Docker, `dir` mode, repo `.gitleaks.toml`) over every new text file: no leaks; the same run flags the UUID version of `fixtures/error.json` as `generic-api-key`.
- `grep -rnE "innerHTML|dangerouslySetInnerHTML|fetch\(|XMLHttpRequest|WebSocket"` over the package's code (outside `node_modules`, excluding Markdown, whose prose names `innerHTML`): no matches in code.
- Not covered by CI: the preview, the `shots` script and the click check; the PNGs are generated locally and committed. CSS colours, the reduced-motion guard and how each theme looks are checked only by those committed PNGs (and the headless preview run above), which CI never regenerates; unit tests check only that the theme reaches `data-theme`.

## Verifier verdicts
- Round 1 (PR #87 at 33ecdd0): spec PASS (4 minor), security PASS (3 minor; 214 cases, 212 passed), test+intent PASS (1 major, 7 minor; 27 mutations, 15 caught).
- Fixed in round 2:
  - Major, the rendered-button to bridge wiring was untested. It now runs through `cardTree` and is tested; both reported mutations fail.
  - Security:
    - Encoded traversal is closed by the strict key shape, accepting `%2F` only as the SDK's separator.
    - `URL.parse` became `new URL` in a `try`.
  - Spec: the toast and `console.info` show the tool and its args.
  - Intent and README:
    - The `ask` field gap and the Retry validation note are in the W2 handoff.
    - The grep wording says "no matches in code".
    - The reason for committing the PNGs is recorded.
    - The README shell notes moved out of the code block.
  - Not done: the image `onError` fallback and one-key-per-mount tests. Both need a DOM, and a DOM dependency would change the root lockfile entry.
- Round 2 (631c128): security PASS (80 named cases plus 500k fuzz; `%2F` reaches only the same object, per InsForge's Express decode), test+intent FAIL on coverage only.
- Fixed in round 3:
  - Major: the strict key pattern masked the credential, prefix, `^` anchor and extension checks. Each rejected URL now carries a valid key and breaks one check; origin cases got valid keys too, plus username-only and password-only credential cases. All 21 mutants above fail the suite.
  - Minors:
    - Theme and toast are pinned through `cardTree` and `TaskCard`.
    - The W2 handoff adds the `task_id` match on the photo key.
    - CSS, reduced-motion and theme are recorded as PNG-only coverage.
  - Not done: the `disputed`, `refunded` and `verified` statuses have no fixtures, so their mappings are untested (`disputed` to the "Disputed" review card without Dispute, `refunded` to "Cancelled. $3.50 refunded.", `verified` to the answered card). Adding fixtures would add preview cells and screenshots.
