---
name: Personalization logic layer
description: Phase 3 personalization system — anti-repetition, discovery gap tracking, go-deeper curiosity, compounding memory
---

## What was built

### `personalization_state` DB table
- Schema: `lib/db/src/schema/personalizationState.ts` — `userId` PK, `recentPhrases TEXT[]`, `updatedAt`
- Safety-net `CREATE TABLE IF NOT EXISTS` in `app.ts` alongside other safety-nets
- Exported from `lib/db/src/schema/index.ts`

### `appendRecentPhrase(userId, aiContent)` — `ai.ts`
- Exported async function; extracts first sentence (≤80 chars) from AI reply as "opener fingerprint"
- Deduplicates by checking if any stored phrase starts with the same first 40 chars
- Upserts into `personalization_state`, keeps last 15 phrases via `.slice(-15)`
- **Called fire-and-forget** in both `/chat/stream` and `/chat/send` routes (background, non-blocking)

### Three new system prompt blocks — `systemPrompt.ts`
1. `deeperCuriosityBlock` — instructs Claude to follow up on short answers with ONE specific question; pauses during distress
2. `antiRepetitionBlock` — injects `recentPhrases` as "do not repeat these openers" (only rendered when phrases exist)
3. `discoveryBlock` — shows which of 7 domains (interests/routines/people/soothers/goals/work/humor) still have 0 facts; instructs organic, one-gap-per-conversation exploration

### `deriveDiscoveryGaps(facts)` — module-level helper in `systemPrompt.ts`
- Pure function, no DB query
- 7 `DISCOVERY_DOMAINS` with keyword lists; gaps = domains with no keyword match in combined fact text
- Returns array of human-readable gap descriptions

### System prompt data flow
- 7th Promise.all query added for `personalizationRows`
- `recentPhrases` and `discoveryGaps` computed right after `userGenderNote`
- Blocks injected: `deeperCuriosityBlock` + `antiRepetitionBlock` after nine rules separator; `discoveryBlock` before `factsBlock`

### Anti-repetition in greetings (`ai.ts`)
- `GreetingContext` interface gained `recentPhrases?: string[]`
- `generateContextualGreeting` appends `antiRepLine` to `contextBlock` when phrases exist
- Greeting route (`chat.ts`) added 5th query for `personalizationState` + passes `recentPhrases`

### Anti-repetition + phrase tracking in daily email (`daily-email/src/index.ts`)
- `personalizationStateTable` imported; `recentPhrases: string[]` added to `UserContext`
- `gatherContext` adds 6th Promise.all query; return includes `recentPhrases`
- `generateNoteText` prompt gets anti-repetition section (conditional on `ctx.recentPhrases.length > 0`)
- After successful send + `markSent`, email opener stored via inline upsert (non-fatal try/catch)

### Enhanced `extractMemory` prompt (`ai.ts`)
- Categories expanded from `life|preference|event|person|goal` to 10 categories:
  `life|interest|routine|person|work|value|soother|preference|event|goal`
- Each category has a description so Claude picks the most specific one
- This feeds discovery gap detection: as facts accumulate in richer categories, gaps close

## Key design decisions

**Why pure computation for discovery gaps:**
No new DB column needed — derived entirely from existing `memoryFacts` categories + content. Keeps the gap data always current with no sync lag.

**Why first-sentence only for phrase fingerprint:**
The opening line is the most visible repetition risk. Full-message fingerprinting would over-suppress variation in the body.

**How to apply:**
- The table starts empty per user; first 15 conversations build up the phrase list
- Gaps shrink as `extractMemory` captures richer facts over time — the system naturally improves with use
