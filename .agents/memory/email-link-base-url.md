---
name: Email link base URL
description: How to build public app URLs for links inside emails (verify, reset) so they work in production
---

# Email link base URL

**Rule:** Any URL placed inside an outgoing email (verification, password reset, cancel/unsubscribe links) must be built via a base-URL helper that checks, in order: `APP_URL` (explicit override) → `REPLIT_DOMAINS` (first comma-separated entry) → `REPLIT_DEV_DOMAIN` → localhost fallback.

**Why:** `REPLIT_DEV_DOMAIN` exists only in the workspace, NOT in deployments. Code that checked only `REPLIT_DEV_DOMAIN` sent production emails linking to `http://localhost:3000`, so real users clicking verification/reset links from their inbox hit a dead page and could never verify or log in. `REPLIT_DOMAINS` is set in both environments: the production domain on deployments, the `.replit.dev` preview domain in the workspace — so checking it first works everywhere.

**How to apply:** auth routes use a `getAppBaseUrl()` helper; the daily-email job uses the `APP_URL ?? <hardcoded prod URL>` convention. When adding any new email with links, reuse one of these — never read `REPLIT_DEV_DOMAIN` directly for user-facing URLs.
