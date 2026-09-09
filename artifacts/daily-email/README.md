# Eos — Hourly Scheduler

A one-shot Node.js script that calls the api-server's internal sweep
endpoints. The package is still called `daily-email` for historical reasons
(it used to send the morning email); it no longer sends anything to anyone.

## What it does

- **Runs as a Render Cron Job** (`eos-hourly-sweeps`, defined in the repo-root `render.yaml`), separate from the web service
- Cron: `0 * * * *` — every hour on the hour
- Each run POSTs, in order, to three HMAC-protected endpoints on the api-server:
  1. `/api/internal/chapters/run` — the weekly chapter (Sunday-evening window)
  2. `/api/internal/reflection/weekly-run` — the weekly reflection
  3. `/api/internal/stories/run` — Journey stories: daily Goals / Routines cards and the Sunday weekly story (after chapters, because the weekly story reads this week's chapter)
- The api-server decides who is inside their local window; every sweep is idempotent per (user, day/week), so calling hourly is safe
- Nothing reaches a person directly. Eos has no outbound channel: no emails, no push notifications. What the sweeps produce waits in the app.

## Deploying

1. **Build** locally to verify it compiles:
   ```
   pnpm --filter @workspace/daily-email run build
   ```

2. **In the Render dashboard**, either apply the repo's `render.yaml` as a Blueprint
   (New → Blueprint → this repo) or create a Cron Job by hand with the same values:
   - Build command: `npx --yes pnpm@10 install --frozen-lockfile && npx --yes pnpm@10 --filter @workspace/daily-email run build`
   - Start command: `node --enable-source-maps artifacts/daily-email/dist/index.mjs`
   - Schedule: `0 * * * *`
   - Region: the web service's region (Oregon)

3. **Environment variables** — only two matter:
   - `SESSION_SECRET` — must be byte-for-byte identical to the web service's, or every trigger returns 401
   - `APP_URL` — `https://eoscompanion.com`
   - plus `NODE_ENV=production` and `NODE_VERSION=22`

   The job never reads the database, so it needs no `DATABASE_URL`, no encryption key, and no model or email keys.

4. **First run**: open the cron job → **Trigger Run**. The log should show three
   "… triggered" lines with `status: 200` (chapters, reflection, stories), then
   `Scheduler complete`. The process exits non-zero if any trigger failed, so
   Render's run history shows it.

## Local test run

```
SESSION_SECRET=… APP_URL=http://localhost:3000 pnpm --filter @workspace/daily-email run dev
```

Runs once immediately against the api-server at `APP_URL`. Two hooks:

- `SCHEDULER_DRY_RUN=1` — log what would be called, call nothing
- `SCHEDULER_ONLY_USER=<id>` — scope every sweep to one user

(The old names `DAILY_EMAIL_DRY_RUN` / `DAILY_EMAIL_ONLY_USER` still work.)
