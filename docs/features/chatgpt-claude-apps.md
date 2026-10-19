# ChatGPT and Claude apps

Eyes works as an app inside ChatGPT, claude.ai and Claude Desktop. You sign in with OAuth: paste an Eyes API key, or create a new one on the sign-in page. Tools return JSON; hosts that support the UI also render quotes, tasks and balances as cards, including the worker's photo and checks.

## How it works

- OAuth 2.1 with PKCE (S256) and dynamic client registration, served next to the existing API keys.
- The sign-in page at `/oauth/authorize` takes an existing Eyes key or creates one. New keys start with $20 in test credits, not real cash. Copy is optional for direct API use; **Continue** automatically connects the new key in both ChatGPT and Claude.
- `/oauth/token` returns the Eyes API key as the access token, so the `/mcp` bearer check does not change. The token does not expire. To revoke it, rotate the key.
- OAuth client registrations and authorization codes are carried in AES-GCM sealed blobs keyed by `EYES_OAUTH_SECRET`, not stored as database records. Other application data is still persisted. If that secret is unset, the OAuth routes are off and only bearer keys work.
- A single widget resource, `ui://eyes/scene-card-v2.html` (`text/html;profile=mcp-app`), renders `quote_task`, `ask_eyes`, `await_answer`, `get_task`, `show_task` and `get_balance` results as cards. `show_task` uses the same current photo, theme, review and action UI as `get_task`; no separate view build is needed. The existing card calls private `confirm_ask` and renders its result locally; the private action has no widget template of its own.
- ChatGPT finds the widget through `openai/outputTemplate`. Claude gets `ui/resourceUri` plus a per-connector `ui.domain`. Photos load from InsForge storage and the CDN.
- Interactive `ask_eyes` only prepares a read-only draft. Review the question, place and price, then press **Ask** to confirm and dispatch through app-only `confirm_ask`. No task, escrow or worker messages exist before that click.
- **New check here** opens an empty question for the same place. It allocates a UUIDv7 request-intent key before the availability call, keeps the earlier Task and evidence, and requires a new explicit confirmation. **Repeat previous question** copies only the text. The disputed-card **Ask again** also allocates its new key before requesting a quote.
- **Resume pending** and **View previous** select an existing check without charging. The recent list retains up to 20 local records and can load up to 20 Tasks through `list_tasks`; it is a bounded recent view, not complete paginated history. Selecting a Task re-reads it under current authorization.
- The card preserves supplied keys unchanged, dirty fields and frozen submitted parameters. Unknown confirmations retain their original key; unresolved records are not evicted. A later `not_sent`/no-workers result does not prove that an earlier unknown attempt was free, so its payload stays frozen and the warning remains unresolved. Starting a separate check warns that the earlier confirmation may already be active. If neither host state nor browser storage can preserve it, switching is blocked.
- State belongs to the selected intent/Task in both OpenAI and MCP Apps hosts. A fresh identified invocation takes precedence over unrelated restored completion; same-intent stale drafts cannot downgrade a Task. Async results, errors, busy flags and model context stay with their correlated identity.
- A visible card in `dispatched`, `claimed` or `submitted` reads `get_task` every five seconds, even if a partial answer is present. Reads are serialized with manual actions. Polling stops when the task leaves those states, pauses when hidden, and stops on teardown or read error. A read error leaves manual **Refresh status** available. Drafts, offscreen checks and balance cards do not poll; refreshes never dispatch or charge.
- The 13 model-visible tools are unchanged in number; `confirm_ask` is an additional app-only action. REST, CLI and non-UI MCP retain direct dispatch. Host visibility is not a general authorization mechanism for custom clients.
- The state-v2 scene cutover changes the canonical URI from `ui://eyes/confirmation-card.html` to `ui://eyes/scene-card-v2.html`, with no old-resource alias. After publishing, refresh/reconnect the app's tools and open a new card. Existing rendered messages are not retroactively updated and must not be reused for new checks.
- Quotes are previews, not approval. Confirmation rechecks current safety, ownership and spend limits before the atomic dispatch.

Generated request-intent keys use RFC 9562 UUIDv7 with cryptographically secure randomness. Caller-supplied strings remain opaque and stable, including non-UUID CLI/email keys. Existing Task, Submission and ledger IDs are unchanged; this repair has no database migration. Capture remains one photo per finalized check; multi-photo bundles, upload-replay hardening and cursor-based history are separate work.

## How to try it

In ChatGPT or Claude, add a custom connector with this URL and choose OAuth:

```
https://mcp.eyes.pictures/mcp
```

Then ask for a quote. Full steps are in [CONNECT.md](../CONNECT.md).

The dedicated MCP endpoint is active, with OAuth configured for both ChatGPT and Claude. Existing `https://api.eyes.pictures/mcp` connectors still work; REST, uploads and webhooks remain on `https://api.eyes.pictures`. The marketplace listing is still a draft: preflight is complete, but it has not been submitted or published.
## Where in the code

- [`apps/mcp/src/oauth.ts`](../../apps/mcp/src/oauth.ts): OAuth metadata, registration, sign-in page and token
- [`apps/mcp/src/widget.ts`](../../apps/mcp/src/widget.ts): card widget HTML, CSP and host metadata
- [`apps/mcp/src/server.ts`](../../apps/mcp/src/server.ts): registers the widget resource and links it to tools
- [`docs/CONNECT.md`](../CONNECT.md): setup steps for ChatGPT, Claude and Cursor
