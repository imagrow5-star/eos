---
name: Daily email job
description: Architecture and deployment notes for the Eos personalized morning email job (artifacts/daily-email)
---

## Architecture

- **Package**: `@workspace/daily-email` at `artifacts/daily-email/`
- **Not** a registered artifact (no artifact.toml) — plain pnpm workspace package
- Deployed as a separate **Replit Scheduled Deployment** (independent from the main autoscale deployment)
- Cron: `0 * * * *` — every hour, but only sends to users whose local clock is 6–9 AM

## Key design decisions

**Timezone-aware delivery**: runs hourly, checks `localHour(user.timezone)`, sends only in [6, 9] window. Much better than a single global 7AM UTC send.

**Dedup guard**: `lastEmailDate` (YYYY-MM-DD in user's timezone) on profile — skip if already sent today.

**Opt-out**: `dailyEmailOptOut` boolean on profile (default false). One-click unsubscribe via `GET /api/email/unsubscribe?uid=X&token=T`. Token = `HMAC-SHA256(SESSION_SECRET, "unsub:" + userId).slice(0, 24)` — deterministic, no extra DB storage. Unsubscribe route is in `artifacts/api-server/src/routes/email.ts`, registered as public.

**Data skip**: users with 0 facts AND 0 wins AND 0 habits are skipped — not enough to personalize.

**Why:** A scheduled job in an Autoscale deployment would reset on sleep. Hourly cron with local-time filtering is more reliable than a once-daily job at a fixed UTC time.

## Prompt design

Claude claude-sonnet-4-5, `temperature: 0.8`. Anti-cliché prompt — explicit forbidden-phrases list. Grounded in real data: memory facts, wins with exact text, habits with streak + weekly completion count, mood trend (computed from last 7 scores), pending commitment.

## DB columns added (safety-net ALTERs in app.ts)
- `profile.daily_email_opt_out` boolean NOT NULL DEFAULT false
- `profile.last_email_date` text (nullable YYYY-MM-DD)

## Deploy steps
1. Build: `pnpm --filter @workspace/daily-email run build`
2. In Replit Publishing → new deployment → Scheduled → cron `0 * * * *`
3. Run: `node --enable-source-maps artifacts/daily-email/dist/index.mjs`
4. Env vars: DATABASE_URL, ANTHROPIC_API_KEY, RESEND_API_KEY, RESEND_FROM_EMAIL, SESSION_SECRET, APP_URL
