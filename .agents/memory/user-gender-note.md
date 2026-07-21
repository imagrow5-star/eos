---
name: User gender note
description: How the user's gender flows into every prompt surface; sync + invariant rules
---

Feature: the user can tell Eos their gender (onboarding step or Settings "About you") so she addresses THEM correctly. Her own persona/voice never changes with it.

**Rules that are easy to break later:**
- Stored values: `man` | `woman` | `custom` (+ `userGenderCustom` free text). Legacy `other` rows and unknown/null must render as the EXPLICIT "hasn't shared — never assume, keep language neutral" line, not silence. Silence = model guesses.
- Invariant: `userGenderCustom` may only persist when `userGender === "custom"`. The profile PUT enforces it against combined payloads (e.g. `{userGender:"man", userGenderCustom:"…"}` must end man/null); keep that if the route is reworked.
- Custom words are user-controlled text interpolated into system prompts → sanitized on WRITE (shared `sanitizeGenderWords`: strips quotes/backslashes/control chars, collapses whitespace, caps 120) and defensively on READ in the describe helper.
- **daily-email has its own LOCAL copy of `describeUserGender`** (separate package, queries DB directly). Any wording/logic change to the api-server helper must be mirrored there.
- Prompt surfaces that must all carry the note: chat + voice system prompt (stable/cached block — changing gender busts the cache, accepted), contextual greetings, in-app morning notes, daily emails, commitment nudges. Extraction prompts intentionally excluded.
- Onboarding UI: the "In my own words" chip sends a client-only `__custom__` sentinel — it must never reach the server; free text flows through the normal answer handler, where woman/female is keyword-matched BEFORE man/male (substring trap).

**Why:** gender phrasing is a safety/tone-integrity feature for a vulnerable-user companion app; a missed surface or an assumed gender is a trust break, not a cosmetic bug.

**How to apply:** touching any prompt surface, the profile PUT, onboarding answers, or the daily-email package → re-check the list above; grep both packages for `describeUserGender`.
