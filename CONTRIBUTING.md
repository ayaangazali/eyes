# Contributing

Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Report security problems through [SECURITY.md](SECURITY.md), not public issues.

## Setup and checks

Use Node.js 26 and pnpm 11.18.0, matching CI and the Docker image.
Install dependencies from the repository root:

```sh
npx -y pnpm@11.18.0 install
pnpm verify:fast
```

If `pnpm` is not installed, replace `pnpm` in each command with `npx -y pnpm@11.18.0`.
`verify:fast` runs lint, typecheck, unit, contract, safety, and intent checks.
The commands are defined in [package.json](package.json).

For integration tests, start a local Postgres 17 database with Docker:

```sh
pnpm db:up
export DATABASE_URL=postgres://postgres:eyes@127.0.0.1:54329/eyes
pnpm db:migrate
pnpm test:integration
```

Without Docker, provide a local Postgres server at that address.
Use a disposable database server, never production.
The test user must create and drop databases.
[scripts/int-db.ts](scripts/int-db.ts) creates a separate database for each integration test file and drops it afterwards.

Run `pnpm coverage:all` for the combined coverage gate.
[CI](.github/workflows/ci.yml) measures affected source files on pull requests and the full configured source set on full runs.
Each included file needs 95% statement, branch, function, and line coverage, as defined in [vitest.config.ts](vitest.config.ts).
CI skips scoped code checks for documentation-only changes.
Intent, secret scanning, and the four quality gates below still run.

### CI quality gates

Each quality gate has its own job: `audit`, `sentrux`, `actionlint`, and `docker-build`.
The audit runs `pnpm audit --prod` without installing the workspace.
The `mobile-typecheck` job runs `npm ci` and `npm run typecheck` in `apps/mobile`, without installing the root workspace.
The mobile app tsconfig excludes test files.
The root Vitest unit suite runs them without typechecking.
The Docker job runs `docker build .` without a registry login, push, or deployment.

The Sentrux job requires the committed `.sentrux/baseline.json` from the first run.
It blocks a `DEGRADED` verdict or a quality drop greater than 250 points, not existing structural debt.
Sentrux can report `DEGRADED` below 250 points, including for structural regressions; the numerical limit does not override that verdict.
Tool failures and missing comparison results also fail the job.
Run `node scripts/check-quality.ts` locally with Sentrux 0.5.7 installed.
The job downloads the versioned Linux binary from the [official release](https://github.com/sentrux/sentrux/releases/tag/v0.5.7).
This follows the binary installation used by the [Linux installer](https://github.com/sentrux/sentrux/blob/main/install.sh), but pins the version.
CI verifies SHA-256 checksums for the Sentrux binary, grammar bundle, and actionlint archive.
Do not replace the baseline to make a failing change pass.
Refresh the baseline with `sentrux gate --save .` in a separate reviewed change when an exception is accepted.
Keep Sentrux caches out of commits.

Run `actionlint` 1.7.11 to check the workflows locally.
Third-party actions use commit SHAs.
Dependabot checks root npm dependencies and GitHub Actions weekly, with minor and patch npm updates grouped.

## Intent and architecture decisions

For changes under `apps/`, `packages/`, `cli/`, `scripts/`, or `db/`, add or update an `intent/*.md` file.
A dependency-only diff needs no intent file.
It must only modify package manifests and lockfiles, with manifest edits limited to existing dependency versions.
Versions may use exact, caret, or tilde ranges.
This exemption does not depend on the author.
Other changes under the governed paths still need intent coverage, including dependency additions, removals, source changes, scripts, and code.
List the changed paths under `files`, set `task`, and include `## Why` and `## Verification` sections.
See [this intent example](intent/S6-https-security-headers.md) and [the checker](scripts/check-intent.ts).

Add an ADR under `intent/decisions/` when changing core contracts or migrations.
The checker requires an ADR for edits to existing files under `packages/core/src/` or `packages/db/migrations/`.
See [ADR-003](intent/decisions/ADR-003-seams-and-ownership.md) for the service and transaction boundaries.
Run `pnpm intent:index` after intent changes and commit any updated `intent/INDEX.md`.

Keep migrations append-only.
Add a new numbered SQL file under `packages/db/migrations/`; do not edit an applied migration.
Check the latest main branch before selecting the next number.
The migration runner applies files in filename order and records applied names.

## Public documentation and pull requests

Regenerate public API documentation after changes to its source:

```sh
pnpm --filter @eyes/cli gen:docs
```

Commit the resulting `docs/public/` changes rather than editing generated files by hand.
Use conventional commit and pull request titles, such as `fix(engine): preserve retry results` or `docs: add project policies`.
Keep each pull request focused, link its issue, and state which checks passed.

## Releases

The release-please workflow runs on pushes to `main`.
It opens or updates a release pull request from conventional commits.
Merge that pull request to create a GitHub release and a `v0.x.y` tag.
The root package starts from the recorded version `0.1.0`; fixes advance the patch version.
Features and breaking changes advance the minor version while the major version is zero.
Release-please updates the root package version and the existing `CHANGELOG.md`.
It does not deploy, publish npm packages, or push Docker images.

The workflow uses `GITHUB_TOKEN` with only contents and pull-request write permissions.
The repository must allow GitHub Actions to create pull requests.
Events from this token do not start other workflows, including CI on the generated release pull request.
Required pull-request checks can block these generated pull requests because the token does not start CI.
CI still runs after a person merges the release pull request into `main`.
When CI runs on a pull request, generated release notes and version state do not select code checks.
Changes to `package.json` still select the full checks; release pull requests have no author-based exemption.
