# ChatGPT and Claude apps

Eyes works as an app inside ChatGPT, claude.ai and Claude Desktop. You sign in with OAuth: paste an Eyes API key, or create a new one on the sign-in page. Tools return JSON; hosts that support the UI also render quotes, tasks and balances as cards, including the worker's photo and checks.

## How it works

- OAuth 2.1 with PKCE (S256) and dynamic client registration, served next to the existing API keys.
- The sign-in page at `/oauth/authorize` takes an existing Eyes key or creates one. New keys start with $20 in test credits, not real cash. Copy is optional for direct API use; **Continue** automatically connects the new key in both ChatGPT and Claude.
- `/oauth/token` returns the Eyes API key as the access token, so the `/mcp` bearer check does not change. The token does not expire. To revoke it, rotate the key.
- OAuth client registrations and authorization codes are carried in AES-GCM sealed blobs keyed by `EYES_OAUTH_SECRET`, not stored as database records. Other application data is still persisted. If that secret is unset, the OAuth routes are off and only bearer keys work.
- A single widget resource, `ui://eyes/confirmation-card.html` (`text/html;profile=mcp-app`), renders `quote_task`, `ask_eyes`, `await_answer`, `get_task`, `show_task` and `get_balance` results as cards. `show_task` uses the same current photo, theme, review and action UI as `get_task`; no separate view build is needed. The existing card calls private `confirm_ask` and renders its result locally; the private action has no widget template of its own.
- ChatGPT finds the widget through `openai/outputTemplate`. Claude gets `ui/resourceUri` plus a per-connector `ui.domain`. Photos load from InsForge storage and the CDN.
- Interactive `ask_eyes` only prepares a read-only draft. Review the question, place and price, then press **Ask** to confirm and dispatch through app-only `confirm_ask`. No task, escrow or worker messages exist before that click.
- The card preserves edits, disables duplicate confirmation while pending, and reuses the same intent key and submitted parameters for retries. Late model drafts cannot replace a completed task. **Ask again** starts a fresh intent and requires another confirmation.
- The 13 model-visible tools are unchanged in number; `confirm_ask` is an additional app-only action. REST, CLI and non-UI MCP retain direct dispatch. Host visibility is not a general authorization mechanism for custom clients.
- The confirmation contract uses a new resource URI so newly rendered cards do not reuse pre-confirmation HTML. Existing rendered messages are not retroactively updated. Refresh/reconnect the app's tools and request a new quote; do not keep using an old card.
- Quotes are previews, not approval. Confirmation rechecks current safety, ownership and spend limits before the atomic dispatch.

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
