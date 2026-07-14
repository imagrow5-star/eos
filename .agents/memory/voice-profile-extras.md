---
name: Voice choice, companion gender & expanded voices
description: voiceId + companionGender + userGender on profile; full 10-voice library; pronoun system; onboarding step order
---

## Onboarding step order (current)

`purpose → companionGender → name → companionName → country → ageBand → userGender → done`

- `companionGender` (new step 2): sets companionGender + default voiceId in DB
- `userGender` (new final step): optional/skippable — answer "skip" to bypass; sets isOnboardingComplete = true
- ageBand no longer sets isOnboardingComplete

## companionGender on profile

- `companion_gender TEXT NOT NULL DEFAULT 'woman'` — woman | man | nonbinary
- When answered in onboarding: also sets `voiceId` to gender-matched default
  - woman/nonbinary → Sarah (EXAVITQu4vr4xnSDxMaL)
  - man → Adam (pNInz6obpgDQGcFmaJgB)
- companionName suggestions are gender-keyed in getStepQuestion

## userGender on profile

- `user_gender TEXT` (nullable) — man | woman | other
- Nullable: profile.userGender may be null for users who skipped
- Injected into system prompt as: `${name} is a ${userGender}.` (only when not null/other)

## Pronoun system in systemPrompt.ts

- `pronounLine` derived from profile.companionGender → she/her | he/him | they/them
- Added to CORE CHARACTER block: "Your pronouns are ${pronounLine}..."
- Uses `(profile as any).companionGender` cast since Profile DB type may not always propagate before runtime

## 10-voice library (TTS allowlist)

Female: Sarah, Matilda, Lily, Rachel, Alice
Male: Antoni, Charlie, Adam, George, Arnold

ALLOWED_VOICE_IDS in tts.ts must include all 10. Voice picker in Chat.tsx organized into Female/Male sections, ordered by companionGender (man → Male first).

## voiceId flow (fixed)

- `voiceId` was previously stripped by `GetProfileResponse.parse()` (Zod strips unknown keys)
- Fixed: added voiceId to openapi.yaml Profile schema → ran orval codegen → now in generated Zod type
- Same fix applied to companionGender and userGender
- Always re-run `pnpm exec orval` in lib/api-spec/ after adding fields to openapi.yaml

## Profile PUT pattern

Extra fields not yet in generated OpenAPI ProfileInput are accepted via `(data as any)` cast in profile.ts PUT handler. Same pattern for: ageBand, voiceId, companionGender, userGender.

**Why:** Avoids re-running codegen for every small field addition. The cast is safe since the DB update is strongly typed via `Partial<typeof profileTable.$inferInsert>`.
