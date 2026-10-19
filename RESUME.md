# Resume non-social WIP

These checkpoints are unvalidated backups, not a release or permission to merge/deploy. Production remains `jerry/live-setup` at `fecb6afd1aa46bd5c776fa00a046384e416db959`.

## Start here

```sh
git clone https://github.com/ayaangazali/eyes.git eyes-resume
cd eyes-resume
git fetch origin 'refs/tags/checkpoint/2026-10-19/*:refs/tags/checkpoint/2026-10-19/*'
git show checkpoint/2026-10-19/handoff:RESUME.md
git switch -c resume/root checkpoint/2026-10-19/root-wip
```

The root WIP derives from older divergent local HEAD `8a226bbfd9cd1646488e2705c0a2ce390e3b3b9f`, NOT the deployed release. Do not push it to the deployment branch or main.

## Exact checkpoints

| Tag | Commit |
| --- | --- |
| `checkpoint/2026-10-19/oauth-cimd` | `81e0a449c5ea293372278d175077b00fdf2a71bd` |
| `checkpoint/2026-10-19/marketplace-package` | `474a5c2452fbffc1658f0bed8d4adfebfa48a3a1` |
| `checkpoint/2026-10-19/start-help-hub` | `e26a4e49428a8d60147184dda6eba2b13b5311d4` |
| `checkpoint/2026-10-19/intent-status` | `8814f0c52ba24b0fbb8f35d90f944e91cda70835` |
| `checkpoint/2026-10-19/classifier-report` | `d19d4f905fd38a4f00c26ee98ec80e02f6cce069` |
| `checkpoint/2026-10-19/classifier-errors` | `e0de90f01168e72294010566d854360e9071eba1` |
| `checkpoint/2026-10-19/classifier-review-ui` | `a93b8432439073e09bc65bbf9139c1ed914a13c5` |
| `checkpoint/2026-10-19/root-wip` | `501245fccafa44aebaf355388ad2e52e0d813c84` |
| `checkpoint/2026-10-19/ci-merge` | `c96bdf8c41aac4fb3bcc87bb41a22200f3c236fb` |
| `checkpoint/2026-10-19/cov95-verify` | `fc6f7de3aadc0274e3f30b8c03f1bceb73eb8740` |
| `checkpoint/2026-10-19/manufact-docs` | `9d8b0925603f2cd56aacf99002755ea5b6340780` |
| `checkpoint/2026-10-19/start-preview-helper` | `72bd8471184f6e0ea68b29d6ac50b7a2e38f4b1e` |
| `checkpoint/2026-10-19/review-assets` | `cd6e577960acb3f35ddc2dec3375017659dcdda5` |
| `checkpoint/2026-10-19/historical-uptime-ops` | `f556ecf8c752ddfee0ee5b11ac0dca0495c04691` |

`checkpoint/2026-10-19/handoff` contains this guide and `WIP-COVERAGE.json`; the other tags hold the exact source snapshots.

## Work preserved

- `root-wip`: 58 changed paths, including 9 new files and 3 deletions; 5 other snapshot tags cover CI integration/widget staging, coverage configuration, hosting documentation, preview source, and product review assets. Total: 168 dirty paths across six worktrees.
- `oauth-cimd`: unfinished OAuth/CIMD work; `marketplace-package`: marketplace package and reviewed demo assets, not authorization to publish a listing; `start-help-hub`: START/help/hub variant.
- `intent-status` and the three classifier tags: unique status/report/error/review variants. `historical-uptime-ops` retains the earlier uptime, hosting and ops variants (`f556ecf8c752ddfee0ee5b11ac0dca0495c04691`, `3c4803f992fa164384a4e7a36575e700a6af6cae`, `74e08ee8076e658e92c5f0df71c0abb2cc52f462`). Together the eight historical tags cover all 11 distinct unpublished variants.
- Other local branch histories were already published or patch-equivalent (283 commit IDs), or historical merge snapshots with published combined-diff blobs. They do not require 107 duplicate branches. Detailed audit classification is recorded in `WIP-COVERAGE.json`.

## Original staging and working states

Snapshot commits represent working-tree bytes. Their first parents retain original HEADs. Root and all non-CI snapshots had no staged changes; their original index equals the first parent. CI's 95 changes were staged and match its working tree, so its snapshot tree also represents the original index. There were no unresolved index entries and no distinct staged changes requiring a second snapshot.

To reconstruct original dirty state, use a NEW clone/worktree only. For root unstaged state:

```sh
git switch -c resume/root-dirty checkpoint/2026-10-19/root-wip^
git restore --source=checkpoint/2026-10-19/root-wip --worktree -- .
```

For original CI staged state in that new clone:

```sh
git switch -c resume/ci-dirty checkpoint/2026-10-19/ci-merge^
git restore --source=checkpoint/2026-10-19/ci-merge --staged --worktree -- .
```

The same first-parent/worktree restore pattern applies to the other unstaged snapshots. `WIP-COVERAGE.json` records exact modes, blobs, deletions and original stage entries.

## Exclusions and safety

Three generated `.wrangler/cache/wrangler-account.json` paths remain local (cutover/manufact/mc worktrees). Ignored credentials/env files, dependencies, build/cache outputs, signed binaries, social drafts, `.lavish`, private logs and raw session transcripts are not backup candidates and remain local. Product review video is included because its exact blob was already published; this is not a social publication.

No functional test suite was run for this backup. Archive integrity is checked by remote fetch and exact tree/blob/mode/deletion comparison. Restore credentials separately through secure storage. Do NOT automatically execute `scripts/preview-start.local.ts`: it is preserved source that can send live messages. No original worktree/index/HEAD was changed to create these snapshots.
