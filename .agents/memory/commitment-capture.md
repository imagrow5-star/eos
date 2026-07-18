---
name: Commitment capture & nudges
description: How conversational plans become scheduled commitments with follow-up channels; invariants to keep when touching extraction, persona, greeting, or the email job
---

# Commitment capture & timed nudges

## The design
- One shared dispatcher (`runConversationExtractions` in api-server ai.ts) runs commitment/habit/memory extraction for BOTH text chat and voice turns. Voice only feeds it on *fresh* user turns (not ElevenLabs interruption-resends, not synthetic turns).
- Commitments carry `scheduledDate` (YYYY-MM-DD) + `scheduledTime` (HH:MM, 24h, only for explicit clock times) + `nudgeSentAt`. `scheduledFollowupDate` = scheduledDate when set.
- Extraction has two paths: companion-proposed-and-agreed, OR user-declared concrete plan (day/time/event anchor required). Vague hopes → null; recurring routines → habits, not commitments; a multi-step plan is ONE commitment.

**Why:** the persona used to say "I can't set reminders" while the app had commitments + a daily email — the fix was making conversation the write path and teaching the persona its true channels. If extraction and persona claims drift apart, she lies again.

## Invariants (how to apply)
- The persona `capabilitiesBlock` in systemPrompt.ts must only promise channels that actually exist: in-app morning check-in, morning email (6–9am, skipped when `dailyEmailOptOut`), timed morning email nudge. Never phone alarms/push/SMS. If a channel is added/removed, update that block in the same change.
- Timing hints come from one place per package: `describeCommitmentTiming` (api-server stage.ts) and its mirror in daily-email. They frame "nudge forward" vs "ask how it went" — greeting/note prompts rely on that parenthetical.
- Email nudges are a MORNING-ONLY channel (commitment hour ≤ 11), firing when user-local hour == commitment hour, plus a one-hour catch-up window for delayed runs (flagged `late` so the text doesn't pretend to be on time). Each nudge is claimed ATOMICALLY (conditional update where `nudgeSentAt IS NULL`, returning) BEFORE sending — overlapping runs can't double-send; a failed send releases the claim. If the daily note mentioned that exact commitment (matched by id), the nudge is folded: claimed but not emailed.
- The nudge pass must run for EVERY user on every job run — never `continue` out of the daily-note branch (that bug silently dropped nudges for users with too little data for a note).
- Commitment follow-up fetches (greeting, morning note, email) are NOT stage-gated — user-declared plans deserve follow-up at any stage; only Rule 9 coaching stays stage ≥ 3.
- Daily-email job supports `DAILY_EMAIL_ONLY_USER=<id>` to safely test against the dev DB (it contains real dev accounts). Resend rejects `@example.com`; use `delivered@resend.dev` for happy-path tests.
- Reminder for prod: the api-server/web app AND the separate daily-email scheduled deployment must BOTH be republished for these features to take effect.
