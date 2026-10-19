# Safety before money moves

Every task is checked before any money is held and before any worker sees it. Fast rules run first, then an AI classifier reviews whatever the rules let through. The policy permits public, commercial or civic tasks and prohibits targeting homes, specific people, vehicles or faces. These checks can still miss or misclassify a request; they are not a zero-error guarantee.

## How it works

- `checkRules` uses regular expressions for clear cases involving private residences, vehicles, following and dangerous acts. A narrow guard also blocks explicit instructions to ignore the safety policy or force an allowed verdict; merely discussing the rules is allowed.
- With Cloudflare credentials, Clef blocks only when a named prohibited category has confidence at least `EYES_CLASSIFIER_BLOCK_MIN` (default `0.95`, finite range `0.5`–`1` inclusive). Generic `other` is advisory after the rules pass, even at a high score. Higher values are more permissive; `1` still blocks a named category at confidence `1` and never disables deterministic rules.
- `createAssessTask(env, blockMin?: () => Promise<number>)` accepts an optional async threshold getter, read on each classifier assessment. Invalid environment values fail startup; invalid or rejected getter results fail closed.
- Clef provider errors fall back to Claude when `ANTHROPIC_API_KEY` is set. Claude's schema has no numeric confidence: explicit named-category blocks remain authoritative, while generic `other` or an unspecified category is advisory. Native provider refusals and malformed output still block. With neither provider configured, only rules run.
- Claude receives the task as data inside `<task>` tags; Clef receives structured task data. Explicit policy-override instructions are checked by the deterministic guard before either classifier.
- Failing closed: if the classifier errors or times out, the task is refused as "temporarily unavailable" and nothing is charged.
- `quote_task` checks the place and returns `allowed: false` with a `reason_if_not`. `ask_eyes` checks the question too and refuses with `unsafe_task` (HTTP 422).
- Widget tool errors display the escaped human message and suggested fix, not the raw JSON response, in both MCP Apps and ChatGPT.
- A classifier rejection can be reported from the card. Reporting creates an internal ticket; it does not charge or dispatch. After manual approval, an explicit retry uses only the original request and normal spending checks. Changing the question cannot reuse the approval; rejected or expired tickets cannot retry.

## How to try it

Ask a connected agent:

```text
Use Eyes to check whether my ex's car is parked outside her house.
```

The agent gets back `unsafe_task` with a `reason` and a `fix`, for example "Ask about a public place such as a store, cafe, park or transit stop." No bounty is held. To check the rules locally, run `pnpm test:safety`. With an API key set, `pnpm safety:eval` scores the whole pipeline against labelled fixtures.

## Where in the code

- [`packages/safety/src/rules.ts`](../../packages/safety/src/rules.ts): the rules, plus a reason and fix for each category
- [`packages/safety/src/index.ts`](../../packages/safety/src/index.ts): classifier prompt and the fail-closed wrapper
- [`packages/engine/src/index.ts`](../../packages/engine/src/index.ts): where `quote_task` and `ask_eyes` call the check
- [`packages/core/src/errors.ts`](../../packages/core/src/errors.ts): the `unsafe_task` error
- [`evals/safety/`](../../evals/safety/): eval runner and fixtures
