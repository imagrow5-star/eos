---
name: Timezone architecture
description: How user timezone is captured, stored, and used across the app for accurate date/time handling
---

## Storage
- `profileTable.timezone` — IANA string (e.g. "Asia/Kolkata"), default "UTC"
- Added via `drizzle-kit push` migration — no migration file, just schema push
- Returned in GetProfileResponse, accepted in UpdateProfileBody
- Extra fields bypass generated types via `(data as any).timezone` cast in profile route

## Detection
- `artifacts/aanya/src/App.tsx` — `useTimezoneSync` hook runs once on mount
- Uses `Intl.DateTimeFormat().resolvedOptions().timeZone`
- Fire-and-forget PUT to `/api/profile` with `{ timezone }` — idempotent

## Key helpers in `stage.ts`
- `todayInTimezone(tz)` — returns YYYY-MM-DD in user's timezone (en-CA locale trick)
- `yesterdayInTimezone(tz)` — yesterday in user's timezone
- `getTimeContext(tz)` — returns `{ dayOfWeek, fullDate, shortDate, time12, partOfDay, year, promptLine }`
  - `partOfDay` buckets: early morning (4–9), morning (9–12), afternoon (12–17), evening (17–21), night
  - Falls back to UTC on invalid timezone

## What uses timezone-aware dates
- `systemPrompt.ts` — `getTimeContext()` injected at top of EVERY system prompt
- `ai.ts` — `detectHabitMentions`, `extractCommitments`, `extractMemory` (mood scoring), `generateMorningNoteContent`
- `memory.ts` — manual habit completion via Journey UI
- `chat.ts` — morning note dedup check

## Email send-zone fallback (daily-email job)
- `resolveSendZone(deviceZone, country)` in `artifacts/daily-email/src/timezone.ts`: device zone wins unless it is the `"UTC"` placeholder (case-insensitive; `"Etc/UTC"` counts as genuine device); then country → representative zone via complete ISO map + legacy-alias table; neither ⇒ hold (no email) — 6–9 AM UTC is the wrong morning almost everywhere.
- Genuine-UTC devices are indistinguishable from the placeholder ⇒ they get country timing; self-corrects on next app open (browser re-syncs the real zone).
- Prod reality check: users exist whose device zone ≠ their country's obvious zone — device-first is not optional.

## What intentionally stays UTC
- `profile.ts` visit date recording — coarse "days since start" measure
- `journey.ts` streak / `calculateStreak` on visit dates — same coarse measure
- These use `todayString()` (UTC) by design

## System prompt injection format
Placed at the very top of the returned prompt string, before companionName persona block:
```
══════ CURRENT DATE & TIME (real — use this, never invent or guess) ══════
Today is Thursday, July 14, 2026. Local time: 10:32 PM (evening).
• Day of week: Thursday
• Part of day: evening
• Full date: July 14, 2026
• Year: 2026
...instructions on natural use...
```

**Why at the top:** Anthropic models weight earlier content more heavily; placing it first ensures the model never misses or ignores the time context.
