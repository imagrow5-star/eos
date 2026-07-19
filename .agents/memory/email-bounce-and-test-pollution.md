---
name: Email bounce diagnosis & test send pollution
description: How to diagnose "verification email never arrived" complaints, prod query/log quirks, and why tests must never hit the real Resend API
---

- **"Email never arrives" triage order:** (1) find the user row in prod, (2) search the Resend email log for that exact address (`GET /emails`, paginate `?limit=100&after=<last id>`), (3) read `last_event`. `bounced` = the address itself is undeliverable (typo/placeholder like a@b.com) — the pipeline is fine and resending is actively harmful (more bounces). `delivered` = it's in spam/Promotions or ignored. No entry at all = the send was never attempted → check server code/env.
- **Never resend to an address that bounced.** Recovery for a bounced signup: user logs in (gate) → "Wrong email?" change-email flow, or a fresh signup with the correct address.
- **Tests must not hit real Resend.** Route handlers fire real fetches during signup/reset tests — one suite run = hundreds of real sends + hard bounces to fake domains, which burns quota and damages sender-domain reputation (= real deliverability). Guard lives in vitest `setupFiles` (a fetch interceptor for api.resend.com). Keep it when touching vitest config.
- **Prod read-replica quirk:** a SELECT naming a nonexistent column returns `success: true` with output `START TRANSACTION ROLLBACK` — it looks like "no rows" but means the query FAILED. Verify column names via information_schema. Known prod columns: `users.email_verified_at` (timestamp, not a boolean), `email_verification_tokens` has NO `id` column, profile table is `profile` (singular).
- **Fingerprinting which build prod runs (deployment logs are often empty for autoscale):** compute `expires_at - created_at` on a fresh verification token (24h = old build, 7d = new), or probe a new endpoint's unauthenticated behavior with a nonexistent address (fires no email).
- **Cleaning up a prod test signup:** prod DB is read-only for the agent, but `DELETE /auth/account` with the signup session cookie fully removes the account — sign up with a sink address (delivered@resend.dev), keep the cookie jar, delete after.
