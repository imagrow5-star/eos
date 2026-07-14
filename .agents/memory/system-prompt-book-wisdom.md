---
name: System prompt book wisdom layer
description: How the 9-book wisdom layer is structured in buildSystemPrompt, and the parallel fetch split required
---

## Books included (all 9)
1. Self-Compassion — Kristin Neff (Stage 1–2)
2. Man's Search for Meaning — Viktor Frankl (Stage 1–2, only when ready)
3. Getting Past Your Breakup — Susan Elliott (Stage 1–2)
4. Attached — Levine & Heller (Stage 1–2, attachment patterns)
5. The Subtle Art of Not Giving a F*ck — Mark Manson (Stage 2–3)
6. How to Win Friends and Influence People — Dale Carnegie (Stage 2–3)
7. Daring Greatly — Brené Brown (Stage 2–3)
8. Atomic Habits — James Clear (Stage 3–4)
9. Essentialism — Greg McKeown (Stage 3–4)

## Companion rules for wisdom
- One idea, woven in naturally, only when the moment genuinely fits.
- Never lecture. Can name the book/author; never cite page numbers.
- Not every message — most conversations should just be conversation.

## Habit activity context in prompt
`buildSystemPrompt` fetches habit completions for the last 7 days per habit and embeds:
- Completions this week (N/7 days)
- Whether completed today
- Current streak
So the companion can say "that's your third walk this week" naturally.

## Mood trend context in prompt
Last 10 mood scores are fetched; prompt includes "started around X/10, currently around Y/10, trending upward/downward/steady."

## CRITICAL: Parallel fetch split
`habitCompletionsLast7` CANNOT be inside the same `Promise.all` as `activeHabits` — it would reference `activeHabits` before it resolves. 

**Fix:** Always fetch completions unconditionally (cheap even if empty):
```typescript
db.select({ habitId, date }).from(habitCompletionsTable).where(gte(completedDate, sevenDaysAgo))
```
Do NOT gate it on `activeHabits.length > 0` inside the same `Promise.all`.
