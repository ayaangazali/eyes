# Load testing Eyes safely (research, 2026-10-18)

Run only the approved, post-rollout **read-only pass: 1 → 3 → 5 global requests/second, at most 120 seconds and eight in-flight requests**. Put lifecycle, financial races and long waits in an isolated real-Postgres environment with fake providers. These are conservative starting limits, not measured capacity or vendor limits.

This note is research and a proposed test design, not a test result. No traffic, credentials, cloud changes or application changes were needed for this research. Main owns authorization and release coordination; do not measure through a deployment. Source-code observations below describe the inspected checkout, not proof of what is deployed.

## 1. Safety boundary

1. Freeze the deployed revision for the measurement window. Record revision, runtime/SDK versions, host, client region, scenario, pool size and exact start/end times. A changed revision invalidates comparison; wait for the marketplace release to stabilize.
2. Allowlist method **and** path or MCP method/tool. Use existing authorized identity supplied by the operator, never create accounts or read credentials for research. Production candidates are `GET /healthz`, `GET /v1/balance`, `GET /v1/tasks?limit=2`, and MCP `tools/list`, `resources/list`, `get_balance`. Verify current handlers before execution; do not follow returned top-up, capture or onboarding links. Record only timings/status/schema outcomes, not private task contents or tokens.
3. Exclude every production write, including REST/CLI direct ask, interactive `ask_eyes`, private app-only `confirm_ask`, cancellations, claims, disputes, signups, OAuth registration/token churn, webhooks and photo uploads. The marketplace contract makes interactive ask a read-only draft, but that is not permission to load it: older or other transports remain direct paid creation. Tool annotations are not a safety boundary. Exclude quote from the first load mix: `resolve()` calls a geocoding provider for string locations (`packages/engine/src/index.ts:310–314,613–623`).
4. Keep **all external providers outside generated load**: Stripe, Inkbox, Primitive, AI moderation and geocoding. Stripe explicitly says not to load-test testing environments; its load-testing guidance recommends mocking API calls and explains why sandbox latency is not production latency. Use configurable fake latency, labelled as synthetic, not claimed provider performance. [Stripe testing](https://docs.stripe.com/testing), [Stripe load testing](https://docs.stripe.com/rate-limits#load-testing).
5. Begin with smoke, then a simple ramp/plateau/down. Do not run a stress test, spike, breakpoint search or long soak against this shared production deployment. Grafana explicitly recommends smoke first and says no single test covers all risks. [k6 test types](https://grafana.com/docs/k6/latest/testing-guides/test-types/).

## 2. Match the installed MCP, not the latest documentation

**The inspected SDK defaults to the 2025 initialization protocol.** The unversioned architecture URL currently redirects to [2026-07-28 architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture), which describes stateless metadata and `server/discover`. Do not import those assumptions into this test.

Local evidence: `pnpm-lock.yaml` and the installed `@modelcontextprotocol/client/package.json` identify **2.3.1**. In its installed `dist/index.mjs`, `DEFAULT_VERSION_NEGOTIATION_MODE` is `"legacy"` at line 2559; `connect()` selects `_connectPlainLegacy()` at 3321–3325; `_legacyHandshake()` sends `initialize`, then `notifications/initialized`, at 3348–3369. The installed core `dist/auth-BNDyLTqp.mjs:4–12` lists `2025-11-25` first, then `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`. Thus an unconfigured client **offers 2025-11-25**. Record the actual server response version and capabilities; this research did not observe a live negotiation. If the server selects another supported revision, consult that revision before further testing. No migration is proposed.

Use these matching official specifications: [lifecycle/version negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

- **Connection and session:** initialize once for the bounded pass, record cold setup separately, then reuse the SDK client/transport. Send the negotiated `MCP-Protocol-Version` subsequently. Preserve `MCP-Session-Id` if the server returns one; do not assume sessions exist merely because initialization exists. Session management is optional. Do not synthesize session headers or add reconnect storms.
- **Streaming:** POST advertises both `application/json` and `text/event-stream`; either response form is valid. Consume until the matching terminal JSON-RPC response, not HTTP headers, the first SSE event or a progress notification. A notification accepted with HTTP 202 is not a tool result. Optional GET SSE may validly return 405; identify it separately from failed tool POSTs. Count background GETs/connections in the global ceiling.
- **Termination:** a disconnected stream is not protocol cancellation. In isolation, test explicit cancellation, client disconnect and cleanup separately. Resume with `Last-Event-ID` only when the server actually supplies resumable events; do not assume replay support. Preserve authentication on every relevant request, and never forward credentials across an unapproved redirect.
- **Auth and caching:** live load uses an already-authorized identity on the intended host (`mcp.eyes.pictures` for MCP; `api.eyes.pictures` for REST). Read-only OAuth metadata/challenge smoke is distinct from completing OAuth; a key-authenticated test does not prove ChatGPT/Claude OAuth works. The installed SDK's list methods can return cached data: use the actual **`cacheMode: "bypass"`** request option (`dist/index.mjs:3779,3847`), not `cache: "bypass"`, and verify network counts. Separate client-cache hits, Cloudflare cache hits and origin work rather than combining them.

## 3. Modest live workload and stop conditions

Use one global scheduler across both hosts, **not 5 RPS per route or scenario**. One scheduled work item should issue one measured read, rather than a multi-request business journey. Schedule independently of completion; when the eight-request/stream ceiling is reached, record a missed arrival and stop instead of queuing a catch-up burst. Arrival-rate scheduling avoids the feedback where slow responses reduce offered traffic and conceal overload (“coordinated omission”). A fixed concurrency model remains appropriate when concurrent waiters themselves are the question. [k6 open versus closed models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/).

Proposed short-read mix, deliberately not a claim about customer traffic:

| Operation | Share | Check |
| --- | ---: | --- |
| REST balance | 25% | Expected status and numeric balance/escrow fields |
| REST tasks, limit 2 | 25% | Expected list schema and bounded item count |
| MCP get_balance | 25% | Matching result, no JSON-RPC error or `isError`, valid structured output |
| MCP tools/list | 15% | Required safe tool entries/schema; bypass SDK cache |
| MCP resources/list | 10% | Expected resource schema; bypass SDK cache |

Health and metadata are smoke controls, not the bulk of a DB-capacity test. This mix exercises authentication, small DB reads and MCP serialization without paid work. It does not exercise photo transfer or quote/provider performance.

An illustrative **120-second total budget**, including setup/warmup/drain:

| Window | Activity |
| --- | --- |
| 0–20 seconds | Smoke and one cold MCP connection, then warm reads, at most 1 RPS |
| 20–60 seconds | Ramp 1 → 3 over 20 seconds; hold 3 for 20 seconds |
| 60–105 seconds | Ramp 3 → 5 over 20 seconds; hold 5 for 25 seconds |
| 105–115 seconds | Ramp 5 → 0 |
| 115–120 seconds | No new arrivals; bounded drain/cleanup |

The operator's approved harness may use different stage durations within the same ceilings. Give short reads a five-second deadline; bound cold setup separately within its allocated window. Keep cold connection/setup samples and warmup samples out of warm-RPC percentiles. “Cold client” means a new client connection, **not** a proven cold origin process or empty DB cache. Do not restart production or purge caches to manufacture cold starts.

**Stop immediately** on an unexpected 401/403, 429, 5xx, timeout, transport/JSON-RPC error, semantic failure, unexpected mutation/provider invocation, deployment change, or exhausted in-flight ceiling. Planned negative-auth smoke has its own expected-401 check and is not mixed into the success scenario. No automatic retries in the measured pass. Also stop for observed service-health degradation, a new persistent lock wait, or loss of agreed DB connection headroom; do not continue merely because the client is below 5 RPS. As provisional latency guardrails, stop after five consecutive short reads exceed two seconds or a route with at least 20 warm samples exceeds one-second p95. These are cautious experiment limits, not established Eyes SLOs.

For k6, functional `check()` failures alone do not fail the run: attach failure thresholds and abort behavior. A custom Node SDK harness must implement equivalent semantic checks and a shared abort controller. k6 supports percentile thresholds and `abortOnFail`; cloud evaluation can lag, so local immediate per-response safety stops are still needed. [k6 thresholds](https://grafana.com/docs/k6/latest/using-k6/thresholds/).

## 4. Isolated asynchronous waiter and financial tests

Use a disposable, migrated **real Postgres** database, fake providers and fixture-only identities/photos; disable external egress. Never use `--allow-remote` to reach the production database. Run the actual HTTP/MCP server when testing protocol behavior, not only direct service methods.

### Long requests are a separate workload

`awaitAnswer()` polls `eyes_task_detail` once per loop and sleeps up to `POLL_MS = 1000` (`packages/engine/src/index.ts:83,403–407,754–765`). It releases the query between polls; source does not show one transaction held open for the entire wait. The MCP wrapper reports progress when requested (`apps/mcp/src/server.ts:543–559`). This means an apparently idle waiter still produces database work.

Start with **1, then 5, then 10 concurrent pending waiters**, holding each level for two 55-second cycles, alongside a separate 1-RPS short-read stream. Use the real clock for these timing measurements and a 65-second client hard deadline. Model pending, terminal-already, answer-at-10-seconds, explicit cancellation and disconnected client in separate isolated cases. Assert correct task/result association, sensible progress, and eventual release of timers, streams and polling after completion/cancellation; allow an already-running DB query to finish. Test a genuinely pending fixture: an already-paid or missing task returns immediately and proves no long-wait capacity.

At steady state, arrival rate × mean duration approximates in-flight work: **5 new waits/second × 55 seconds ≈ 275 simultaneous waits**, whereas ten continuous waiters complete only about 10/55 ≈ 0.18 full waits/second. Ten pending waiters also imply roughly ten detail-query starts/second before query latency and other work, not ten requests total. These are workload estimates inferred from the code, not measurements. Progress cadence, full terminal latency, cancellation latency, active streams and short-read interference matter more here than HTTP time-to-first-byte. Do not put expected 55-second waits into short-read latency percentiles.

No long waiter is required in the initial production pass. A later live waiter needs its own approval and an already-existing authorized pending task; never create a paid task to obtain one.

### Concurrent business invariants

The existing **`scripts/swarm.ts`** uses real Postgres plus `fakeProviders()`, synthetic worker/account setup, direct service calls, and a sequential `await event.run()` loop (`184–228,250–350`). It is useful lifecycle coverage, but it neither generates concurrent races nor traverses HTTP/MCP, Cloudflare, SSE or OAuth. `live_payouts: true` there still uses a fake payment provider. Its final status tally is not a ledger invariant assertion.

Run independent requests on multiple DB connections, released by a shared start barrier. First repeat each small race 20 times with five contenders; inspect persisted rows and fake-provider call records after every run. Also test distinct accounts so one hot account is not mistaken for global capacity.

1. **Idempotent ask/confirmation:** identical concurrent requests with one key yield one task and one escrow debit; differing parameters with that key are rejected. Race confirmation retries and token replay through the new app boundary in isolation; drafts alone produce no task, debit or notification. Test recovery after a lost response. Stripe's own API-v1 idempotency stores the first executed result, including errors, and treats concurrent conflicts specially; it is not proof that Eyes' application ledger is correct. [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests).
2. **Spend limits:** distinct keys race against credit sufficient for only one task and against the daily cap. Assert no negative spendable balance or cap overshoot; rejected work creates neither a task nor an escrow debit. Reconcile integer cents across available funds, escrow and settled ledger movements.
3. **Claims and terminal transitions:** several workers claim one task, and one worker competes for several tasks where exclusivity is required. Exactly one valid claimant wins each exclusive resource. Race claim against cancellation/expiry; assert a legal state and no double release, refund-after-valid-claim, or pay-and-refund for the same obligation.
4. **Submission and settlement:** duplicate submission and repeated payout execution must not duplicate settlement. Inject provider success followed by a lost response, DB failure, provider timeout, and retry; assert one external monetary effect and matching ledger entries, or an explicit recoverable unsettled state. Rejected/moderation-review photos must not enter the successful payout path. Refund/dispute compensation must be separately accounted, never hidden by netting a duplicate payout against a later refund.
5. **Webhook delivery:** replay the same event ID concurrently; also test distinct event IDs referring to the same object/type, relevant out-of-order events and crash/retry between applying an effect and recording completion. Assert no duplicate credit/transfer and no regression of terminal state. Stripe documents duplicate delivery, separate duplicate Event objects and non-guaranteed ordering. Verify signatures locally with test-only secrets; never send these cases to production. [Stripe webhook duplicates](https://docs.stripe.com/webhooks#handle-duplicate-events), [ordering](https://docs.stripe.com/webhooks#event-ordering).

### Observe the database, not just HTTP

Use pre-authorized observability rather than adding load-test access. Snapshot baseline, during-run and recovery: active/idle/idle-in-transaction connections, pool wait where available, connection headroom, query duration, wait events, blocking PIDs and deadlock changes. `pg_stat_activity` exposes state and wait information; accumulated statistics can lag and remain cached inside a transaction. Sample in short transactions. [Postgres activity/statistics](https://www.postgresql.org/docs/18/monitoring-stats.html#MONITORING-PG-STAT-ACTIVITY-VIEW).

Row locks usually **do not appear directly** in `pg_locks`; waiters often appear as transaction-ID waits. Use `pg_blocking_pids()` rather than guessing a self-join, and avoid aggressive lock-view polling. [Postgres locks](https://www.postgresql.org/docs/18/view-pg-locks.html). Match the actual database major version before using version-specific columns; this research did not query the deployed database version.

InsForge officially exposes connection/slow-query/lock checks and instance CPU/memory/disk/network metrics through its diagnostics. If that access already exists, correlate those with the run; missing visibility is a stated limitation, not permission to change infrastructure. [InsForge diagnostics](https://insforge.dev/blog/introduce-debug-skills#database-health-checks). The repository supports both direct Postgres and HTTP InsForge RPC (`packages/db/src/rpc.ts:9–43`); record which path is actually deployed before attributing latency to either pool.

## 5. What to report, and what this cannot prove

Report these five groups separately for each route, transport and phase:

1. Scheduled arrivals, actual network starts/completions per second, useful successful operations/second, missed arrivals and peak in-flight work. Count initialization, notification POSTs, GET SSE and retries separately. SDK method-call counts are not network RPS.
2. **p50/p95/p99**, sample count and maximum for successful warm operations; separately count/time failures, timeouts and cancellations. Also report full MCP terminal-result duration, not only headers. A handful of samples cannot establish a trustworthy tail percentile.
3. HTTP status classes, JSON-RPC/tool errors and semantic-check failures. An HTTP 200 containing `isError` or the wrong schema is failure, not fast success.
4. Cold setup versus warm RPC, cache behavior, client scheduler lag/CPU and network timings where available; DB activity/locks/pool waits and server recovery where observable.
5. Exact revision, identity count, data size, host/region, rate schedule, duration, abort reason and observability gaps. Save sanitized results; no credentials or private payload dumps.

A clean bounded read-only run supports only: **these reads, on this revision, from this client, with this identity/data mix, at the achieved rates and observed concurrency, during this short window**. It cannot establish maximum throughput, 24-hour reliability, rare-event probability, global latency, cold-origin behavior, autoscaling, failover, large-dataset query performance or deployment safety. One reused client does not prove many-client/session capacity. Key-authenticated RPC does not validate marketplace OAuth, consent or host UI.

Local races with fake providers can expose application correctness defects but cannot certify real payment delivery, SMS/email delivery, photo-storage throughput, moderation quality, human availability or human response time. Fake provider sleeps are scenario inputs. Never combine LLM deliberation, a person's walk/photo time, the intentional 55-second wait and app processing into one “API latency” number. Keep marketplace work moving: this first pass is a small regression signal, not a release-capacity certificate.
