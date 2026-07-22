---
name: Mobile web resilience
description: Patterns for surviving mobile tab-discard reloads — per-tab draft persistence, auth-boundary wipes, RHF reset gotcha, emailed-token handling
---

# Mobile web resilience (tab discard = routine reload)

Mobile browsers routinely discard backgrounded tabs. Any state held only in
React state is lost the moment the user switches to another app (email,
password manager) and comes back. Symptoms reported as "the app keeps
refreshing" or "my form got cleared" are usually this, not an in-app bug —
verify there are no in-app reload triggers, then make reloads lossless.

## Rules

**Emailed single-use tokens must survive a reload.** If a token arrives via
URL param and gets stripped from the URL for privacy (correct instinct), it
MUST also be persisted per-tab (sessionStorage) — otherwise the discard→reload
cycle strands the user tokenless mid-flow. This exact chain broke password
reset: token → React state only → URL stripped → user switches to email app →
tab discarded → reload without param → dumped on login tab.
**How to apply:** param → sessionStorage + state; restore on mount; clear on
success, on leaving the flow, and at auth boundaries. Also render a dead-end
guard ("link not available, request a fresh one") for the token-missing state
instead of letting the form submit token:null into a generic error.

**Per-tab draft persistence convention lives in `sessionDrafts.ts` (aanya
lib).** Keys for auth form (tab+email), reset token, chat composer draft.
Passwords are NEVER persisted anywhere — non-negotiable. Chat drafts are
per-tab only (sessionStorage, not localStorage) as the privacy tradeoff.
**Why:** losing a half-written message in a companion app is a real UX wound;
per-tab scope + boundary wipes keep the privacy cost near zero.

**Wipe all draft keys at every auth boundary** (login success, signup success,
every logout handler — there can be more than one, e.g. a verification-gate
logout). Otherwise a shared device leaks one account's unsent text or email
into the next session. Use the single `clearSessionDrafts()` helper, never
ad-hoc removeItem calls.

**react-hook-form `reset()` gotcha:** bare `form.reset()` restores
`defaultValues`. If defaultValues were seeded dynamically (e.g. a draft
restored from storage), reset() brings the "cleared" content BACK — and any
watch-based persister immediately re-saves it. When defaults are dynamic,
always reset with explicit values: `form.reset({ content: "" })`.

**Watch-based persistence:** `form.watch(cb)` subscription (unsubscribe in
effect cleanup) writing to sessionStorage; remove the key when value is empty
so reset→empty naturally clears storage.

## Still open (deliberately not done)
The cancel-reset email link auto-fires its state-changing POST from a page
load. Email scanners that execute JS could kill pending tokens before the user
clicks the real link. Hardening = require an explicit confirm click. Related
backlog tasks exist around cancel/used-link UX — don't fix as a side effect.
