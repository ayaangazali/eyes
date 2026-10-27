# ADR-043: Redeem each OAuth authorization code once

Status: accepted

## Decision

After expiry, client, redirect and PKCE checks pass, hash the decoded authorization code with SHA-256.
Insert that hash through `eyes_redeem_oauth_code` before returning the API key.
A primary key and `INSERT ... ON CONFLICT DO NOTHING RETURNING` permit one winner across server processes.
An empty result means HTTP 400 `invalid_grant`.
Database failures stop the exchange without returning a token.

Enable row-level security on `oauth_code_redemptions` and revoke public execution of the RPC.
Use the existing server database role and RPC adapter.
Store no authorization code or API key in the new table.
Hash decoded bytes so alternate base64 encodings cannot bypass the unique constraint.

## Consequences

OAuth now requires the database RPC dependency.
Redemption records survive restarts and remain stored; no new cleanup job runs.
Existing sealed clients, five-minute codes and bearer API keys remain compatible.
Token expiry, refresh, resource binding, CORS and CSP remain unchanged.
