---
name: Supportive accountability model
description: Architecture for proactive care, greeting slots, accountability loop, and system prompt rules 8-9
---

## Greeting system (POST /api/chat/contextual-greeting)

- **New endpoint** replaces the old once-per-day `/chat/morning-note` for the frontend
- Old `/chat/morning-note` kept as a working alias (still used internally)
- Server decides whether to generate based on slot + recency — returns `{ message: null }` if no greeting needed
- Frontend calls it once per browser session via `morningNoteTriggered` ref; handles null silently
- Hook lives at `artifacts/aanya/src/api/contextualGreeting.ts` (manual hook, not generated)

### Slot logic
- `partOfDay` from `getTimeContext()` → slot: morning (5–11), evening (17–20), night (21–4), null (12–16)
- Fires if: last greeting > 6 hours ago AND (in a natural slot OR absent ≥ 2 days)
- Absent override: if daysSinceLast ≥ 2, always generates regardless of slot
- `lastGreetingAt` timestamp column on profile (safety-net ALTER in app.ts)

### Greeting generation
- `generateContextualGreeting(profile, stage, ctx: GreetingContext)` in ai.ts
- temperature 0.85, max_tokens 250
- Morning: warm check-in, ONE optional commitment follow-up if pending
- Evening: "how was today?", soft habit/commitment check-in
- Night: pure warmth, zero tasks — sweet dreams / take care / get some rest
- Absent: "I've been thinking about you" energy, reference something specific

## System prompt additions (9 rules, up from 7)

**Rule 8 — Feeling First**: emotion always before action; receive before redirect; minimization banned

**Rule 9 — The Caring Follow-Up Loop**: replaces old accountability block
- Follow-up voice: "hey, did you get that walk in?" not "did you complete your commitment?"
- Done → celebrate specifically, connect to who they're becoming, let it land
- Not done → curiosity first ("what got in the way?"), zero guilt, re-plan only if they're ready
- After 2 misses on same thing: make smaller or release — never the same ask three times

**Warm Sign-Offs block**: late-night / post-vulnerability / genuine-progress moments only; rare so they mean something

**Calibration block**: ease off when thriving, heavier presence when struggling; over-checking = nagging

**Core Character** enhanced: "close, loving presence" identity explicit; "you remember, you follow up"

## Daily email update
- Prompt now includes commitment follow-up: if `pendingCommitment` exists, the note weaves in ONE warm check-in ("did you get that [thing] in?") rather than a generic nudge
- Stronger loving-person framing in the prompt instructions

## Why
User explicitly wanted Eos to feel like a close person who checks in, remembers, follows up warmly — not a neutral chatbot. Person-centered supportive accountability model.
