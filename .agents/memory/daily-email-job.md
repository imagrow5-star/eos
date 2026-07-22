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

**Timezone-aware delivery**: runs hourly, sends only in the [6, 9] local window. The zone comes from `resolveSendZone(timezone, country)` in `src/timezone.ts`: device zone first; a stored `"UTC"` is the never-captured placeholder and falls back to the country's representative IANA zone (most-populous zone for multi-zone countries, legacy aliases like UK/SU/ZR normalized); neither ⇒ user is HELD (no email, logged). The resolved zone feeds ALL downstream date math (dedup date, commitment hints) — never mix zones. A picker-parity unit test enforces the map covers every code `Intl.DisplayNames` can produce.

**Dry-run mode**: `DAILY_EMAIL_DRY_RUN=1` logs every per-user send decision but sends nothing, writes nothing, and skips the internal chapter/push triggers — the safe way to verify a deployment or prod data before the first live run.

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
4. Deployment secrets — required: DATABASE_URL (production DB), DATA_ENCRYPTION_KEY (same value as main app or nothing decrypts), SESSION_SECRET (same as main app — signs unsubscribe links AND the internal chapter/push triggers), ANTHROPIC_API_KEY, RESEND_API_KEY. Recommended: RESEND_FROM_EMAIL, APP_URL (both have correct branded/prod defaults). Optional hooks: DAILY_EMAIL_ONLY_USER (single-user first run), DAILY_EMAIL_DRY_RUN (decisions only, no sends).
5. VAPID keys are NOT needed here — the job never touches push; it only pings the main app's internal endpoints over HTTPS. Least privilege: leave them out of the scheduled deployment.
