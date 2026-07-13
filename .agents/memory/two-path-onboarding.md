---
name: Two-path onboarding (breakup vs bereavement)
description: Onboarding branches at step 1 into breakup recovery or bereavement/late-life loss paths. Profile stores userPath and country.
---

## New onboarding flow

**Steps in order:**
```
path → country → name → [breakup: relationshipType →] energy → companionName → done
```
- Bereavement path skips `relationshipType` (defaults to "friend") and uses gentler wording
- Step questions are generated dynamically via `getStepQuestion(step, profile)` in `onboarding.ts`
- Next-step logic is in `getNextStep(currentStep, profile)` — reads `profile.userPath` to branch after "name"

**DB fields added to profile table:**
- `userPath`: text, default "breakup" (`"breakup" | "bereavement"`)
- `country`: text, default "" (`"US" | "UK" | "AU" | "other"`)

**Critical:** The profile route (`profile.ts`) must include `userPath` and `country` in the response object passed to `GetProfileResponse.parse()` and `UpdateProfileResponse.parse()`. If a new field is added to the OpenAPI Profile schema, it MUST be added to both response builders in `profile.ts` or a Zod validation error will throw 500.

**First greeting:**
- Bereavement: warm, no recovery framing, "I'm honoured to meet you"
- Breakup + romantic: tender, "I'm going to be here with you"
- Breakup + friend: collegial, "Really good to meet you"

**Why:**
Global product (US/UK/AU) serving two distinct audiences: people in breakup recovery and older adults who have lost a partner. These require fundamentally different AI personas, content restrictions, and UX density.

**How to apply:**
Check `profile.userPath === 'bereavement'` wherever path-specific behavior is needed. In the system prompt this controls what content is allowed (no dating content for bereavement). In the frontend Chat.tsx this controls the `gentle-mode` CSS class.
