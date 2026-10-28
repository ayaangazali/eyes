# ADR-048: Private photo bucket, signed expiring URLs

Status: accepted 2026-10-28. Supersedes the "permanent public URL" consequence of [ADR-014](ADR-014-delete-face-photos.md).

## Context
The `photos` bucket was public, so every capture had a permanent URL that anyone with the link could open (OWASP API1:2023). `submissions.photo_url` stored that URL and agents, owners and ops received it unchanged.

## Decision
- The bucket is private. `submissions.photo_url` keeps the raw object URL; no migration and old rows keep working.
- `Storage.signPhoto(url)` returns `<EYES_PUBLIC_API_URL>/photos?k=<key>&exp=<epoch>&sig=<hmac>`. The HMAC-SHA256 covers key and expiry and uses `INSFORGE_API_KEY` as secret. Lifetime: 1 hour.
- `GET /photos` calls `Storage.readPhoto`, which checks signature and expiry in constant time and streams the object using the admin key. Bad or expired links answer 403.
- Signing happens where the result is built, after the same token check as the result: `answerOf` (`await_answer`, `get_task`), the ops task views and the vision judge input at submit time.

## Alternatives rejected
- InsForge presigned URLs: the installed SDK has no verified signing call; our HMAC route does not depend on one.
- A new signing secret: needs a deploy-time env change; the admin key is already required for live storage.

## Consequences
A signed link works until it expires and can be shared in that window. An agent must read the photo within an hour or call `get_task` again for a fresh link. Email replies carry a link that expires. Moving the bucket to private is an operator step in docs/DEPLOY.md.
