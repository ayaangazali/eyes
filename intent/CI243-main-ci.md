---
task: CI243
files:
  - docs/archive/hackathon/PLAN.md
  - .gitleaksignore
---

## Why

Restore the archived plan exactly to its content before e502223 for #243.
The merge added a relative deployment link that does not resolve from the archive folder.
Keep current deployment documentation unchanged.

Ignore only the reported checkpoint fingerprint after verifying its value is a lowercase 40-hex git commit SHA.
`git cat-file -t` returned `commit` for that value.
Keep all other secret findings subject to scanning.

## Verification

Run the existing archive-links regression in the unit suite, lint, typecheck, contract tests, and the intent check.
Compare the restored plan with the first parent of e502223.
Run Sentrux against the pre-change baseline.
Run the full-history Gitleaks scan if the binary is installed.
