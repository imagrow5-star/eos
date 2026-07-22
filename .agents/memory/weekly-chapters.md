---
name: Weekly chapters (Growth Analysis phase 1)
description: Architecture and hard invariants of the weekly personal-growth chapter feature — quote gates, kind-truth check, trigger design, coverage guards.
---

# Weekly chapters — architecture & invariants

Weekly per-user "chapter" on the Journey tab: sealed card (threshold question + optional 1–10 mood/loneliness dot scales) → revealed reader (thread opening, themed then/now quote pairs, goal/habit review, at most one micro-goal offer).

## Hard invariants (do not weaken)
- **Verbatim quote gate**: every quote must pass `validateExcerpt` (services/chapters/quotes.ts) — exact substring of the user's stored message. AI proposes; code verifies. Fabrication is catastrophic in this product.
- **Crisis messages are never quotable** (crisis.ts lexicon filters candidates before the model ever sees them).
- **Kind-truth check**: deterministic regex floor (`deterministicViolations`) is the hard gate — clinical labels, verdicts, digit counts/timestamps in Eos prose are rejected; the Haiku pass is advisory on top. Failing sections regenerate once, then fall back.
- **Offer eligibility**: micro-goal offer only when user has ZERO active goals AND habits; decline → ~14-day cooldown (`personalizationState.goalOfferDeclinedAt`); accept → `createGoalWithTasks(..., {dedupeActive:true})`.
- **Quote dismissal is permanent** and scrubs the quote from ALL stored chapters (empty themes dropped, pending offers with dismissed seed nulled) + exclusion table so regeneration can't resurface it.
- All user-visible numbers go through `countToPhrase` — chapter prose is digit-free by design.

## Trigger design
- No cron of its own: the hourly daily-email job POSTs `/api/internal/chapters/run` with `x-internal-token` = HMAC(SESSION_SECRET, `chapters-run:<UTC hour stamp>`); server accepts current+previous hour; `force` rejected in prod; `ignoreWindow` in prod only when scoped to one user.
- Generation window: user-local Sunday ≥18:00 or Monday ≤09:59; analyzed week = last full Mon→Sun; idempotent via UNIQUE(userId, weekStart).
- Eligibility: ≥3 weeks since first message, ≥5 user messages in week, ≥3 quotable candidates; else warm cold-start / quiet-week skip.
- Notification = mention in the morning email only (`emailMentionedAt`); push notifications deferred to Phase 2.

## Completeness guards will catch new user tables
Adding any user-owned table trips three test guards that must be satisfied together: DELETE in the account-deletion handler (+ its test's HANDLER_COVERED_TABLES), a section/exclusion in the JSON **and** HTML export (account.ts + account-export test maps), and a count in the export summary endpoint (+ its test's pairs list). Budget for all three whenever a schema adds a table with user_id.

## Concurrency pattern for one-shot offers
Accept/decline uses an atomic conditional update (`WHERE micro_offer->>'status' = 'pending'`) as the claim; the loser of a race gets 409. On accept, claim FIRST, then create the goal, and hand the offer back (revert to pending) if goal creation fails — this avoids threading a transaction through `createGoalWithTasks`.
**Why:** double-tap / two-tab accepts otherwise create duplicate goals; a plain read-check-write was flagged in review.
**How to apply:** any future one-shot user action stored in jsonb (offers, invitations) should claim via conditional update, never read-then-write.

## Gotchas
- Mood/loneliness answers live on the chapter row only — intentionally NOT written to mood_scores (they're a reflective snapshot, not a tracked mood entry).
- Frontend hits `/api/chapters` via apiFetch with BASE_URL; aanya is the root artifact so shell-side curl uses `http://localhost:80/api/...` (the `/aanya/...` path serves vite HTML — a `grep '{'` probe will false-positive on it).
- No orval codegen for these routes — generated api-client/api-zod files are hand-patched elsewhere; component defines its own mirror types on purpose.
