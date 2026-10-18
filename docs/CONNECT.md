# Connect Eyes to an MCP client

For the public-directory package, see [ChatGPT marketplace packaging and review blockers](connect/chatgpt-marketplace.md). It uses the dedicated MCP host and does not modify existing connectors.

| URL | Use it for |
| --- | --- |
| `https://api.eyes.pictures/mcp` | **Existing MCP endpoint.** Supported unchanged; the dedicated host below is ready for connector migration. |
| `https://dark-steel-ofaoa.run.mcp-use.com/mcp` | **Optional Manufact gateway.** Proxy access for Cursor, VS Code, Claude Code, Gemini CLI, Codex, Instinct and the mcp-use SDKs. |
| `https://api.eyes.pictures` | **REST base (unchanged).** Signup, `/v1/*`, worker uploads and `/webhooks/*`; not the new MCP connector URL. |

The actual MCP/API server is hosted on **Manufact Cloud**, server `eyes-prod`, at `https://warm-spark-aocdd.run.mcp-use.com`. Cloudflare's `eyes-api` Worker only forwards `api.eyes.pictures` and `internal.eyes.pictures` to that origin. Static `eyes.pictures` and `app.eyes.pictures` remain on Cloudflare.

Both client URLs reach the same server and the same 13 tools: `quote_task`, `ask_eyes`, `await_answer`, `get_task`, `show_task`, `list_tasks`, `cancel_task`, `accept_answer`, `dispute_answer`, `get_balance`, `get_spend_policy`, `report_classifier`, `get_classifier_report`. The optional gateway is a [Manufact](https://docs.manufact.com/dashboard/connect-existing-server) proxy in front of `api.eyes.pictures`. It adds usage analytics and sessions, but is not the server host and does not hold your key. Every client sends its own Eyes API key.

<a id="dedicated-mcp-domain-prepared-not-active"></a>

## Dedicated MCP domain: ready for connector migration

`https://mcp.eyes.pictures/mcp` is **ready for connector migration; existing connectors have not been switched**. The domain owner verified the deployed host's OAuth flow, all 12 tools and matching card metadata on 2026-10-18. It uses the same Manufact-hosted server. Existing ChatGPT, Claude and third-party connectors can keep using `https://api.eyes.pictures/mcp`; the instructions below retain that supported endpoint.

Verified dedicated-host values:

| Surface | Required value |
| --- | --- |
| MCP and OAuth discovery | Resource `https://mcp.eyes.pictures/mcp`; authorization server / issuer `https://mcp.eyes.pictures`. Metadata at `https://mcp.eyes.pictures/.well-known/oauth-protected-resource` and `https://mcp.eyes.pictures/.well-known/oauth-authorization-server`, each with a `/mcp` variant. |
| OAuth endpoints | `https://mcp.eyes.pictures/oauth/authorize`, `https://mcp.eyes.pictures/oauth/token`, and dynamic registration at `https://mcp.eyes.pictures/oauth/register`. |
| Card origins | ChatGPT `openai/widgetDomain`: `https://mcp.eyes.pictures`; Claude `_meta.ui.domain`: `87d4a8d03df273ec472729285f051938.claudemcpcontent.com` (first 32 hex characters of SHA-256 of the exact new connector URL). |
| REST, uploads and webhooks | Stay at `https://api.eyes.pictures`; existing API keys and optional gateway configuration stay unchanged. Existing `api.eyes.pictures/mcp` connectors retain their API-host OAuth issuer and card origins. |

When the owner chooses to migrate one connector, change its MCP server URL to `https://mcp.eyes.pictures/mcp` and reconnect through OAuth. Leave other connectors unchanged. See [DEPLOY.md](DEPLOY.md#dedicated-mcp-domain-staging) for the 29/29 verification evidence and DNS-cache caveat.

## 1. Get an Eyes API key

```sh
curl -s -X POST https://api.eyes.pictures/v1/signup \
  -H 'content-type: application/json' \
  -d '{"name": "my-agent"}'
```

Save `api_key` from the reply. The reply shows it only once. A new test key starts with a $20 balance. The header every client sends is `Authorization: Bearer <api_key>`, so for the commands below:

```sh
export AUTHORIZATION="Bearer <api_key>"
```

## 2. Optional Manufact gateway

These are the configs that Manufact's **Add to client** dialog generates for this server (server page > URL chip > **Add to client**). Replace `your-AUTHORIZATION-value` with `Bearer <api_key>`.

For the recommended public endpoint, use these same bearer configurations with the URL changed to `https://api.eyes.pictures/mcp`. The gateway is not required for Manufact hosting.

### Claude Code

```sh
claude mcp add --transport http "eyes" \
    'https://dark-steel-ofaoa.run.mcp-use.com/mcp' \
    --header 'Authorization:${AUTHORIZATION}'
```

### Cursor

One-click install (Cursor asks for the `AUTHORIZATION` value):

```text
cursor://anysphere.cursor-deeplink/mcp/install?config=eyJ1cmwiOiJodHRwczovL2Rhcmstc3RlZWwtb2Zhb2EucnVuLm1jcC11c2UuY29tL21jcCIsImhlYWRlcnMiOnsiQXV0aG9yaXphdGlvbiI6Int7QVVUSE9SSVpBVElPTn19In19&name=eyes
```

Or add this to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "eyes": {
      "url": "https://dark-steel-ofaoa.run.mcp-use.com/mcp",
      "headers": { "Authorization": "Bearer <api_key>" }
    }
  }
}
```

### VS Code and VS Code Insiders

One-click install. For Insiders, change the `vscode:` prefix to `vscode-insiders:`. Then edit the `Authorization` value in the MCP server settings.

```text
vscode:mcp/install?%7B%22url%22%3A%22https%3A%2F%2Fdark-steel-ofaoa.run.mcp-use.com%2Fmcp%22%2C%22name%22%3A%22eyes%22%2C%22type%22%3A%22http%22%2C%22headers%22%3A%7B%22Authorization%22%3A%22your-AUTHORIZATION-value%22%7D%7D
```

### Gemini CLI

```sh
gemini mcp add --transport http "eyes" 'https://dark-steel-ofaoa.run.mcp-use.com/mcp' \
  --header 'Authorization:${AUTHORIZATION}'
```

### Codex CLI and the Codex IDE extension

Both read `~/.codex/config.toml`:

```toml
[mcp_servers.eyes]
url = "https://dark-steel-ofaoa.run.mcp-use.com/mcp"
http_headers = { "Authorization" = "your-AUTHORIZATION-value" }

# (optional) Use environment variables instead:
# env_http_headers = { "Authorization" = "AUTHORIZATION" }
```

`codex mcp list` should show `eyes` as enabled.

### Claude Desktop (local extension)

In the **Add to client** dialog, **Claude Desktop** downloads `eyes.mcpb`, which contains `{ "url": "https://dark-steel-ofaoa.run.mcp-use.com/mcp", "name": "eyes", "headers": { "Authorization": "your-AUTHORIZATION-value" } }`. Set the header value before you install it. If you want the Eyes cards in Claude, use the connector in section 3 instead.

### mcp-use SDKs

```ts
import { MCPClient } from "@mcp-use/client";

const client = new MCPClient({
  mcpServers: {
    eyes: {
      url: "https://dark-steel-ofaoa.run.mcp-use.com/mcp",
      headers: { Authorization: "Bearer <api_key>" },
    },
  },
});
const connection = await client.connect("eyes");
console.log((await connection.listTools()).map((t) => t.name));
```

Python: `MCPClient(config={"mcpServers": {"eyes": {"url": "https://dark-steel-ofaoa.run.mcp-use.com/mcp", "headers": {"Authorization": "Bearer <api_key>"}}}})`.

### Instinct and other clients

Any client that speaks streamable HTTP MCP: give it the gateway URL and the header `Authorization: Bearer <api_key>`. For Instinct, text it: "Connect the Eyes MCP server at https://dark-steel-ofaoa.run.mcp-use.com/mcp with the header Authorization: Bearer <api_key>". Instinct runs in the cloud, so it needs the remote URL. A local stdio bridge does not help.

Clients without a header field can use OAuth. The gateway's 401 points to `/.well-known/oauth-protected-resource/mcp`, which names `https://api.eyes.pictures` as the authorization server. The Eyes sign-in page is described below. OAuth through the gateway has not been tested with a real client yet. If it fails, use the direct URL.

### Check it works

Ask the client: "Use Eyes to quote checking whether the Ferry Building in San Francisco is open." It should reply with `allowed: true`, a price of about $3, and the number of workers nearby. A quote spends nothing.

## 3. Public URL: ChatGPT and claude.ai

Use `https://api.eyes.pictures/mcp` for app connectors. Claude checks the card sandbox domain against the exact connector URL, and that domain is derived from `api.eyes.pictures`. Through the gateway, the cards would not render.

In ChatGPT and Claude, `quote_task`, `ask_eyes`, `await_answer`, `get_task` and `get_balance` show a card: a quote (workers nearby, ETA, price), the live task (status, photo, answer and the three checks), or your balance with a Top up button. The other tools reply in text.

### ChatGPT (developer mode)

1. Open **Settings > Apps & Connectors > Advanced settings** and turn on **Developer mode**. This needs a Plus, Pro, Business, Enterprise or Edu plan.
2. In **Settings > Apps & Connectors**, click **Create**. Set Name to `Eyes`, MCP server URL to `https://api.eyes.pictures/mcp`, and Authentication to **OAuth**.
3. Tick "I trust this application", then click **Create**.
4. On the Eyes sign-in page, paste your key or click **Create a key**, then click **Continue to ChatGPT**.
5. In a new chat, click **+**, choose **Developer mode**, and enable **Eyes**.

### Claude (claude.ai and Claude Desktop connectors)

1. Open **Settings > Connectors** and click **Add custom connector**. Set Name to `Eyes` and URL to `https://api.eyes.pictures/mcp`, with no trailing slash.
2. Click **Add**, then **Connect**. On the Eyes page, paste your key or create one.
3. In a chat, open the tools menu and make sure **Eyes** is on.

Claude Desktop uses the connectors from your claude.ai account. On Team and Enterprise plans, an owner adds the connector first, in **Organization settings > Connectors**.

When OAuth creates a key, click **Copy** beside the displayed key to save it before continuing. **Copied** confirms success; if clipboard access is unavailable or denied, select the displayed key and copy it manually. Copy never submits the page or follows **Continue**.

### Fallback for every other client

For every other client, the public URL also works without the optional gateway. If the gateway returns errors (for example `402` once its plan's monthly credits run out), replace the section 2 URL with `https://api.eyes.pictures/mcp`. For example:

```sh
claude mcp add --transport http eyes https://api.eyes.pictures/mcp \
  --header "Authorization: Bearer $EYES_API_KEY"
codex mcp add eyes --url https://api.eyes.pictures/mcp --bearer-token-env-var EYES_API_KEY
```

## Troubleshooting

- **401 `Missing or invalid API key`.** The header is missing, or the key was rotated. Check that the value is `Bearer <api_key>`, including the word `Bearer`.
- **`0 workers nearby`.** The quote still works. A task waits for a worker, and `cancel_task` refunds it before anyone accepts it.
- **Text, not cards.** Expected in every client except ChatGPT and Claude connectors on the direct URL.
- **Out of money.** Call `get_balance`. The reply includes a top-up link.

## How the sign-in works (for operators)

- **Discovery:** `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-authorization-server`. A 401 from `/mcp` also points to the first one through `WWW-Authenticate`. The public resource must be `https://api.eyes.pictures/mcp` with authorization server `https://api.eyes.pictures`. As of the 2026-10-18 Manufact cutover, edge normalization of Manufact's rewritten resource metadata is pending verification; do not treat OAuth discovery as verified yet. The optional gateway has its own resource URL.
- **Registration:** `POST /oauth/register` is dynamic client registration. Only https redirect URIs are accepted, plus loopback http.
- **Sign-in page:** `GET /oauth/authorize`. It requires PKCE S256. **Create a key** counts against the same per-IP limit as `/v1/signup` (5 per hour).
- **Token:** `POST /oauth/token` returns the Eyes API key as the access token, so existing bearer clients work unchanged. The token does not expire. To revoke it, rotate the key.
- **Server secret:** set `EYES_OAUTH_SECRET` to at least 32 random characters, for example from `openssl rand -hex 32`. Without it, the OAuth routes are off and only bearer keys work. If you change the secret, open sign-in pages and registered clients stop working; connected apps just register and sign in again.
- **Claude sandbox origin:** when the client looks like Claude (client name or user agent contains "claude"), the widget resource carries `_meta.ui.domain` = the first 32 hex characters of SHA-256 of `https://api.eyes.pictures/mcp` plus `.claudemcpcontent.com`. Other hosts get no `ui.domain`; ChatGPT reads `openai/widgetDomain` (`https://api.eyes.pictures`).
- **Photos:** the widget CSP allows `https://pagp38bu.us-west.insforge.app` and `https://cdn.insforge.dev`.
- **Manufact gateway:** external server `Eyes` (slug `dark-steel-ofaoa`) in the operator's Manufact org, in proxy mode, with upstream `https://api.eyes.pictures/mcp`. It does not inject a key for public traffic: an unauthenticated request gets the upstream 401. The dashboard's own bearer key is used only by Manufact's Chat, inspector and checks.
