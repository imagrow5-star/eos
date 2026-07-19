---
name: Email delivery diagnosis
description: How to diagnose Eos email delivery — Resend account facts, prod schema quirks, and the gates that decide who gets emailed
---

## Resend account facts

- Sending domain `itslexa.com` is **verified** (sending enabled) — from-address `Eos <noreply@itslexa.com>` via shared env var `RESEND_FROM_EMAIL`. NOT in sandbox mode; third-party Gmail delivery confirmed.
- The account is **shared with another app** (spa-booking dashboards send from the same key/domain) — mixed subjects in history are normal.
- `GET https://api.resend.com/emails?limit=100` works and paginates with `after=<last id>`; history is shallow in practice because test suites flood it with hundreds of `example.invalid` verification emails. Filter test recipients before reasoning.
- api-server default from-address falls back to `onboarding@resend.dev` (sandbox!) if `RESEND_FROM_EMAIL` is unset — daily-email's fallback is the branded address. Keep the env var set in both environments.

## Who actually gets emailed (gates, in order)

- Daily notes: user must be email-verified AND `is_onboarding_complete` AND not `daily_email_opt_out`, and only inside 6–9 AM local (hourly cron). Unverified users get NOTHING except the single signup verification email — and there is no re-send verification path in the UI.
- The daily job is a one-shot script needing its own **Scheduled Deployment** (docs confirm autoscale + scheduled can coexist in one project). If Resend history shows zero `<companion> — <Weekday>` subjects and all `profile.last_email_date` are NULL, the job has never run in prod.

## Prod DB quirks (read replica via executeSql environment:"production")

- Table is `profile` (SINGULAR) in prod; also `email_verification_tokens` has no `used_at` column there — prod schema lags dev until next publish.
- When a query references a missing column/table, the output is just `START TRANSACTION / ROLLBACK` with NO error text — probe `information_schema` first instead of guessing.
- Duplicate `profile` rows per user exist in the wild (seen: one user with two rows, different timezones/onboarding states) — `getOrCreateProfileForUser` race; joins on profile can double-count users.
