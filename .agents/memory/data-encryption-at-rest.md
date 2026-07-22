---
name: Data encryption at rest
description: Field-level AES-256-GCM encryption pattern, its SQL-blindness consequences, migration/rotation contract, and the key-handling incident
---

# Pattern
- AES-256-GCM under single master key `DATA_ENCRYPTION_KEY`; format `enc:v1:` + base64(iv‖tag‖ct), 12B IV, AAD = `table.column` (snake_case). No per-row DEK envelope — no KMS ⇒ no boundary gained (rationale in lib/db crypto module header).
- Drizzle `customType` wrappers are the ONLY choke point: encrypt on write, decrypt on read, plaintext passthrough for unprefixed values (live-migration safety), loud `DataEncryptionError` on GCM auth failure — never silent ciphertext.
- jsonb stored as encrypted JSON string scalar; text[] element-wise.
- Key loader accepts 44-char base64 OR 64-char hex (founders use `openssl rand -hex 32`); hex must be tested FIRST — hex also base64-decodes, but to 48 bytes.

# SQL is blind to encrypted columns
**Rule:** any SQL that compares, substring-matches, or JSON-navigates an encrypted column silently breaks (GCM ciphertexts are non-deterministic; jsonb holds a string scalar). All such logic must move to app code.
**Why:** three real cases: voice-turn dedup (content equality), personality-signal dedup (substring), chapter offer claim (`micro_offer->>'status'` optimistic guard → returned 409s).
**How to apply:** for optimistic-concurrency guards, replace conditional UPDATE with `SELECT … FOR UPDATE` + app-side check + UPDATE in one transaction — same atomicity. For dedup, fetch candidate rows and compare decrypted in JS. Grep for `->>`, `LIKE`, `=` on encrypted columns whenever adding queries.

# Migration & rotation contract
- Boot migration: batches, plaintext-detector predicates, per-row optimistic guard (`AND col = original`), same-txn SELECT-back + decrypt + deep-compare, COMMIT only if all match; advisory lock; counts-only logging; idempotent (re-run leaves ciphertext byte-identical).
- Key rotation (`scripts/rotate-data-key.ts` in api-server): OLD via `OLD_DATA_ENCRYPTION_KEY` env, NEW from `DATA_ENCRYPTION_KEY`; skips rows already on NEW; run pass 1 → restart server (kills old-key writer AND old cached key) → pass 2 for stragglers. The running server caches the key at first use — rotating without restart breaks live reads.
- Old-key recovery source if env is gone: the still-running server's `/proc/<pid>/environ`.

# Key handling incident (July 2026)
**Rule:** encryption keys and other secrets must ONLY go through the Replit Secrets flow (`requestSecrets` — user pastes, value never transits chat/context). NEVER `setEnvVars` — that writes plaintext into tracked `.replit`, which lives in git history and checkpoints ⇒ key is burned, full rotation required.
**Why:** exactly this happened with the first `DATA_ENCRYPTION_KEY` pair; architect review caught it pre-publish; dev DB was re-encrypted under a founder-supplied replacement, exposed keys discarded.
**Note:** VAPID keys still sit in `.replit` the same way (pre-existing; rotating breaks push subscriptions — founder's call, flagged).

# Operational
- KEY LOSS = DATA LOSS. Founder keeps offline backup. Server refuses boot without a valid key.
- Every deployment reading encrypted columns needs the key in ITS env — the daily-email Scheduled Deployment fails loudly without it.
- Prod encrypts itself via boot migration on first boot after publish; distinct prod key = override the secret in the deployment's secrets pane.
- Export must decrypt explicitly wherever raw SQL is used (drizzle wrappers don't apply to `pool.query`).
