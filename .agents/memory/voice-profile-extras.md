---
name: Voice choice & profile extras
description: voiceId column on profile, how TTS picks voice, and fields not in generated OpenAPI types
---

## voiceId on profile

- Added `voiceId text default 'EXAVITQu4vr4xnSDxMaL'` to `profileTable` — default is Sarah.
- DB migration run with `pnpm --filter @workspace/db run push`.
- Profile GET returns it as `profile.voiceId` (built manually in `buildProfilePayload`, not via generated schema — same pattern as `ageBand`).
- Profile PUT accepts it via `(data as any).voiceId` cast since it's not in the generated `UpdateProfileBody` Zod type yet.

## TTS voice priority

`/api/tts` body → `ELEVENLABS_VOICE_ID` env var → `DEFAULT_VOICE_ID` (Sarah).  
Body `voiceId` is validated against an allowlist of the 5 curated voices.

## Chat voice picker

`speakText(text, { voiceId })` — the `voiceId` field is threaded from `profile.voiceId` through `handleSpeak` in `Chat.tsx`. Preview button calls `speakText` with a fixed sample string and the candidate voice ID.

**Why:** Multiple voice options cost the same per-character as one voice (ElevenLabs premade pricing). Safe to offer freely.

## Habit detection (background)

After every chat message, `detectHabitMentions(profile, userMsg, assistantReply, activeHabits)` runs in background alongside `extractCommitments`. Detects:
1. User mentioned completing an existing habit → auto-inserts completion + recalculates streak.
2. Companion + user agreed on a NEW habit → auto-creates habit in DB.

Streak recalc is a local function `recalcHabitStreak` inside `ai.ts` (not shared with the route) to avoid coupling.

**Why:** Keeping habit detection as a separate non-blocking call (not merged into commitment extraction) makes each pass simpler and more reliable.
