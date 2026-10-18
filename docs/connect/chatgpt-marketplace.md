# Eyes public plugin package

The source package is [`plugins/eyes`](../../plugins/eyes). It contains only a portable `plugin.json`, a remote `mcp.json`, and listing images. No skills, hooks, local server, account credentials or fixed authorization headers are bundled. REST clients continue to use `https://api.eyes.pictures`; this package connects to `https://mcp.eyes.pictures/mcp`.

## Build

Run from `plugins/eyes` after validating the referenced assets:

```sh
python3 -m zipfile -c /tmp/eyes-1.0.0.zip plugin.json mcp.json assets
```

Keep ZIPs and validation reports outside the repository. The package uses OAuth dynamic client registration, not a bundled API key. Discovery currently advertises registration at `/oauth/register`, PKCE `S256`, and public-client token authentication (`none`). Connecting still requires an Eyes account and user authorization. Do not rotate or replace existing keys or OAuth secrets to install this package.

Only the portal owner should upload this ZIP. Publisher identity and reviewer credentials must come from the intended, authenticated Platform organization. No portal upload, submission, policy attestation or publication is performed by the packaging work.

## Validation contract

Use the actual [portable plugin schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json) and [portable MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json), and the current OpenAI [package reference](https://developers.openai.com/plugins/build/plugins) and [submission field reference](https://developers.openai.com/plugins/deploy/submission).

The portable plugin schema accepts this manifest. A strict, unmodified portable MCP schema does **not** accept the documented OpenAI authentication extension: the fetched 1.0.0 schema sets `additionalProperties: false` on each server and does not declare `extensions`. OpenAI's package reference explicitly requires `mcpServers.eyes.extensions.com.openai.auth`. The package preserves that documented OAuth declaration instead of silently removing it. Report strict validation as failed, validate the portable server fields separately, and require the portal's actual validation result before declaring the package upload-valid. Do not describe this mismatch as a passed official schema check.

Validate all image paths, supported image formats, square icons of at least 48 pixels, image dimensions no larger than 4096 pixels, and files no larger than 5 MiB. Reject absolute or parent-traversal archive paths, symlinks, credentials, nonempty headers, user data and unrelated files. Only package source and listing images belong in the ZIP; validation evidence and review access instructions stay outside.

## Listing and review status

`interface.developerName` and root `author` are deliberately absent because no verified publisher identity was available. The display name of a remembered login account is not evidence of a verified developer identity. `developerName` is required for submission: the portal owner must obtain the actual selected identity, add its name to this package and revalidate. No placeholder publisher is used. Country targeting is omitted rather than inventing supported countries.

All seven listing PNGs are local package files. The screenshots show a legacy developer-mode connection at `https://api.eyes.pictures/mcp`, a quote with no nearby workers, and a 20 USD test balance; the original Top up action and DEVELOPMENT status are not hidden. They do not establish a working authenticated connection on the new hostname. Public asset uploads and repository publishing remain deferred. The user subsequently authorized the portal owner to upload this ZIP as a draft, not to submit or attest compliance. `review.demo_recording_url` is absent: the reserved asset URLs have not been published and must not be presented as working review materials.

The manifest contains exactly five positive and three negative scenarios. **None has been executed by the package author with a dedicated review identity.** Review requires an existing dedicated test account with appropriate sample data, entered only through the secure portal form. An authenticated live `tools/list` was not obtained; an unauthenticated POST was blocked by Cloudflare with HTTP 403/error 1010. Do not retry that blocked client or treat the result as proof of browser unavailability. Public discovery and GET reachability are separate from authenticated functionality.

The source declares 13 MCP tools: `quote_task`, `ask_eyes`, `report_classifier`, `get_classifier_report`, `await_answer`, `get_task`, `show_task`, `list_tasks`, `cancel_task`, `accept_answer`, `dispute_answer`, `get_balance` and `get_spend_policy`. `show_task` is MCP-only; the other 12 are in the shared tool schema. This is a source inspection, not a verified live registry count. `accept_answer` records positive feedback only; it is not answer verification or payment.

| Case | Expected tools | Execution status |
| --- | --- | --- |
| P1: public-place coverage preview | `quote_task` | Not run with a reviewer account |
| P2: test balance | `get_balance` | Not run with a reviewer account |
| P3: spending limits | `get_spend_policy` | Not run with a reviewer account |
| P4: recent task history | `list_tasks` | Not run with a reviewer account |
| P5: existing completed sample answer | `list_tasks`, `get_task`, `show_task` | Not run; completed sample task also required |
| N1: private-person surveillance | None; refuse | Not run |
| N2: unspecified shop | None; clarify | Not run |
| N3: another account's history/credentials | None; refuse | Not run |

These read-only positive cases intentionally do not send real worker texts or create paid requests. They do not establish dispatch, waiting, refunds, disputes, acceptance, or the full worker lifecycle. Those flows need separately authorized, controlled review evidence before a submission can claim complete functionality. A quote/balance video is not evidence that all eight scenarios passed.

## Facts that must remain visible

- Payments currently run in **Stripe test mode**; no real money moves. Published service documentation describes a 20 USD test grant at signup and a prepaid top-up flow. A provider status of `payments: live` means the Stripe integration is enabled, not that its account uses real money.
- Coverage depends on nearby workers. With no nearby workers, `ask_eyes` returns `status: not_sent`, no task ID and zero charge. Do not promise a completed answer or create requests merely to populate review data.
- Photo moderation rejects only confirmed graphic gore or explicit sexual content. It does not judge whether an answer is correct. Request safety is a separate layer and restricts targeting people, homes or vehicles, trespassing, and dangerous or illegal work.
- The [current privacy policy](https://eyes.pictures/privacy) still promises face-photo rejection and deletion. That differs from the documented/source moderation behavior above. The package does not edit the legal page or assert that these practices match. The owner must resolve the discrepancy before a privacy attestation.

## Submission blockers outside the package

1. The selected verified developer identity has not been supplied to the package author, so `developerName` is absent. Actual portal validation, including the documented OAuth extension, remains to be observed by the draft-upload owner.
2. No existing dedicated reviewer account or completed sample task was supplied; authenticated registry, eight review cases and end-to-end behavior remain unverified.
3. Current [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines) say trial/demo plugins are not accepted and limit commerce to physical goods, with restrictions on services, credits and direct checkout links. Eyes provides human-check services using a prepaid test balance. Eligibility is unresolved, not approved or definitively rejected by this package author. The commerce declaration preserves the real behavior.
4. The public privacy promise and source/documented photo moderation behavior differ; owner remediation is required before attesting compliance.
5. No reviewer-accessible walkthrough URL is available; new public media uploads are deferred. Any audited local recording remains local-only until separately authorized.

Do not submit or publish until the responsible owner resolves these issues. [Public support](https://github.com/ayaangazali/eyes/issues), [privacy](https://eyes.pictures/privacy), and [terms](https://eyes.pictures/terms) were reachable at package preparation. Terms and privacy are linked unchanged, not rewritten or implicitly accepted by the package build.
