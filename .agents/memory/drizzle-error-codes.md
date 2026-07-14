---
name: Drizzle wrapped driver error codes
description: Where Postgres error codes live when caught from Drizzle queries in this project
---

# Drizzle wraps driver errors — pg code lives on `err.cause.code`

Drizzle (0.45.x, node-postgres driver) wraps thrown query errors in a
`DrizzleQueryError`. The original Postgres error (with its SQLSTATE `code`, e.g.
`23505` for a unique violation) is nested at **`err.cause`**, not the top-level
error.

**Rule:** when catching a Drizzle query error to branch on a Postgres code,
check both: `err?.code === "23505" || err?.cause?.code === "23505"`.

**Why:** Several handlers in `artifacts/api-server/src/routes/auth.ts` were
written checking only `err?.code`, so their unique-violation branches never
fired and fell through to a generic 500. The change-email confirmation path in
`GET /auth/verify-email` was fixed to check `err.cause.code`; the `POST
/auth/signup` handler still had the same latent bug at the time (tracked as a
follow-up).

**How to apply:** Any new `catch` block in this codebase that inspects a
Postgres error code from a Drizzle call must read `err.cause.code` (keep the
top-level `err.code` check too for safety across driver/version changes).
