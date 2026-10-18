# Safety before money moves

Every task is checked before any money is held and before any worker sees it. Fast rules run first, then an AI classifier reviews whatever the rules let through. Eyes only takes tasks about public, commercial or civic places. Tasks about homes, specific people, vehicles or faces are refused, and the refusal tells the agent how to rephrase.

## How it works

- `checkRules` uses regular expressions to catch clear cases such as "my ex's house", license plates, "follow her" and "photo of the cashier's face".
- If the rules pass the task and `ANTHROPIC_API_KEY` is set, a Claude Haiku classifier judges it against 8 categories, from `private_person` to `illegal_or_dangerous`.
- The task is passed to the classifier as data inside `<task>` tags. Any attempt in the task to override the policy is itself blocked.
- Failing closed: if the classifier errors or times out, the task is refused as "temporarily unavailable" and nothing is charged.
- `quote_task` checks the place and returns `allowed: false` with a `reason_if_not`. `ask_eyes` checks the question too and refuses with `unsafe_task` (HTTP 422).

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
