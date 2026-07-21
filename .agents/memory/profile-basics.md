---
name: Profile basics (age + country)
description: Storage rules, adults-only gate integrity, and prompt-safety whitelist for user age and country
---

## Storage rules
- Age is stored as `birthYear` (nullable int) so it stays truthful over the years; `ageBand` is derived via `ageToBand()` for legacy surfaces. Clearing age clears both.
- Country is ISO-3166 alpha-2 UPPERCASE with the legacy alias **"UK"** (not GB — existing rows use it; GB input normalizes to UK). `""` = not shared; legacy `"other"` = treated as not shared. Names come from `Intl.DisplayNames` — never hand-maintain a country table.
- **Never guess**: skipped or unresolvable age/country answers store nothing. Browser-locale country suggestion is a chip the user must tap — never auto-applied.

## Adults-only gate integrity (why it's server-side)
The onboarding answer endpoint trusts the client-provided `step`, so the age gate cannot live only in the `ageBand` case:
- Every step at-or-beyond `country` (country/userGender/relationshipType/energy) re-checks **age evidence** (`birthYear != null` or whitelisted `ageBand`) and bounces to the `ageBand` question (persisting `onboardingStep`) before storing anything. `userGender` is the step that completes onboarding — without this check a crafted request skips the gate entirely.
- Legacy sessions parked on the old step order (country before age) are caught by the same check; `getNextStep("ageBand")` skips the country question when a valid country is already stored, so they aren't asked twice.
- Under-18 / invalid age answers return early with a warm message and store NOTHING.

**Why:** companion app is adults-only (18+); the gate is a safety boundary, so it must hold against crafted API calls and legacy mid-flow accounts, not just the UI.

## Prompt-safety whitelist
`ageBand` text reaches system prompts verbatim via `describeUserBasics`. Only `AGE_BANDS` (exported from api-server basics lib) may ever be stored (PUT /profile whitelists; "" clears) or interpolated (describeUserBasics guards). daily-email has a **local copy** of both `AGE_BANDS` and `describeUserBasics` — keep wording and guards in sync when either changes.

**How to apply:** any new field that reaches a prompt needs either strict validation (codes/numbers) or a whitelist guard at BOTH the write path and the interpolation site.

## UI notes
- Onboarding shows ONE composite basics card at the `ageBand` step (age input + country search + suggestion chip); after age advances, the client silently auto-submits the country answer so the two server steps feel like one moment. Reload mid-flow at `country` renders a country-only card.
- Crisis lines: `getCrisisLine` has explicit cases for CA (988) and IN (AASRA/iCall) in addition to earlier countries.
