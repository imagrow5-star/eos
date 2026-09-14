---
name: Login hardening
description: Per-account lockout, timing equaliser, password policy with HIBP, session revocation helper, and where each is wired
---

# Pieces (api-server)
- `services/loginLockout.ts`: `failed_login_attempts` / `locked_until` on users. Threshold 5, hold 2^(n-5) min capped at 15. Increment + hold is ONE UPDATE (`recordFailedLogin`); `clearLoginFailures` on success; reset-password clears both columns inline. Columns are added at boot by `schemaGuard.ensureLoginLockoutColumns` (deploys don't run drizzle-kit push).
- Login route: unknown email → `bcrypt.compare` against a lazily built dummy hash (timing equaliser), then the generic 401. Held account → 429 + `Retry-After` + `retryAfterSeconds`, checked BEFORE the compare.
- `lib/passwordPolicy.ts`: `passwordProblem()` (8 chars–72 bytes) and `isBreachedPassword()` (HIBP range, `Add-Padding`, 2.5 s timeout, fails open; `PASSWORD_BREACH_CHECK=off`). Applied at signup, reset-password, change-password — never at login. Tests: `setup/password-policy-env.ts` turns it off; the seam `_setBreachFetchForTests` proves it.
- `services/userSessions.ts` `purgeUserSessions(userId, { except })`: the ONE place sessions are revoked by user id (jsonb match on `sess->>'userId'`). Used by change-password, logout-all, verify-email (change branch, keeps the confirming session if it's the same account), reset-password (no except).
- Routes: `POST /auth/change-password` {currentPassword,newPassword} → 403 wrong current, revokes others + drops reset tokens; `POST /auth/logout-all` → keeps caller. SPA: `ChangePasswordForm`, `SignOutEverywhere` in the Chat settings panel under Account email.

# Rules
- Google-created accounts have a random password: change-password/change-email 403 for them by design; the form text points at "Forgot password".
- Any new place a password is SET must call `passwordProblem` + `isBreachedPassword`; any new credential change must call `purgeUserSessions`.
