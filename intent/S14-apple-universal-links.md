---
task: S14 Apple Universal Links
files:
  - apps/web/worker/public/.well-known/apple-app-site-association
  - apps/web/worker/public/_headers
---

## Why

Apple Universal Links require an App Site Association document for app.eyes.pictures.
This document associates capture, login, account, and app paths with the Eyes iOS app.

## Verification

Worker e2e checks pass without changes.
The association file returns JSON content type when served by the worker.
