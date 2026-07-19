---
name: Verification recovery & profile dedupe
description: Stuck-unverified-user recovery (resend endpoint), token TTL policy, advisory-lock patterns, boot-time profile dedupe
---

- Signup verification links: **7-day TTL** (`VERIFICATION_TOKEN_TTL_MS`). Was 24h — real users found the email days late (Gmail Promotions/Updates tabs), and expired link + no resend = permanent lockout.
- `POST /auth/resend-verification` is dual-path: session (gate button) or unauthenticated `{email}`. The email path ALWAYS returns one fixed generic 200 body (anti account-enumeration). 60s cooldown → 429 on the session path, silent generic 200 on the email path.
- **Why atomic:** cooldown re-check + old-token delete + new-token insert run in ONE transaction under `pg_advisory_xact_lock` — otherwise parallel requests all pass the cooldown (inbox flood) and a crash between delete/insert leaves the user with zero valid tokens.
- Advisory-lock keyspaces in use: `(917501, userId)` = profile creation, `(917502, userId)` = verification-token swap. Pick a new first key for new locks.
- Resend deletes must filter `new_email IS NULL` — wiping change-email staging tokens would silently cancel a pending address change.
- `profile.user_id` has NO unique constraint; concurrent first requests created real dup rows in prod (2ms apart). Boot-time safety-net DELETE in app.ts collapses dups (keep onboarding-complete first, then lowest id; NULL user_id legacy rows untouched).
- **How to apply:** adding a unique index on profile.user_id is only safe after the dedupe has run in prod (publish schema-diff fails on existing dups). Re-issuing verification links for prod users = call the public resend endpoint against the prod URL after publish (agent cannot write prod DB). The daily-email Scheduled Deployment cannot be created by agent tooling — the user creates it in the Publishing panel (settings in the package README).
