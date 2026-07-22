---
name: Web push architecture
description: Env-only VAPID keys, the 2/day cap race lesson, atomic morning dedup, iOS constraints
---
- VAPID keypair is ENV-ONLY (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, distinct per environment); `ensureVapidKeys` throws loudly when missing. Moved out of DB `push_config` in the privacy pass so DB access never grants push-send capability; a vitest setup file generates an ephemeral pair when env is absent. Test seams still exist: `_setWebPushForTests(mock|null)` + `_clearVapidCacheForTests()`.
- Hard cap: 2 pushes/user/rolling-24h, ALL kinds combined. Test pushes consume slots — so the test push is a manual button in settings, never auto-sent on enable.
- **Why the advisory lock:** a lone conditional INSERT (`WHERE (SELECT COUNT(*)…) < cap`) is NOT atomic under READ COMMITTED — racing statements' snapshots miss each other's uncommitted rows (a concurrency test proved 5/6 parallel sends all passed). The claim is a per-user `pg_advisory_xact_lock(hashtext('push-cap-<uid>'))` + conditional INSERT in ONE transaction; the lock releases at commit, so the next claimer's fresh snapshot sees the committed row.
- Morning-note once-per-20h dedup is a `NOT EXISTS` clause inside that same locked claim. The sweep's pre-check is advisory only — check-then-send raced when two sweeps overlapped (current + previous-hour HMAC tokens are both valid, so overlap is real).
- Sweep window 6–9 AM via profile.timezone; HMAC endpoint `POST /api/internal/push/morning-run` (`x-internal-token`, stamp `push-morning:<YYYY-MM-DDTHH>`, SESSION_SECRET, timing-safe, current+previous hour accepted).
- Client: enablePush registers `${BASE_URL}sw.js` (scope-relative); subscribe body is the WRAPPED shape `{subscription:{endpoint,keys:{p256dh,auth}}}`; iOS requires Add-to-Home-Screen before push APIs work (needsInstallFirst hint in settings).
- Delivery errors: 404/410 statusCode ⇒ prune the subscription row; anything else ⇒ failureCount++.
- `pushOptIn` had to be added to BOTH buildProfilePayload and the generated zod GetProfileResponse (zod .parse strips unknown keys) or the settings toggle reads stale/absent state.
