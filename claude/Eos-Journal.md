# Eos — build journal

A running log of what's shipped and what's next. Sprint-level history before
this file was tracked in git and the `.agents/memory/` notes; this journal
starts at Sprint E and forward.

## Shipped

- **Sprint E — Memory export ("download your journal")** ✅
  User-triggered export of everything Eos remembers. `GET /api/memory/export`
  serves a portable nested JSON (`format=json`) and a warm, readable Markdown
  memoir (`format=markdown`), rate-limited to 1/hour/user. Read-only; every
  encrypted column is decrypted to the user's own plaintext; crisis events are
  metadata-only and subscription data carries no payment method. A "Your data"
  block in Settings offers both downloads. Built on the single export loader
  (`fetchExportPayload`) so every future user-data table flows through one
  pipeline. Closes the safety-page promise ("…or export it at any time") and the
  SB 243 / EU AI Act data-portability gap. See
  `.agents/memory/memory-export.md`.

- **Sprint 2B — "Remember this"** ✅
  Explicit user command to star a memory as important; the ranker honours
  `user_marked_important` with a top-of-list boost. Star toggle in the Memory
  Manifest.

- **Sprint 2A — Memory importance ranking** ✅
  Facts scored on recency + reference frequency/recency + emotional weight
  (`times_referenced`, `last_referenced_at`, `emotional_weight`,
  `user_marked_important`), backfilled at boot so old-but-important memories stop
  losing to new trivial ones.

- **Privacy Tier 3 — log hygiene** ✅
  No server-side log line emits a raw `userId`; a salted `hashUserIdForLog`
  hash (`uh`) is used everywhere, enforced by a static guardrail + runtime path
  regression tests.

- **CI** ✅
  GitHub Actions: typecheck + full test suite (against a real Postgres) on every
  PR to `main` and every push to `main`.

## Next up

- **Sprint 3 — Intentions**
- **Sprint 2C — Feelings**
- **Sprint 2D — Parts**

Each of these adds user data. Per Sprint E's pipeline rule, every new
user-owned table must be wired into `fetchExportPayload` (and the deletion sweep
+ export-coverage guards) from day one so it appears in the memory export
automatically.
