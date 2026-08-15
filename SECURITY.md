# Eos — Data Protection & Encryption Threat Model

Written for an external security review. This documents what is actually
implemented in this repository — not aspirations. File references are to
code in this repo; every guarantee listed here is enforced by a test named
alongside it.

Last updated: August 2026.

## 1. Architecture in one paragraph

Eos is an Express API (`artifacts/api-server`) over Postgres, a React client
(`artifacts/aanya`), and an hourly job (`artifacts/daily-email`). Sensitive
user content is encrypted at the application layer before it reaches the
database, with AES-256-GCM under a single 32-byte master key. Ciphertext is
stored in the same columns as `enc:v1:<base64(iv ‖ tag ‖ ciphertext)>`, with
a fresh random 96-bit IV per value and AAD binding each value to its
`table.column` (`lib/db/src/crypto.ts`). All reads and writes go through
drizzle custom column types (`lib/db/src/encryptedColumns.ts`), so encryption
is a choke point, not a per-callsite discipline; the few raw-SQL readers
(account export) decrypt explicitly.

## 2. What is encrypted

The registry is `SPECS` in
`artifacts/api-server/src/services/dataEncryptionMigration.ts` — it drives
the boot migration for legacy rows AND the key-rotation engine, so it is the
single source of truth. Summary: message content; memory facts and feelings;
personality signals; wins; sealed notes (prompt, text, crisis flag); habit,
goal, commitment and task free text; weekly-chapter narrative fields (jsonb);
story-thread retellings; personalization phrase arrays; profile display name
and custom gender; and crisis-event pattern names
(`crisis_events.pattern_matched` — the name alone reveals crisis state).

Deliberately plaintext (SQL filters/sorts on them; they reveal nothing said):
enums and counters (roles, states, streaks), timestamps, mood scores, dates,
country codes served for helplines, dismissal flags, billing/subscription
records, push subscription endpoints, email addresses, and password hashes
(bcrypt — hashed, not encrypted).

Metadata that remains observable to a database-level attacker even with
encryption: row counts, timing patterns (when a user talks, when a crisis
event fired), message lengths, and the user-to-row linkage. This is inherent
to the design and stated in the "not protected" list below.

## 3. Key custody

Two modes, resolved once at boot by `initDataKey()` (`lib/db/src/crypto.ts`),
awaited by both `api-server/src/index.ts` and `daily-email/src/run.ts`:

- **Raw mode** — `DATA_ENCRYPTION_KEY` holds the 32-byte key (base64/hex).
  Anyone who can read the environment holds the key.
- **KMS mode** — `DATA_ENCRYPTION_KEY_WRAPPED` holds the key encrypted under
  an AWS KMS key that never leaves the KMS. Boot sends the blob to
  `kms:Decrypt` and keeps the unwrapped key in process memory only. The
  environment alone no longer decrypts the database; an attacker needs live
  KMS credentials as well, and every unwrap is auditable in CloudTrail.

Fail-closed properties (all pinned in
`api-server/src/__tests__/key-custody.test.ts`):
- no key at all → the server refuses to boot;
- KMS unreachable / bad credentials / wrong-size unwrap → refuses to boot;
- raw key pasted into the wrapped slot → refuses to boot;
- both slots set but decoding to different keys → refuses to boot;
- sync key access before the async unwrap → throws, naming the wiring bug;
- decrypt with the wrong key NEVER silently returns ciphertext — it throws
  (`DataEncryptionError`), so corruption and key mix-ups surface immediately.

Enabling KMS mode (runbook):
1. `aws kms create-key` (symmetric, region of choice); restrict the key
   policy to one IAM principal with `kms:Decrypt` only.
2. `aws kms encrypt --key-id <arn> --plaintext fileb://<(echo -n "$KEY" | base64 -d) --query CiphertextBlob --output text`
   → set the output as `DATA_ENCRYPTION_KEY_WRAPPED` alongside
   `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.
3. Deploy with BOTH slots set (boot verifies they agree), then remove
   `DATA_ENCRYPTION_KEY` from the environment.

## 4. Key rotation

`artifacts/api-server/scripts/rotate-data-key.ts` (CLI) →
`src/services/dataKeyRotation.ts` (engine). Decrypts each row with the old
key, re-encrypts with the new, with: per-row optimistic guards (concurrent
live writes never clobbered), same-transaction verify-before-commit, full
idempotence (safe to re-run after a crash), and loud aborts on rows that
decrypt under neither key. Proven live in
`__tests__/key-rotation.test.ts`.

## 5. Key backup — KEY LOSS = DATA LOSS

There is **no recovery path** for encrypted rows without the key. The key is
never written to the database, logs, or the repo; it exists only in the
hosting environment's secret store plus whatever offline backup the operator
keeps. Operator guidance:
- keep the RAW key value (44-char base64) in a password manager AND one
  offline copy (paper/USB in a safe place), recorded at setup time and
  verified by comparing against the live env value;
- in KMS mode, additionally protect the KMS key against deletion (AWS
  enforces a 7–30 day deletion waiting period; do not schedule deletion);
- never place the key in email, chat, notes apps, or the repository.

## 6. Transit and session protection

- Boot verifies the live app↔database connection is TLS via `pg_stat_ssl`
  (ground truth for the socket, not config intent) and **refuses to run in
  production on cleartext**; `DATABASE_SSL=require|verify` configures the
  pool, `DB_TLS_ENFORCE=off` is a loud, deliberate escape hatch for private
  networks (`api-server/src/services/bootGuards.ts`).
- Production refuses to boot with a `SESSION_SECRET` under 32 characters
  (it signs login cookies, voice tokens, unsubscribe links, and internal
  HMAC sweep tokens). Sessions: Postgres-backed, httpOnly, SameSite=Lax,
  Secure in production; helmet CSP; rate limits on auth endpoints.
- Client↔server TLS is terminated by the hosting platform (Render).

## 7. What this design protects against — and what it does NOT

Protected:
- a stolen database dump, stolen disk/backup, or read-only SQL access
  (e.g. SQL injection on a read path) exposes ciphertext, not conversations
  — proven end-to-end by `__tests__/breach-dump-scan.test.ts`, which seeds a
  canary through the real app layer and scans a raw dump for it;
- a leaked environment snapshot alone, in KMS mode (the wrapped blob is
  useless without `kms:Decrypt`);
- accidental plaintext logging of content (logs carry counts, hashed user
  ids, and lengths — guarded by the logs-privacy test suite);
- key mix-ups and silent corruption (GCM auth + AAD binding: a value moved
  to another column or table fails loudly).

NOT protected — an honest list for the reviewer:
- an attacker with code execution inside the running app (the key is in
  process memory; they can read whatever the app can);
- the operator: whoever controls the hosting environment and (in KMS mode)
  the AWS account can obtain the key; "we don't read your conversations" is
  an organizational promise backed by no admin tooling existing, not a
  cryptographic guarantee;
- third-party processors in the request path: Anthropic receives message
  content to generate replies (no training, bounded retention); ElevenLabs
  processes voice audio/transcripts (retention pinned to delete-after-
  processing by a boot guard); Resend sees email content;
- metadata (section 2): counts, timestamps, lengths, and the existence of
  crisis events per user remain visible to a database-level attacker;
- Postgres logical backups made by the hosting provider contain the same
  ciphertext — safe — but session rows (`user_sessions`) are plaintext, so a
  dump enables session hijack until sessions expire or the table is cleared;
- a compromised client device (content is necessarily plaintext on screen).

## 8. Deletion

Account deletion wipes ~25 tables in one FK-ordered transaction (messages,
memories, chapters, notes, crisis events, sessions, profile, account row),
after cancelling any Paddle subscription; billing event records are retained
(financial-audit requirement, no content). Per-message "forget" and
per-memory deletion are hard DELETEs. There is no soft-delete or grace
period. Provider-side database backups age out on the provider's schedule —
deleted rows can persist in those backups until then; this is disclosed in
the privacy page.

## 9. Residual gaps / accepted risks (ranked)

1. Operator access remains possible by design (server-side encryption).
   Mitigations: no read tooling exists, KMS audit trail. Eliminating it
   requires client-side/E2E encryption, which conflicts with server-side AI
   processing — out of scope.
2. `user_sessions` rows are plaintext (contain user ids, not content) —
   session hijack window from a stolen dump; acceptable short-term, could be
   encrypted or rotated aggressively later.
3. Anthropic/ElevenLabs/Resend see content in the clear during processing —
   inherent to what the product does; bounded by DPAs and retention settings.
4. In raw-key mode the environment alone yields the key — mitigated by
   moving to KMS mode (section 3 runbook).
