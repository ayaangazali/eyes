# ADR-027: TASK texts the live capture link back

Status: accepted (2026-10-17). Changes the frozen `ReplyIntent` contract in `packages/core` (adds `task`).

## Context
A worker who claimed a task can lose the capture link (deleted text, opened an old link from an earlier task, closed the browser). Texting YES again does resend it while the claim is open, but nobody is told that, and when the claim is gone (submitted, expired) the same YES claims whatever offer is waiting. Workers needed a keyword that only returns their link and never takes a task.

## Decision
- New reply intent `task`. `parseReplyIntent` maps "TASK" and "LINK" to it, case-insensitive, same token rules as the other keywords ("task?" stays `unknown`).
- The engine's `task` handler finds the worker's newest claim with status `claimed` (not submitted) and a `deadline_at` in the future, then texts "Eyes: here is the link for your task: <captureUrl(task, worker.id)>". Otherwise it texts exactly "You have no open task right now. We'll text you when one is near."
- No migration: it reuses `eyes_worker_earnings` (the worker's claims, newest first) and `eyes_task_detail` (the deadline). A claim past its deadline stays `claimed` until the expiry sweep, so the engine checks the deadline itself.
- HELP lists "TASK for your task link".

## Alternatives rejected
- Reuse HELP: HELP opens a support ticket after a held answer and otherwise texts the general help, never a capture link.
- Web self-serve (a page that shows your open task): needs worker auth on the web, and the worker is already known by phone over SMS.
- Tell workers to text YES again: it resends the link only while the claim is open (`eyes_claim` returns `already_yours`), and with no open claim it claims the next dispatched offer.

## Consequences
The link is the same signed token as the original capture link (same task, worker, deadline), so nothing new is minted or stored. Ceiling: two RPC round trips per TASK, and the earnings query reads up to 50 claims; a dedicated query only matters if TASK traffic grows.
