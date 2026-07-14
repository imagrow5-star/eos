---
name: Multi-user auth architecture
description: Session-based auth with Postgres session store; userId columns nullable on all data tables; key gotchas for connect-pg-simple and cookie behavior in Replit
---

# Multi-user auth architecture

## Core decisions

- **Sessions over JWT**: `express-session` + `connect-pg-simple` (pool from `@workspace/db`). Session secret via `SESSION_SECRET` env var.
- **bcryptjs** (not bcrypt) — pure JS, no native build step.
- **userId nullable** on ALL data tables — no `.notNull()` — so existing dev rows survive migration without FK violations.
- **`getOrCreateProfileForUser(userId: number)`** exported from `routes/profile.ts` and imported by `routes/chat.ts`, `routes/onboarding.ts`, `routes/journey.ts`.
- **requireAuth middleware** in `middleware/auth.ts` — attaches `req.userId: number`; session type augmented via `declare module 'express-session'`.

## connect-pg-simple / user_sessions table gotcha

`createTableIfMissing: true` does NOT reliably create the table on cold start (Replit env). The table must be created explicitly on server boot. In `app.ts`:

```typescript
pool.query(`
  CREATE TABLE IF NOT EXISTS user_sessions (
    sid varchar NOT NULL COLLATE "default" PRIMARY KEY,
    sess json NOT NULL,
    expire timestamp(6) NOT NULL
  );
  CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON user_sessions (expire);
`).catch((err) => logger.error({ err }, "Failed to ensure user_sessions table"));
```

**Why:** `connect-pg-simple@10` fails silently on table creation if the pool isn't fully ready when the middleware initializes. The explicit pool.query at module load time runs slightly later and works reliably.

## Cookie behavior in Replit

- Replit proxy rewrites `SameSite: lax` → `SameSite: None; Secure` on the response header. This is correct for cross-origin preview iframes.
- Express server must set `secure: false` (not `true`) — the inner Express sees HTTP; TLS is handled by Replit's proxy layer.
- `app.set('trust proxy', 1)` is required.
- Cookies are same-domain in Replit's preview, so no `credentials: 'include'` changes needed in frontend fetch calls.

## Routes layout

```
/api
  /auth/signup   POST  — public
  /auth/login    POST  — public
  /auth/logout   POST  — public
  /auth/me       GET   — public (returns 401 if not logged in)
  [all others]   — protected by requireAuth middleware
```

`requireAuth` is applied via `router.use(requireAuth as any)` in `routes/index.ts` after mounting `healthRouter` and `authRouter`.

## Frontend auth gate

`AuthGate` component in `App.tsx` wraps everything inside `QueryClientProvider`:
- `useQuery(['/api/auth/me'])` with `retry: false`
- Loading → navy spinner
- Error (401) → `<AuthScreen>` (sign in / create account)
- Success → `<WouterRouter>` + `<AppRouter>`

Logout in `Shell.tsx`: POST `/api/auth/logout`, then `queryClient.setQueryData(["/api/auth/me"], null)` + invalidate — instant redirect to login without a page reload.

## Data isolation pattern

Every DB query in every route must filter by `eq(table.userId, req.userId)`. Services (ai.ts, systemPrompt.ts) receive `profile` which has `profile.userId` after schema migration — use `(profile as any).userId as number` since the generated API-Zod types lag the DB schema.
