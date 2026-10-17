# Blaxel vendor note for Eyes (task T3.5, low priority)

Fetched: 2026-10-17. Sources:
- https://docs.blaxel.ai/llms.txt
- https://docs.blaxel.ai/Get-started.md
- https://docs.blaxel.ai/Sandboxes/Overview.md
- https://docs.blaxel.ai/Sandboxes/Processes.md
- https://docs.blaxel.ai/Sandboxes/Filesystem.md
- https://docs.blaxel.ai/Sandboxes/Expiration.md
- https://docs.blaxel.ai/Sandboxes/Variables-and-secrets.md
- https://docs.blaxel.ai/Sandboxes/best-practices.md
- https://docs.blaxel.ai/Jobs/Overview.md
- https://docs.blaxel.ai/Jobs/Develop-a-job.md
- https://docs.blaxel.ai/Jobs/Deploy-a-job.md
- https://docs.blaxel.ai/Jobs/Manage-job-execution-ts.md
- https://docs.blaxel.ai/Jobs/Variables-and-secrets-jobs.md
- https://docs.blaxel.ai/Security/Quotas.md
- https://docs.blaxel.ai/knowledge-base/troubleshooting/sandbox-limits-and-quota-exceeded-errors.md
- https://docs.blaxel.ai/Tutorials/Custom-Agents.md
- https://raw.githubusercontent.com/blaxel-ai/sdk-typescript/main/@blaxel/core/src/jobs/jobs.ts
- https://raw.githubusercontent.com/blaxel-templates/template-jobs-ts/main/src/index.ts
- Web search (third party, pricing only): https://blaxel.ai/llms.txt, https://agentdeals.dev/vendor/blaxel, https://apis.io/plans/blaxel/blaxel-plans-pricing/
- Local: docs/vendor/hackathon.md (prize row)

Page fetches return doc-summaries from a small model; code blocks below are as returned. Treat anything not marked verbatim as paraphrase.

## What Eyes uses it for
1. Run the eval / naive-agent verifier agents inside Blaxel sandboxes (isolated Node/TS runs that call our MCP server over HTTPS).
2. "Swarm" demo mode: a Blaxel batch job, about 50 tasks, each simulating an agent that calls POST /v1/signup then POST /v1/tasks on our REST API so the dashboard map lights up.
3. Prize: Blaxel "Something a Human Would Never Want", 1st = $1k cash (gift card), no criteria published (hackathon.md). Eyes is a human-checks-for-agents product, so the fit is thin and pitch-dependent. Blaxel is NOT in the golden path and must stay out of it: separate API key for the swarm, separate Eyes tenant or flag.

## Auth & setup
- CLI install (macOS/Linux): `curl -fsSL https://blaxel.ai/install.sh | sh` ; Homebrew: `brew install blaxel-ai/blaxel/blaxel` then `bl setup`. Installer also runs `bl setup` (adds agent skills/MCP, starts browser login). Source: Get-started.md.
- Login: `bl login` (browser). CLI in CI: https://docs.blaxel.ai/knowledge-base/security-and-authentication/how-to-authenticate-the-bl-cli-in-ci-environments.md (listed in llms.txt, not read).
- SDK auth env vars: `BL_WORKSPACE` (workspace name, visible in console URL `app.blaxel.ai/{workspace}`) and `BL_API_KEY`. Get the key at app.blaxel.ai/profile/security. Source: Get-started.md.
- Optional `BL_REGION` sets the default region (Sandboxes/Overview.md). Example region `us-pdx-1`.
- SDK: `npm install @blaxel/core` (package name per Get-started.md and Sandboxes/Overview.md). A web-search snippet showed `@blaxel/sdk` in an older page; use `@blaxel/core`.
- Credits: docs say nothing. Third-party listings say up to $200 free credits, no card, unused credits expire after one year, free quota tier about 10 sandboxes with 7-day max TTL (unverified, see below). Promotional credits do not unlock quota tiers (Quotas.md). Ask the Blaxel booth for hackathon credits.

## Sandboxes
Create (verbatim, Sandboxes/Overview.md and Get-started.md):
```ts
import { SandboxInstance } from "@blaxel/core";
const sandbox = await SandboxInstance.createIfNotExists({
  name: "my-sandbox",
  image: "blaxel/base-image:latest",
  memory: 4096,
  ports: [{ target: 3000, protocol: "HTTP" }],
  labels: { env: "dev" },
  region: "us-pdx-1",
});
```
- `SandboxInstance.create({...})` errors if the name exists; `createIfNotExists` reuses it. `SandboxInstance.get("name")`, `SandboxInstance.delete("name")`, `sandbox.delete()`.
- Images named: `blaxel/base-image:latest`, `blaxel/nextjs:latest`, `blaxel/py-app:latest`. Whether base-image has Node/npm preinstalled is not stated; check by running `node -v` first. Custom images via Templates (Dockerfile): https://docs.blaxel.ai/Sandboxes/Templates.md (not read).
- `memory` in MB; CPU follows memory (8 GB = 4 cores) and is not billed separately. No default memory stated, so always pass it.
- Env: creation-time `envs: [{ name: "K", value: "v" }]`; per process `env: { K: "v" }` (Variables-and-secrets.md).
- Run a command (Processes.md):
```ts
const r = await sandbox.process.exec({ command: "node /app/agent.js", workingDir: "/app", env: { EYES_API_KEY: "..." }, waitForCompletion: true });
console.log(r.exitCode, r.stdout, r.stderr);
```
  - Without `waitForCompletion`, exec returns once the process starts; output may be empty.
  - Non-zero exit does NOT throw; check `exitCode`.
  - `waitForCompletion` is capped at 60 s by Blaxel. For longer runs use `keepAlive: true` (default auto-kill 600 s, `timeout: 0` = never), then `sandbox.process.logs(name, "stdout")` or `streamLogs(name, { onStdout })`. `sandbox.process.kill(name)`. Give processes a `name`.
  - Port-wait calls: keep `timeout` under 120 s or the gateway returns 504.
- Copy files in (Filesystem.md): `sandbox.fs.write(path, string)`, `writeBinary(path, buf)`, `writeTree([{path, content}], "/dest")`, `read(path)`, `ls(path)`. Files over 5 MB are chunked automatically by the SDK. Pattern for us: `writeTree` the agent script, then `exec("npm i && node agent.js")`, then read stdout. There is no documented host-directory upload helper.
- Lifetimes (Expiration.md): no deletion by default. Set `ttl: "24h"` (units h, d, w), or `expires: Date`, or `lifecycle.expirationPolicies: [{ type: "ttl-idle", value: "24h", action: "delete" }]`. Quota tiers 0 and 1 enforce max TTL of 7 and 30 days. Idle sandboxes go to standby (resume under 25 ms, about 15 s to enter standby), not deleted. Set a short TTL for demo sandboxes so they self-clean.
- Cost: billed per second of active use; standby only storage (third-party, unverified). Delete sandboxes when done.
- Reserved ports: 443, 80, 8080 (Overview.md). Connections do not survive standby (best-practices.md).
- Secrets: recommended route is the Blaxel proxy injecting `{{SECRET:name}}` into outbound HTTPS (Variables-and-secrets.md). Not needed for a throwaway demo key; plain `env` is fine.

## Batch jobs
- Model: job = code definition; execution = one run; task = one instance within an execution (Jobs/Overview.md).
- Scaffold: `bl new job` (entrypoint `src/index.ts`, or `src/main.py`). Template repos: `blaxel-templates/template-jobs-ts`. Template wraps a function with `blStartJob` from `@blaxel/core` (and `@blaxel/telemetry`); the function receives the task's argument object (e.g. `name`).
- `blaxel.toml` (verbatim, Deploy-a-job.md):
```toml
type = "job"
name = "my-job"
[runtime]
memory = 1024
maxConcurrentTasks = 10
timeout = 900
maxRetries=0
```
  `timeout` is seconds per execution; `maxRetries` is per task; `maxConcurrentTasks` is parallelism. For 50 simulated agents set `maxConcurrentTasks = 50` or lower (tier quota applies).
- Deploy: `bl deploy` (builds and deploys). `bl push` only publishes the image.
- Run with per-task input, CLI: `bl run job my-job --data '{"tasks": [{"name": "John"}, {"name": "Jane"}]}'` or `--file batch.json`; locally add `--local`.
- Run from code (Manage-job-execution-ts.md):
```ts
import { blJob } from "@blaxel/core";
const job = blJob("eyes-swarm");
const executionId = await job.createExecution({ tasks: [{ agentId: 1 }, { agentId: 2 }], env: { EYES_API_BASE: "https://..." } });
const status = await job.getExecutionStatus(executionId); // pending|running|completed|failed
await job.waitForExecution(executionId, { maxWait: 180000, interval: 5000 });
```
  Execution-level `env` overrides apply only to that execution. `allowQueue: false` makes over-capacity fail fast (429, or 400 if it can never fit quota). Memory override can only go down from deployed memory. SDK time values are milliseconds.
- Logs: console, per execution; no documented SDK call for job logs (see Open questions).
- Job env/secrets: `[env]` in blaxel.toml or `.env`, read in code via `import { env } from "@blaxel/core"` (Variables-and-secrets-jobs.md). Reserved: `BL_WORKSPACE`, `BL_NAME`, `BL_TYPE`.
- Cron triggers exist in blaxel.toml (`[[triggers]] type = "cron"`), not needed here.
- Third-party pricing for batch: about $0.000006 per GB-second (unverified).

## Agents hosting
Only if we want the verifier agent loop hosted rather than run in a sandbox. `bl new agent`, `bl serve` (local), `bl deploy` (Tutorials/Custom-Agents.md). Invocation URL/auth header not captured. An agent loop calling our MCP over HTTP needs no Blaxel-side MCP; it is just outbound HTTPS. Recommendation: skip hosting, use a sandbox exec or a job. Outbound internet policy for sandboxes/jobs is not documented in what we read; assume allowed but test.

## Limits and gotchas
- `waitForCompletion` hard 60 s; use `keepAlive` for longer.
- Quota error code `QUOTA_EXCEEDED` on create; tier 0 must add payment method before a quota increase request; free-plan accounts are not eligible for quota upgrades (Quotas.md, troubleshooting page). Numeric limits are only in the console at app.blaxel.ai/account/quotas.
- Quotas also cap parallel executions and concurrent tasks for jobs.
- `region` is optional now but "will become mandatory": always pass it.
- `WORKLOAD_UNAVAILABLE`: retry with backoff 500 ms to 30 s, give up around 60 s (best-practices.md).
- Sandbox names must be unique; generate per run (`eyes-eval-${Date.now()}`).
- Creation timeout option is 1 to 50 s.
- Docs have two code styles (`@blaxel/sdk` metadata/spec form in old pages vs `@blaxel/core` flat form). Use flat `@blaxel/core`.

## Contradictions with our plan
- Plan: pass per-task input to the swarm job; docs show it works via `tasks: [{...}]` objects, but how the task function reads them is shown only through the template, not documented. Not a contradiction, a gap.
- Plan: run eval scripts in a sandbox and read output; docs cap `waitForCompletion` at 60 s, so evals longer than 60 s need `keepAlive` plus log polling.
- Plan: hackathon prize "criteria"; none published anywhere we could reach (only the name and $1k). We cannot target judging criteria.
- Plan assumes free hackathon credits; docs say nothing, free plan cannot raise quotas, so concurrency for 50 tasks may be capped.

## Open questions / unverified
1. How job task code receives its `tasks[i]` object (argv flags like `--name John` per `pnpm start --name John`, vs env, vs `blStartJob` callback arg). Read template-jobs-ts/src/index.ts and the `blStartJob` source before coding.
2. Free credits amount, free-tier limits (10 sandboxes, 7-day TTL) and per-second prices: third-party only.
3. Max tasks per execution and tier numbers for maxConcurrentTasks.
4. Job logs retrieval via SDK/CLI; cancel-execution method.
5. Whether `blaxel/base-image` has Node and npm; outbound network policy from sandboxes and jobs.
6. Agent-hosting invoke URL and auth header.
7. Blaxel prize judging criteria and whether it requires Blaxel in the core product (hackathon.md says "not in our stack").
