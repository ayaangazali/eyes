# ADR-009: Link tokens must be exactly `<body>.<mac>`

Status: accepted (2026-10-17). Raised by the PR #14 round 2 security review.

## Context
`verifyToken` read only the first two `.`-separated parts, so `T`, `T.a` and `T.b` all verified as the same token. Anything keyed on the raw token string (the per-token upload cap in apps/mcp, log correlation) could be bypassed by appending segments: one worker filled every capture upload slot with variants of one offer token.

## Decision
`verifyToken` returns null unless the token has exactly two non-empty parts. One canonical string per token, so raw-token keys are sound everywhere (offer, connect and top-up links).

## Consequences
Contract test pins `${token}.x` and `${token}.` as invalid. No issued token changes shape; only malformed variants stop verifying.
