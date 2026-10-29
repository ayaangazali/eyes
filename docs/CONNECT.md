# Connect Eyes to ChatGPT, Claude, Claude Code and Cursor

MCP server URL for new connections: `https://mcp.eyes.pictures/mcp`. ChatGPT and Claude are configured there. Legacy `https://api.eyes.pictures/mcp` remains supported; REST/signup/uploads/webhooks stay at `https://api.eyes.pictures`. Manufact hosts the application; Cloudflare provides the edge and static pages.

There are two ways to sign in. Both use the same Eyes API key.

- **OAuth (ChatGPT, claude.ai, Claude Desktop):** the app opens an Eyes page. Paste an existing key or create a new one, then choose **Continue to ChatGPT** or **Continue to Claude**; the key is handed to the client automatically. Saving/copying it is optional for direct API access. The $20 credit is test-only; no real money moves.
- **Bearer header (Claude Code, Cursor, your own agents):** send `Authorization: Bearer eyes_test_...`. To get a key without a browser:

```sh
curl -s -X POST https://api.eyes.pictures/v1/signup \
  -H 'content-type: application/json' \
  -d '{"name": "my-agent"}'
```

The server has 13 model-visible tools plus app-only `confirm_ask`. In ChatGPT and Claude, the quote, task, answer and balance tools share `ui://eyes/confirmation-card.html`; the old React-view build was removed.

- a quote with workers nearby, ETA and price;
- the live task: status steps, the worker's photo, the answer and the three checks (on site, fresh photo, photo is safe to share);
- your balance, with a Top up button.

The other tools answer in text.

## Explicit task confirmation

Interactive `ask_eyes` returns a read-only `confirmation_required` draft. Review the question, place and price, then press **Ask** to confirm through app-only `confirm_ask`. No task, escrow or worker messages occur before confirmation. Retries preserve the intent key and submitted parameters; **Ask again** starts a new intent and needs another confirmation. The model uses the returned task ID rather than dispatching another ask. REST, CLI and non-UI MCP automation remain unchanged.

After upgrading, refresh the app's tool definitions (reconnect if needed) and request a new quote. Old rendered cards do not update retroactively, and their interactive `ask_eyes` calls remain read-only. A preview is not approval: confirmation rechecks current safety and spend limits.


## ChatGPT web

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add / + > Add custom MCP server**, or resume **Connect** on the existing Eyes entry.
2. Name it **Eyes**, use `https://mcp.eyes.pictures/mcp`, and choose **OAuth**.
3. Check **I understand and want to continue**, then choose **Create as a plugin** and **Connect**.
4. On the Eyes page, choose **Continue to ChatGPT** after creating a key, or enter an existing key and choose **Connect**. Never paste the key into chat.
5. In a new chat, select **Eyes** with **@** and ask for a free quote.

The current Plugins flow does not require Developer Mode; access depends on account/workspace policy. Marketplace 1.0.3 is a configured draft with preflight complete, not submitted or published. Legal owner attestations and test-mode limits remain.

## Claude (claude.ai and Claude Desktop)

1. Open [Claude Connectors](https://claude.ai/customize/connectors), choose **+ Add > Add custom connector**, or resume the existing Eyes connection.
2. Use `https://mcp.eyes.pictures/mcp`, choose **Continue**, and keep **Sign in now** and **Register automatically**.
3. Choose **Connect**. After creating a key, choose **Continue to Claude**; saving the key is optional for direct API use.
4. In a chat, enable **Eyes** under **+ > Connectors** and ask for a free quote.

The account connector also serves Claude Desktop. Organization policy may require an owner/admin to add it first. Both clients are configured at the dedicated host; not every third-party connector has migrated. Follow-up visual checks on the operator's test accounts were quota-blocked on 2026-10-18, not unavailable for all users; see [STATUS](../STATUS.md).

## Claude Code

With a key:

```sh
claude mcp add --transport http eyes https://mcp.eyes.pictures/mcp \
  --header "Authorization: Bearer $EYES_API_KEY"
claude -p 'Use quote_task to check the line at the Ferry Building, San Francisco'
```

Without a key: run `claude mcp add --transport http eyes https://mcp.eyes.pictures/mcp`. Then, inside Claude Code, run `/mcp`, choose **eyes** and then **Authenticate**. The Eyes sign-in page opens in your browser.

## Cursor

Add this to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "eyes": {
      "url": "https://mcp.eyes.pictures/mcp",
      "headers": { "Authorization": "Bearer eyes_test_..." }
    }
  }
}
```

If you leave out `headers`, Cursor runs the OAuth sign-in instead.

## How the sign-in works (for operators)

- **Discovery:** both hosts serve `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, including `/mcp` variants. The dedicated resource and issuer use `mcp.eyes.pictures`; legacy API-host connectors retain matching API-host metadata. A 401 challenge points to the same host's resource metadata.
- **Registration:** `POST /oauth/register` is dynamic client registration. Only https redirect URIs are accepted, plus loopback http.
- **Sign-in page:** `GET /oauth/authorize`. It requires PKCE S256. **Create a key** counts against the same per-IP limit as `/v1/signup` (5 per hour).
- **Token:** `POST /oauth/token` returns the Eyes API key as the access token, so existing bearer clients work unchanged. The token does not expire. To revoke it, rotate the key.
- **Server secret:** set `EYES_OAUTH_SECRET` to at least 32 random characters, for example from `openssl rand -hex 32`. Without it, the OAuth routes are off and only bearer keys work. If you change the secret, open sign-in pages and registered clients stop working; connected apps just register and sign in again.
- **Card origins:** ChatGPT uses `openai/widgetDomain` matching the connector origin. Claude `_meta.ui.domain` derives from SHA-256 of the exact connector URL plus `.claudemcpcontent.com`; use the dedicated URL for new connections. Both `resources/list` and `resources/read` expose host-matched metadata.
- **Photos:** the widget CSP allows `https://pagp38bu.us-west.insforge.app` and `https://cdn.insforge.dev`.
