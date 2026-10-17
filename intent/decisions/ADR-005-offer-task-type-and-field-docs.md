# ADR-005: `OfferMessage.task_type`, input field descriptions, generic `internal_error` fix

Status: accepted (Phase 1, 2026-10-17). Notified: engine-builder (T1.2), comms-builder (T1.3), mcp-builder (T1.1).

## Context
- PR #1 security review: any agent's free-text question reached workers' phones in the cold offer, and an ASCII scrubber cannot keep out Unicode links and phone numbers (IDN domains, fullwidth digits, zero-width splits). The orchestrator ruled to remove the question from the cold offer entirely. The offer then needs to say what kind of check it is, but `OfferMessage` had no task type.
- PR #2 ax review: the tool input JSON Schemas had no description for most `ask_eyes` and `await_answer` fields, and the `internal_error` fix told callers of `get_balance` to reuse an idempotency_key they never had.

## Decision
1. Add required `task_type: TaskType` to `OfferMessage`. The engine passes `task.task_type`; comms maps it to a fixed phrase. The question appears only on the capture page after a claim.
2. Add `.describe()` text to `question`, `task_type`, `bounty_usd`, `deadline_minutes`, `require_photo`, `idempotency_key`, `timeout_seconds` and `reason`. Descriptions only: no type, default or bound changed.
3. `internal_error.fix` becomes generic: retry the same call, reuse an idempotency_key if one was passed, check `get_task` if a task is involved.

## Consequences
Tool schema snapshot updated. `sendOffer` callers must pass `task_type` (one call site, in the engine).
