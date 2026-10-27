---
task: U6-add-to-agents
title: Add to ChatGPT and Add to Claude buttons on the site and worker app
files: [apps/web/landing/src/pages/index.astro, apps/web/landing/e2e/connect.spec.ts, apps/web/worker/src/components/AgentLinks.astro, apps/web/worker/src/pages/index.astro, apps/web/worker/src/pages/me.astro]
---

## Why

Issue #262: agent owners must find the connector URL by hand, so few agents get connected.
The "Built for agents first" section now has "Add to ChatGPT" and "Add to Claude" buttons.
Each button opens the existing Connect dialog with that app's setup already chosen.
The landing page also opens that dialog for `#add-chatgpt` and `#add-claude`.
The worker app links to those addresses from the join page and the account page.
Eyes has no public GPT store or Claude directory listing, so the buttons open the custom connector steps for `https://mcp.eyes.pictures/mcp`.
When a public listing exists, point the buttons at it.
The iPhone app is a worker location app with no account screen, so it does not get the buttons.

## Verification

The landing Playwright test clicks each button and checks the chosen setup, focus return, and the `#add-claude` deep link.
The worker join and account Playwright tests pass with the new card.
Before and after screenshots at 1440 and 390 pixels are in the PR.
