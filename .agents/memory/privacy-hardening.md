---
name: Privacy hardening (Phase A)
description: Consent gating, forget-this scrub cascade, CORS/CSP posture, env-only VAPID, ElevenLabs retention — decisions and invariants
---

**Founder requirement:** no admin should be able to read user conversations. Every subsystem that stores, logs, or transmits user words must justify it. Server/browser logs carry lengths and ids, never content.

## Consent gate
- `profile.consentVersion` / `consentAt` / `dataSharingOptIn` columns; `CONSENT_VERSION` constant in the frontend `lib/consent.ts`. **Bumping the constant forces a re-consent for ALL users on next visit** — that is the intended mechanism, use deliberately.
- `POST /api/profile/consent`: version required (≤64 chars), `consentAt` set server-side, sharing opt-in persists **only on literal `true`** (strings/truthy rejected).
- AuthGate blocks the whole app until the stored version matches. **Why:** consent must precede any data collection. **How to apply:** the gate query must always keep an explicit error branch with a reload action — an architect review caught a spinner-lockout when the profile fetch failed; never regress that.

## Forget-this cascade
- Deleting a chat message runs ONE transaction: messages row + `chapter_quote_dismissals` rows + `story_threads.retellings[*]` entries with a matching `questionMessageId` get `question`/`questionMessageId` nulled (neutral paraphrase fields stay).
- Already-written weekly chapters intentionally keep their wording — disclosed on the public /privacy page.
- **How to apply:** any NEW table that stores verbatim message excerpts (quote + messageId) must join this cascade AND the account-deletion/export guards, or forget-this silently leaks.

## CORS / CSRF posture
- Exact-host allow-list only (`isAllowedOrigin`, exported for tests). **NEVER add a `*.replit.dev` wildcard** — every repl gets such a domain, so a suffix rule trusts attacker-controlled origins (architect finding). The workspace preview is covered exactly via `REPLIT_DEV_DOMAIN`. No-Origin requests pass (same-origin/curl).
- CSRF: SameSite=Lax cookies + strict CORS; explicit CSRF tokens deliberately deferred (future-phase candidate).

## Headers
- Helmet on the API: CSP `default-src 'none'` + `frame-ancestors 'self'`, frameguard OFF (x-frame-options would conflict), CORP same-origin, HSTS prod-only. Style `unsafe-inline` kept for the HTML export/report page.
- Frontend CSP is a **build-only** `<meta>` injected by a vite plugin — dev/HMR must stay untouched; meta CSP cannot express frame-ancestors (browser limitation, accepted).

## Vendor data
- ElevenLabs conversation retention pinned to 0 via the boot config guard (`platform_settings.privacy.retention_days`; absent field reads -1 = drift). One-time remediation deleted all previously stored vendor-side conversations. Guard re-asserts on every prod boot.
