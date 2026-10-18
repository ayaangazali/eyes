# Connect Eyes to Instinct

[Instinct](https://instinct.com/) is a personal AI agent you text, call or email. It runs in the cloud, on its own phone and computer, and you manage it at [app.instinct.com](https://app.instinct.com/login).

MCP server URL: `https://api.eyes.pictures/mcp`

Instinct does not publish setup steps for custom MCP servers. Its own Granola connector already uses the standard MCP OAuth sign-in, which is the same sign-in Eyes uses. Ask the Instinct team to confirm that custom MCP servers are on for your account before you start.

## What Instinct needs

| Setting | Value |
| --- | --- |
| Transport | Streamable HTTP, `POST https://api.eyes.pictures/mcp`. There is no SSE-only endpoint and no stdio server. |
| Sign-in, option 1 | OAuth 2.1 with PKCE S256. Discovery starts from the 401 on `/mcp`. Eyes accepts both client styles: dynamic client registration (`POST /oauth/register`), or an https URL as `client_id` pointing to a client metadata document (MCP 2025-11-25). Any https redirect URI is accepted. |
| Sign-in, option 2 | Header `Authorization: Bearer eyes_test_...` |
| Tools | 10: `quote_task`, `ask_eyes`, `await_answer`, `get_task`, `show_task`, `list_tasks`, `cancel_task`, `dispute_answer`, `get_balance`, `get_spend_policy` |

Instinct runs in the cloud, so it needs the remote URL. A local stdio bridge on your own computer does not help.

## Steps

1. Text your Instinct: "Connect the Eyes MCP server at https://api.eyes.pictures/mcp". If Instinct asks for an API key instead of opening a sign-in link, get one with the command below and give it the header `Authorization: Bearer <key>`.
2. Instinct sends you a link. It opens the Eyes sign-in page at `api.eyes.pictures/oauth/authorize`.
3. On that page, paste your Eyes API key, or click **Create a key**. A new test key starts with a $20 balance. The page shows the key once, so save it.
4. Continue. The browser goes back to Instinct, and Instinct can now use the Eyes tools.
5. Test it. Text: "Use Eyes to quote checking whether the Ferry Building in San Francisco is open." Instinct should reply with a price (about $3) and how many people are nearby. It spends nothing until you ask it to send the task.

Get a key without the sign-in page:

```sh
curl -s -X POST https://api.eyes.pictures/v1/signup \
  -H 'content-type: application/json' \
  -d '{"name": "instinct"}'
```

## Troubleshooting

- **The link says "invalid_redirect_uri".** Eyes accepts only https redirect URIs, plus http on localhost. Send the exact redirect URI to the Eyes team.
- **"Eyes could not use this app's client metadata".** Instinct sent a URL as `client_id`, and its document failed a check. The message names the check. The document must be public https JSON under 5 KB, served within 5 seconds, with `client_id` equal to its own URL and the redirect URI listed in `redirect_uris`.
- **"0 workers nearby".** The quote still works. The task waits for a worker, and you can cancel it with `cancel_task` before anyone accepts it.
- **Instinct shows text, not cards.** That is expected. The Eyes cards are for ChatGPT and Claude. In Instinct, every tool replies in text.
- **401 from `/mcp`.** The key is missing or rotated. Connect again, or send a new key.
- **Out of money.** Ask Instinct to call `get_balance`. It replies with a top-up link.
