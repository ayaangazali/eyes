# Connect Eyes to ChatGPT, Claude, Claude Code and Cursor

MCP server URL: `https://api.eyes.pictures/mcp`

Instinct: see [connect/instinct.md](connect/instinct.md).
Codex (CLI and IDE): see [connect/codex.md](connect/codex.md).

There are two ways to sign in. Both use the same Eyes API key.

- **OAuth (ChatGPT, claude.ai, Claude Desktop):** the app opens an Eyes page. On that page, paste an API key or click **Create a key**. A new test key starts with a $20 balance, and the page shows the key once, so save it.
- **Bearer header (Claude Code, Cursor, your own agents):** send `Authorization: Bearer eyes_test_...`. To get a key without a browser:

```sh
curl -s -X POST https://api.eyes.pictures/v1/signup \
  -H 'content-type: application/json' \
  -d '{"name": "my-agent"}'
```

In ChatGPT and Claude, `quote_task`, `ask_eyes`, `await_answer`, `get_task` and `get_balance` show a card:

- a quote with workers nearby, ETA and price;
- the live task: status steps, the worker's photo, the answer and the three checks (on site, fresh photo, photo is safe to share);
- your balance, with a Top up button.

The other tools answer in text.

## ChatGPT (developer mode)

1. Open **Settings > Apps & Connectors > Advanced settings** and turn on **Developer mode**. This needs a Plus, Pro, Business, Enterprise or Edu plan.
2. In **Settings > Apps & Connectors**, click **Create**.
3. Fill in the form:
   - Name: `Eyes`.
   - MCP server URL: `https://api.eyes.pictures/mcp`.
   - Authentication: **OAuth**.
4. Tick "I trust this application", then click **Create**.
5. ChatGPT opens the Eyes sign-in page. Paste your key, or click **Create a key**, then **Continue to ChatGPT**.
6. In a new chat, click **+**, choose **Developer mode**, and enable **Eyes**. Then ask, for example: "Is the line at Blue Bottle Coffee, Mint Plaza, San Francisco long right now?"

## Claude (claude.ai and Claude Desktop)

1. Open **Settings > Connectors** and click **Add custom connector**.
2. Fill in the form:
   - Name: `Eyes`.
   - Remote MCP server URL: `https://api.eyes.pictures/mcp`.
3. Click **Add**, then **Connect**.
4. On the Eyes page, paste your key or create one, then continue back to Claude.
5. In a chat, open the tools menu and make sure **Eyes** is on.

Claude Desktop uses the connectors from your claude.ai account, so you add the connector only once. On Team and Enterprise plans, an owner adds it first, in **Organization settings > Connectors**.

## Claude Code

With a key:

```sh
claude mcp add --transport http eyes https://api.eyes.pictures/mcp \
  --header "Authorization: Bearer $EYES_API_KEY"
claude -p 'Use quote_task to check the line at the Ferry Building, San Francisco'
```

Without a key: run `claude mcp add --transport http eyes https://api.eyes.pictures/mcp`. Then, inside Claude Code, run `/mcp`, choose **eyes** and then **Authenticate**. The Eyes sign-in page opens in your browser.

## Cursor

Add this to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "eyes": {
      "url": "https://api.eyes.pictures/mcp",
      "headers": { "Authorization": "Bearer eyes_test_..." }
    }
  }
}
```

If you leave out `headers`, Cursor runs the OAuth sign-in instead.

## How the sign-in works (for operators)

- **Discovery:** `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-authorization-server`. A 401 from `/mcp` also points to the first one through `WWW-Authenticate`.
- **Registration:** `POST /oauth/register` is dynamic client registration. Only https redirect URIs are accepted, plus loopback http.
- **Client metadata documents:** a client can skip registration and send an https URL as `client_id` (MCP 2025-11-25). Eyes fetches it with a 5 s timeout and a 5 KB cap, refuses private, loopback and link-local addresses, and caches it for 10 minutes. The document's `client_id` must equal the URL, and the `redirect_uri` must be in its `redirect_uris`. The sign-in page shows `client_name (host)`.
- **Sign-in page:** `GET /oauth/authorize`. It requires PKCE S256. **Create a key** counts against the same per-IP limit as `/v1/signup` (5 per hour).
- **Token:** `POST /oauth/token` returns the Eyes API key as the access token, so existing bearer clients work unchanged. The token does not expire. To revoke it, rotate the key.
- **Server secret:** set `EYES_OAUTH_SECRET` to at least 32 random characters, for example from `openssl rand -hex 32`. Without it, the OAuth routes are off and only bearer keys work. If you change the secret, open sign-in pages and registered clients stop working; connected apps just register and sign in again.
- **Claude sandbox origin:** when the client looks like Claude (client name or user agent contains "claude"), the widget resource carries `_meta.ui.domain` = the first 32 hex characters of SHA-256 of `https://api.eyes.pictures/mcp` plus `.claudemcpcontent.com`. Claude checks this value against the exact connector URL, so add the connector as `https://api.eyes.pictures/mcp`, with no trailing slash. Other hosts get no `ui.domain`; ChatGPT reads `openai/widgetDomain` (`https://api.eyes.pictures`).
- **Photos:** the widget CSP allows `https://pagp38bu.us-west.insforge.app` and `https://cdn.insforge.dev`.
