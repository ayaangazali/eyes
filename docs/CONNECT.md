# Connect Eyes to an MCP client

## ChatGPT web: no terminal required

Open [ChatGPT Plugins](https://chatgpt.com/plugins). This is a custom connector flow, not a public marketplace install.

1. Choose **Add / + > Add custom MCP server**. If Eyes is already added, open it and resume **Connect** instead of creating a duplicate.
2. Name it **Eyes**, set Server URL to `https://mcp.eyes.pictures/mcp`, and choose **OAuth**.
3. Check **I understand and want to continue**, then choose **Create as a plugin** and **Connect**.
4. If you create a key on the Eyes OAuth page, click **Continue to ChatGPT**; your app receives it automatically. Save the key only if you want direct API access. If using an **existing Eyes API key**, enter it on that page and click **Connect**. Never paste a key into chat. Connecting does not charge a card.
5. In a new chat, type **@**, select **Eyes**, and ask for a free quote: “Use Eyes to quote checking whether the Ferry Building in San Francisco is open.”

The current Plugins flow does **not** require enabling Developer Mode. Access is web-only and depends on your account, workspace policy, and Lockdown settings. Pro supports read/fetch permissions; full MCP is available on Business, Enterprise and Edu. Business requires an admin/owner to create workspace plugins; Enterprise/Edu also permit creators with **Create plugins with MCPs**. Only admins/owners publish to the workspace. Free and Plus access is not guaranteed. If **Add custom MCP server** is missing or disabled, check account/workspace access.

A public directory listing requires OpenAI review, approval, and an explicit publish step. Marketplace version 1.0.3 is a configured draft with preflight complete, not submitted or published; legal owner attestations and test-mode limits remain.

Sources: [Connect in ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt), [current account requirements](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt), [public app review](https://developers.openai.com/plugins/deploy/app-review).

## Claude web: no terminal required

Open [Claude Connectors](https://claude.ai/customize/connectors). The same remote connector also works through your Claude account in Desktop and Cowork; no local JSON or shell commands are needed.

1. In **Customize > Connectors**, choose **+ Add > Add custom connector**. If Eyes is already added, open it and resume **Connect** instead of creating a duplicate.
2. Name it **Eyes**, paste `https://mcp.eyes.pictures/mcp` with no trailing slash, and choose **Continue**.
3. Keep the detected **Sign in now** and **Register automatically** settings, add the connector, then choose **Connect**.
4. If you create a key on the Eyes OAuth page, click **Continue to Claude**; your app receives it automatically. Save the key only if you want direct API access. If using an **existing Eyes API key**, enter it on that page and click **Connect**. Never paste a key into chat. Connecting does not charge a card.
5. In a new chat, open **+ > Connectors** and enable **Eyes**. Ask for the same free quote above.

Custom connectors are available on Free, Pro, Max, Team and Enterprise. Free is limited to one custom connector. On Team, an Owner or Primary Owner must add the organization connector first; Enterprise also permits a custom role with **Manage access to Libraries**. Each member then connects individually from Customize. Organization admins use [admin connector settings](https://claude.ai/admin-settings/connectors).

This is custom connector setup, not a one-click install or a claim that Eyes is listed in the connector directory. [Official Claude requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

## Advanced: other clients and CLI

| URL | Use it for |
| --- | --- |
| `https://mcp.eyes.pictures/mcp` | **Recommended for new connectors.** Live dedicated MCP/OAuth/card host; ChatGPT and Claude are configured here. |
| `https://api.eyes.pictures/mcp` | **Supported legacy MCP endpoint.** Existing connectors can stay here; REST URLs are not migrated. |
| `https://dark-steel-ofaoa.run.mcp-use.com/mcp` | **Optional Manufact gateway.** Proxy access for Cursor, VS Code, Claude Code, Gemini CLI, Codex, Instinct and the mcp-use SDKs. |
| `https://api.eyes.pictures` | **REST base (unchanged).** Signup, `/v1/*`, worker uploads and `/webhooks/*`; not the new MCP connector URL. |

The actual MCP/API server is hosted on **Manufact Cloud**, server `eyes-prod`, at `https://warm-spark-aocdd.run.mcp-use.com`. Cloudflare's `eyes-api` Worker forwards `mcp.eyes.pictures`, `api.eyes.pictures` and `internal.eyes.pictures` to that origin. Static `eyes.pictures` and `app.eyes.pictures` remain on Cloudflare.

All MCP endpoints reach the same server and the same 13 tools: `quote_task`, `ask_eyes`, `await_answer`, `get_task`, `show_task`, `list_tasks`, `cancel_task`, `accept_answer`, `dispute_answer`, `get_balance`, `get_spend_policy`, `report_classifier`, `get_classifier_report`. `show_task` shares `ui://eyes/card.html` with the other cards; the legacy React-view build was removed. The optional [Manufact gateway](https://docs.manufact.com/dashboard/connect-existing-server) remains a proxy in front of `api.eyes.pictures`, separate from the server host. Every bearer client sends its own Eyes API key.

## Dedicated MCP domain: live

`https://mcp.eyes.pictures/mcp` is live, with ChatGPT and Claude configured there. Matching OAuth and card metadata are verified. Existing third-party connectors at `https://api.eyes.pictures/mcp` remain supported; not every client has migrated. Follow-up visual checks on the operator's test accounts were quota-blocked on 2026-10-18; this is not a general ChatGPT or Claude limitation. See [STATUS](../STATUS.md).

Verified dedicated-host values:

| Surface | Required value |
| --- | --- |
| MCP and OAuth discovery | Resource `https://mcp.eyes.pictures/mcp`; authorization server / issuer `https://mcp.eyes.pictures`. Metadata at `https://mcp.eyes.pictures/.well-known/oauth-protected-resource` and `https://mcp.eyes.pictures/.well-known/oauth-authorization-server`, each with a `/mcp` variant. |
| OAuth endpoints | `https://mcp.eyes.pictures/oauth/authorize`, `https://mcp.eyes.pictures/oauth/token`, and dynamic registration at `https://mcp.eyes.pictures/oauth/register`. |
| Card origins | ChatGPT `openai/widgetDomain`: `https://mcp.eyes.pictures`; Claude `_meta.ui.domain`: `87d4a8d03df273ec472729285f051938.claudemcpcontent.com` (first 32 hex characters of SHA-256 of the exact new connector URL). |
| REST, uploads and webhooks | Stay at `https://api.eyes.pictures`; existing API keys and optional gateway configuration stay unchanged. Existing `api.eyes.pictures/mcp` connectors retain their API-host OAuth issuer and card origins. |

For a new connector, use the dedicated host in the web steps above. Only when an owner chooses to migrate another existing connector, change its MCP URL to `https://mcp.eyes.pictures/mcp` and reconnect through OAuth. Leave REST URLs unchanged. See [DEPLOY.md](DEPLOY.md#dedicated-mcp-domain-live) for dated verification evidence.

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

For new direct connections, use these same bearer configurations with the URL changed to `https://mcp.eyes.pictures/mcp`. The legacy API-host connector and optional gateway remain supported.

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

Use `https://mcp.eyes.pictures/mcp` for new app connectors; the legacy `https://api.eyes.pictures/mcp` remains supported. Card sandbox origins are derived from the exact connector URL, so use the matching direct host rather than the optional gateway for app cards.

In ChatGPT and Claude, `quote_task`, `ask_eyes`, `await_answer`, `get_task`, `show_task` and `get_balance` share `ui://eyes/card.html`. It shows quotes, task status, photos/checks or the balance/top-up link. Other tools reply in text.

### ChatGPT

Use the [ChatGPT web steps above](#chatgpt-web-no-terminal-required). Do not paste a curl command into ChatGPT's server URL field.

### Claude (claude.ai and Claude Desktop connectors)

Use the [Claude web steps above](#claude-web-no-terminal-required) for new connectors. Existing API-host connectors can stay unchanged.

When OAuth creates a key, click **Continue to your app** to finish connecting; the app receives the key automatically. **Copy** is optional for direct API access, and the key is shown only once. **Copied** confirms success; if clipboard access is unavailable or denied, select the displayed key and copy it manually. Copy never submits the page or follows **Continue**.

### Fallback for every other client

For every other client, the dedicated MCP URL also works without the optional gateway. If the gateway returns errors (for example `402` once its plan's monthly credits run out), replace the section 2 URL with `https://mcp.eyes.pictures/mcp`. Existing API-host connectors remain supported.

```sh
claude mcp add --transport http eyes https://mcp.eyes.pictures/mcp \
  --header "Authorization: Bearer $EYES_API_KEY"
codex mcp add eyes --url https://mcp.eyes.pictures/mcp --bearer-token-env-var EYES_API_KEY
```

## Troubleshooting

- **401 `Missing or invalid API key`.** The header is missing, or the key was rotated. Check that the value is `Bearer <api_key>`, including the word `Bearer`.
- **`0 workers nearby`.** The quote still works. A task waits for a worker, and `cancel_task` refunds it before anyone accepts it.
- **Text, not cards.** Expected in every client except ChatGPT and Claude connectors on the direct URL.
- **Out of money.** Call `get_balance`. The reply includes a top-up link.

## How the sign-in works (for operators)

- **Discovery:** both hosts serve `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, including their `/mcp` variants. The dedicated resource is `https://mcp.eyes.pictures/mcp` with issuer `https://mcp.eyes.pictures`; the legacy API host retains its matching resource and issuer. A 401 challenge points to the same host's resource metadata.
- **Registration:** `POST /oauth/register` is dynamic client registration. Only https redirect URIs are accepted, plus loopback http.
- **Sign-in page:** `GET /oauth/authorize`. It requires PKCE S256. **Create a key** counts against the same per-IP limit as `/v1/signup` (5 per hour).
- **Token:** `POST /oauth/token` returns the Eyes API key as the access token, so existing bearer clients work unchanged. The token does not expire. To revoke it, rotate the key.
- **Server secret:** set `EYES_OAUTH_SECRET` to at least 32 random characters, for example from `openssl rand -hex 32`. Without it, the OAuth routes are off and only bearer keys work. If you change the secret, open sign-in pages and registered clients stop working; connected apps just register and sign in again.
- **Card origins:** ChatGPT uses `openai/widgetDomain` matching the connector origin. Claude `_meta.ui.domain` is the first 32 hex characters of SHA-256 of the exact connector URL plus `.claudemcpcontent.com`; the dedicated-host value is listed above. Both `resources/list` and `resources/read` expose matching metadata.
- **Photos:** the widget CSP allows `https://pagp38bu.us-west.insforge.app` and `https://cdn.insforge.dev`.
- **Manufact gateway:** external server `Eyes` (slug `dark-steel-ofaoa`) in the operator's Manufact org, in proxy mode, with upstream `https://api.eyes.pictures/mcp`. It does not inject a key for public traffic: an unauthenticated request gets the upstream 401. The dashboard's own bearer key is used only by Manufact's Chat, inspector and checks.
