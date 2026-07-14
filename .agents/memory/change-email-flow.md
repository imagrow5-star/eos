---
name: Change-email flow
description: How the email-change feature reuses the verify-email token machinery
---

# Change-email flow

The email-change feature does **not** have its own confirmation endpoint. Instead
`GET /auth/verify-email` handles BOTH cases and branches on the token's `new_email`
column (on `email_verification_tokens`):

- `new_email` NULL → ordinary signup verification (set `email_verified_at`).
- `new_email` set → email-change confirmation: atomically `UPDATE users SET email = new_email, email_verified_at = now`.

**Why:** the frontend already consumes any `?verifyToken=` link on mount (App.tsx
AuthGate), so routing both flows through the same param/endpoint means the change
link works whether or not the confirming browser is logged in.

**How to apply:**
- `POST /auth/change-email` requires an authenticated session AND the current
  password (bcrypt compare) — it's a recovery-vector change, so guard against
  session-hijack account takeover. It stages the change by inserting a token with
  `new_email` set; the old email/verified status stay until confirmation.
- The unique constraint on `users.email` can race between request and confirm;
  both `change-email` (pre-check) and `verify-email` (catch `23505`) handle a
  taken address gracefully.
- The change-email UI lives in TWO places on purpose: the EmailVerificationGate
  (the core recovery path for a mistyped, unverifiable signup email) and the Chat
  settings panel (for already-verified users). Shared component: `ChangeEmailForm`.
- New columns on `email_verification_tokens` need both a drizzle schema change AND
  a safety-net `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in api-server `app.ts`,
  since prod may not have run `drizzle-kit push`.
