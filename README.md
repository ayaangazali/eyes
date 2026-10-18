<h1 align="center">👀 Eyes</h1>

<div align="center">

**Your agent asks a question about a real place. A nearby person takes a live photo and answers it.**

[![CI](https://img.shields.io/github/actions/workflow/status/ayaangazali/eyes/ci.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=CI)](https://github.com/ayaangazali/eyes/actions/workflows/ci.yml)
[![Live](https://img.shields.io/badge/live-eyes.pictures-2563eb?style=for-the-badge)](https://eyes.pictures)
[![MCP](https://img.shields.io/badge/MCP-api.eyes.pictures%2Fmcp-0d9488?style=for-the-badge)](docs/CONNECT.md)

[Site](https://eyes.pictures) · [Worker app](https://app.eyes.pictures) · [Connect](docs/CONNECT.md) · [Deploy](docs/DEPLOY.md) · [Status](STATUS.md)

<img src="apps/web/landing/public/images/storefront.webp" alt="A corner cafe on 18th St with an OPEN sign on the door and a chalkboard menu on the sidewalk" width="720">

*The kind of photo Eyes returns: is the cafe open right now? The sign says yes.*

</div>

Agents can read the internet but cannot see the street. Eyes is an MCP server that lets an agent pay a nearby person about $3 to go and look. Built for YC's "Make Something Agents Want" hackathon (Oct 17-18, 2026) by Ayaan, Jerry and Shryuk.

## Features

- **[MCP tools](docs/features/mcp-tools.md):** 9 tools to quote, ask, wait and pay; also REST.
- **[ChatGPT and Claude apps](docs/features/chatgpt-claude-apps.md):** OAuth sign-in; answers show as photo cards.
- **[iMessage dispatch](docs/features/imessage-dispatch.md):** the 3 nearest workers get a text; first YES wins.
- **[Photo checks](docs/features/photo-checks.md):** GPS within 150 m, taken live, safe to share.
- **[Escrow](docs/features/escrow.md):** bounty plus $0.50 fee held on ask; refunded if no answer.
- **[Safety](docs/features/safety.md):** rules, then an AI check; homes, people, cars, faces refused.
- **[Owner controls](docs/features/owner-controls.md):** spend caps, allowed task types, key rotation.
- **[Worker location](docs/features/worker-location.md):** HERE links, a Shortcut or the iPhone app.
- **[Ops dashboard](docs/features/ops-dashboard.md):** `/ops`: tasks, money, reviews, tickets, live map.

## Quick start

1. **Get a key:** no dashboard needed; the test balance is $20.

   ```sh
   curl -X POST https://api.eyes.pictures/v1/signup \
     -H "content-type: application/json" -d '{"name":"my-agent"}'
   ```

2. **Connect:** from Claude Code (ChatGPT, claude.ai, Claude Desktop and Cursor are in [docs/CONNECT.md](docs/CONNECT.md)):

   ```sh
   claude mcp add --transport http eyes https://api.eyes.pictures/mcp \
     --header "Authorization: Bearer $EYES_API_KEY"
   ```

3. **Ask:** `claude -p 'Use quote_task to check the line at the Ferry Building, San Francisco'`

Prefer the Manufact CLI? `npx -y mcp-use@2.10.1 client connect eyes https://api.eyes.pictures/mcp --protocol legacy -H "Authorization: Bearer $EYES_API_KEY"`. To be a worker, open https://app.eyes.pictures on an iPhone. Until workers have opted in near a place, `ask_eyes` there returns `no_workers_nearby` and charges nothing. https://api.eyes.pictures/status says which parts are live.

## How it works

The agent asks and pays; Eyes texts nearby workers, checks the photo and pays the worker. Every transport calls one `EyesService`, and each money move is one plpgsql function, so it runs in one transaction ([ADR-003](intent/decisions/ADR-003-seams-and-ownership.md)). The full flow is in [docs/SPEC.md](docs/SPEC.md).

```mermaid
sequenceDiagram
    participant A as Agent (MCP / REST)
    participant E as Eyes API (Cloudflare Container)
    participant W as Worker iPhone (iMessage)
    participant C as Capture page (app.eyes.pictures)
    A->>E: quote_task, then ask_eyes
    E->>E: safety check, escrow $3.50 (InsForge Postgres)
    E->>W: offer text (Inkbox)
    W->>E: YES (first YES wins)
    E->>W: capture link
    W->>C: live photo + GPS
    C->>E: upload (InsForge storage)
    E->>E: GPS, freshness, moderation (clef, Claude if unsure)
    A->>E: await_answer (long poll, 55 s per call)
    E-->>A: answer, photo, checks
    E->>W: $3 Stripe Connect transfer + paid text
```

## Repository layout

- [`apps/mcp/`](apps/mcp/): API server: MCP tools, REST, webhooks, OAuth, `/status`.
- [`apps/edge/`](apps/edge/): Cloudflare Workers: API front, cron, uptime monitor.
- [`apps/web/`](apps/web/): landing site, worker app and the `/ops` dashboard.
- [`apps/mobile/`](apps/mobile/): Expo iPhone app that sends background location.
- [`packages/`](packages/): core, engine, db, comms, payments, safety, verify, ui.
- [`cli/`](cli/): the `eyes` CLI and generated agent docs (`llms-full.txt`, OpenAPI).
- [`scripts/`](scripts/): live smoke, owner link, task resolve, migrations, intent check.
- [`evals/`](evals/), [`e2e/`](e2e/): safety evals and the Playwright golden path.
- [`intent/`](intent/): why each file exists ([INDEX](intent/INDEX.md)), ADRs, verdicts.

## More docs

- [Connect from ChatGPT, Claude, Claude Code and Cursor](docs/CONNECT.md)
- [Deploy, live smoke, roll back, alerts](docs/DEPLOY.md)
- [Spec](docs/SPEC.md)
- [Status and live verification](STATUS.md)
- [Plan](docs/PLAN.md)
- [Demo runbook](docs/DEMO.md)
- [Decisions (ADRs)](intent/decisions)
- [Agent docs: llms.txt](docs/public/llms.txt)
- [Report a bug](../../issues/new)

To develop locally you need Node 24, pnpm and Docker: `pnpm install && pnpm verify:fast` runs lint, typecheck, unit, contract, safety fixtures and the intent check without a database (941 tests on 2026-10-17). `pnpm db:up && pnpm db:migrate && pnpm test:integration` adds Postgres, and `pnpm test:e2e` runs Playwright on fakes.

## Built with

Every outside provider and service Eyes uses, and how. "Live" means the deployed server at api.eyes.pictures uses it today; "test" means it runs in a sandbox or test mode, so no real money moves.

| Provider | What Eyes uses it for | Where in the repo | Status |
|---|---|---|---|
| Cloudflare Workers | `eyes-api` Worker fronts the API on `api.eyes.pictures`; static Workers serve `eyes.pictures` and `app.eyes.pictures` | [apps/edge/api](apps/edge/api), [apps/web/landing](apps/web/landing), [apps/web/worker](apps/web/worker) | live |
| Cloudflare Containers | Runs the API server image (repo [Dockerfile](Dockerfile), Node, port 3000) | [apps/edge/api/wrangler.jsonc](apps/edge/api/wrangler.jsonc), [docs/DEPLOY.md](docs/DEPLOY.md) §2 | live |
| Cloudflare Durable Objects + Cron | One `EyesServer` object keeps a single container; a once-a-minute cron calls it so the container never idles out | [apps/edge/api/worker.js](apps/edge/api/worker.js) | live |
| Cloudflare KV + Cron | `eyes-monitor` checks `/healthz` every minute, keeps state in KV, texts an alert after two failures | [apps/edge/monitor](apps/edge/monitor) | live |
| Cloudflare DNS | `eyes.pictures` zone and the three custom domains | wrangler configs above | live |
| Cloudflare Workers AI (`clef-omni`) | First-pass task safety classifier and photo moderation (safe / faces) | [packages/safety](packages/safety), [packages/verify](packages/verify) | live |
| Cloudflare Browser Integrity rule | Zone security setting on the domains | Cloudflare dashboard only, not in the repo | live (not verifiable from the repo) |
| InsForge | Postgres with RPC functions and RLS for the ledger, claims and expiry; migrations through the migrations endpoint | [packages/db](packages/db), [scripts/insforge-migrate.ts](scripts/insforge-migrate.ts) | live |
| InsForge Storage | Public `photos` bucket for captures; face-rejected photos are deleted ([ADR-014](intent/decisions/ADR-014-delete-face-photos.md)) | [packages/db](packages/db) | live |
| InsForge Sites | Earlier host of the worker web (`*.insforge.site`); replaced by `app.eyes.pictures` | [docs/DEPLOY.md](docs/DEPLOY.md) §3 | earlier |
| Stripe | Checkout top-ups, Connect Express onboarding, $3 transfers on verified answers, transfer reversals on confirmed fraud, signed webhooks | [packages/payments](packages/payments) | test mode |
| Inkbox | Shared iMessage line: inbound webhook, offer and paid texts, START/STOP/HELP/HERE replies, texts with location codes and the app link; uptime alerts | [packages/comms/src/inkbox.ts](packages/comms/src/inkbox.ts) | live |
| Inkbox (limitation) | An iMessage "Share My Location" arrives as a lone U+FFFD, so Eyes replies with a HERE link instead ([ADR-024](intent/decisions/ADR-024-worker-location.md)) | [packages/comms](packages/comms) | live |
| Primitive | Each agent's private email inbox ([ADR-007](intent/decisions/ADR-007-agent-email-identity.md)), inbound webhooks, owner console emails, ops login codes | [packages/comms/src/primitive.ts](packages/comms/src/primitive.ts) | live |
| Anthropic Claude | Fallback safety classifier and photo vision when clef is unsure or fails; used alone if Cloudflare is not configured | [packages/safety](packages/safety), [packages/verify](packages/verify) | live |
| OpenStreetMap Nominatim | Geocodes place names in `quote_task` and `ask_eyes` | [apps/mcp/src/geo.ts](apps/mcp/src/geo.ts) | live |
| OpenStreetMap tiles + Leaflet (unpkg) | Maps on the ops dashboard and live map | [apps/web/dashboard](apps/web/dashboard) | live |
| Apple Maps / Google Maps links | Reads coordinates from map links a worker texts in; the capture page links to Google Maps directions | [packages/core/src/util.ts](packages/core/src/util.ts), [apps/web/worker/src/capture.ts](apps/web/worker/src/capture.ts) | live |
| mcp-use | MCP server framework for the 9 tools and widgets | [apps/mcp](apps/mcp) | live |
| Manufact | The CLI connect path on the landing page; Manufact Cloud was the earlier host | [apps/web/landing](apps/web/landing), [docs/DEPLOY.md](docs/DEPLOY.md) | CLI live, hosting earlier |
| OpenAI Apps SDK / MCP Apps | ChatGPT app and Claude connector cards (quote, task, balance) with OAuth sign-in | [apps/mcp](apps/mcp), [docs/CONNECT.md](docs/CONNECT.md) | live |
| Expo / React Native + Apple | iPhone app that sends background location; TestFlight link sent once Apple approves the beta | [apps/mobile](apps/mobile) | TestFlight pending |
| ClickHouse | Optional copy of the ops event log and Trends charts; Postgres stays the source of truth | [apps/web/dashboard/src/clickhouse.ts](apps/web/dashboard/src/clickhouse.ts) | optional, off on the host |
| Astro, Tailwind, GSAP | Landing and worker web; Better-T-Stack conventions | [apps/web](apps/web) | live |
| Playwright, Vitest, Biome | E2E, unit/contract/safety/integration tests, lint and format | [e2e](e2e), [vitest.config.ts](vitest.config.ts), [biome.json](biome.json) | test |
| GitHub | Code, PRs, issues; Actions run CI, live smoke and the safety LLM eval | [.github/workflows](.github/workflows) | live |

`.env.example` also lists keys for Armature analytics and Blaxel sandboxes; no code uses them yet.
