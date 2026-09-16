import { initDataKey } from "@workspace/db";
import app from "./app";
import { logger } from "./lib/logger";
import { initVoiceLibrary } from "./services/voiceLibrary";
import { reconcileAgentConfig } from "./services/agentConfigGuard";
import { runDataEncryptionMigration } from "./services/dataEncryptionMigration";
import { backfillVoiceGender } from "./services/settings/voiceGenderBackfill";
import { backfillLanguageSunset } from "./services/settings/languageSunset";
import { scrubMessageAnnotations } from "./services/messageAnnotationScrub";
import { migrateRomanticPersona } from "./services/settings/romanticPersonaMigration";
import { ensureProfileThemeColumns, ensureReflectionReportsTable, ensureMorningNoteColumns, ensureDodoBillingColumns, ensureHumeVoiceColumn,
  ensureLoginLockoutColumns, dropRetiredPushTables, ensureDemoSessionsTable, ensureMemoryFactLifecycleColumns } from "./services/schemaGuard";
import { backfillMemoryImportance } from "./services/memory/backfill";
import { runDedupBackfill } from "./services/memory/dedupBackfill";
import { runMemoryTextSweep } from "./services/memoryTextSweep";
import { warnIfAgentEnvIncomplete } from "./services/voiceAgentRouting";
import { sessionSecretIssue, checkDbTls } from "./services/bootGuards";
import { secretSplitWarnings } from "./lib/secrets";
import { runAuthTokenHashSweep } from "./services/authTokenHashSweep";

// User content is encrypted at rest — without the master key the app can
// neither read nor write it. Refuse to boot rather than serve a broken app.
// Two custody modes (see lib/db/src/crypto.ts): DATA_ENCRYPTION_KEY holds the
// raw key, or DATA_ENCRYPTION_KEY_WRAPPED holds it KMS-encrypted and boot
// unwraps it into process memory only. Both fail closed here.
// KEY LOSS = DATA LOSS: keep a secure offline backup of the RAW key value for
// each environment, even in KMS mode.
try {
  const keyMode = await initDataKey();
  if (keyMode === "none") {
    logger.error(
      "FATAL: no data encryption key configured (DATA_ENCRYPTION_KEY missing/invalid and no " +
        "DATA_ENCRYPTION_KEY_WRAPPED). Refusing to boot — stored user content is encrypted and " +
        "unreadable without it. Set the secret for this environment. NEVER rotate or delete it " +
        "without a migration: losing this key permanently destroys all encrypted user data.",
    );
    process.exit(1);
  }
  logger.info({ keyMode }, "data encryption key ready");
} catch (err) {
  logger.error(
    { err },
    "FATAL: data encryption key initialization failed (invalid key, or KMS unwrap failed). " +
      "Refusing to boot rather than serve without the key.",
  );
  process.exit(1);
}

// SESSION_SECRET signs login cookies (and, until the dedicated secrets are
// set, derives the voice-token and internal-sweep keys — lib/secrets.ts).
// app.ts refuses to boot without one; production also refuses a weak
// (< 32 char) one — a short secret is brute-forceable offline.
{
  const secretIssue = sessionSecretIssue();
  if (secretIssue) {
    if (process.env.NODE_ENV === "production") {
      logger.error(`FATAL: ${secretIssue}. Refusing to boot.`);
      process.exit(1);
    }
    logger.warn(`${secretIssue} — acceptable outside production, but fix before deploying`);
  }
  for (const w of secretSplitWarnings()) logger.warn(w);
}

// ─── Account email delivery ──────────────────────────────────────────────────
// Verification, password reset and email-change mails are the one thing that
// has to work: a person who never gets the link is locked out before they
// start. Without RESEND_API_KEY every send silently no-ops; without APP_URL
// on a non-Replit host the link can't be built and every send fails. Say so
// at boot, loudly, in production — not only in a log line per attempt.
if (process.env.NODE_ENV === "production") {
  if (!process.env.RESEND_API_KEY) {
    logger.error(
      "RESEND_API_KEY not set — account emails (verification, password reset, email change) will NOT be delivered",
    );
  }
  if (!process.env.APP_URL?.trim() && !process.env.REPLIT_DOMAINS && !process.env.REPLIT_DEV_DOMAIN) {
    logger.error(
      "APP_URL not set — verification and reset links cannot be built; every account email will fail to send",
    );
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Schema guard BEFORE accepting traffic: deploys don't run drizzle-kit push,
// and a database missing the theme columns 500s every profile read (broke
// production login). Idempotent ADD COLUMN IF NOT EXISTS — instant no-op once
// applied. On failure we still boot (DB may be briefly unreachable): the
// in-request retry inside getOrCreateProfileForUser covers the gap.
await ensureProfileThemeColumns().catch((e) =>
  logger.error(
    { err: e },
    "profile theme column guard failed at boot — profile reads will self-heal per request",
  ),
);

// Create the reflection_reports table if a deploy predates it (deploys don't run
// drizzle-kit push). Idempotent; instant no-op once applied. On failure we still
// boot — the first reflection generate/list would surface the error instead.
await ensureReflectionReportsTable().catch((e) =>
  logger.error(
    { err: e },
    "reflection_reports table guard failed at boot — reflection endpoints may error until the table exists",
  ),
);

// Add the morning-note last_surfaced_at columns if a deploy predates them.
// Idempotent; instant no-op once applied. On failure we still boot — the
// morning generators tolerate the column being absent (they treat it as null).
await ensureMorningNoteColumns().catch((e) =>
  logger.error(
    { err: e },
    "morning-note column guard failed at boot — staleness tracking may be degraded until the columns exist",
  ),
);

// Rename the subscriptions provider-id columns (paddle_* → dodo_*) if a deploy
// predates the Dodo Payments migration (deploys don't run drizzle-kit push).
// Idempotent; instant no-op once applied. On failure we still boot — billing
// reads would throw 42703 until the rename applies on a later boot.
await ensureDodoBillingColumns().catch((e) =>
  logger.error(
    { err: e },
    "dodo billing column guard failed at boot — subscriptions reads may fail until the rename applies",
  ),
);

// Add the Hume call-voice column if a deploy predates it. Idempotent; instant
// no-op once applied. On failure we still boot — the profile-read retry inside
// getOrCreateProfileForUser does not cover this column, so profile reads may
// 42703 until a later boot applies it.
await ensureHumeVoiceColumn().catch((e) =>
  logger.error(
    { err: e },
    "hume voice column guard failed at boot — profile reads may fail until the column exists",
  ),
);

// Add the per-account login throttle columns if a deploy predates them.
// Idempotent; instant no-op once applied. On failure we still boot — every
// login would 42703 until a later boot applies it, so the error is loud.
await ensureLoginLockoutColumns().catch((e) =>
  logger.error(
    { err: e },
    "login lockout column guard failed at boot — logins will fail until users.failed_login_attempts / locked_until exist",
  ),
);

// Add the memory-fact lifecycle columns (previous_fact, updated_at,
// retired_at) if a deploy predates them. Idempotent. Every fact read filters
// on retired_at, so on failure the error is loud: chat would 42703 until a
// later boot applies it.
await ensureMemoryFactLifecycleColumns().catch((e) =>
  logger.error({ err: e }, "memory_facts lifecycle column guard failed at boot — fact reads will fail until the columns exist"),
);

// Create the landing-page demo log if a deploy predates it. Idempotent. On
// failure we still boot — the voice demo's availability check fails closed,
// so the button stays hidden until a later boot creates the table.
await ensureDemoSessionsTable().catch((e) =>
  logger.error({ err: e }, "demo_sessions guard failed at boot — the voice demo stays hidden until the table exists"),
);

// Drop the retired web-push tables (device endpoints, delivery log, and a
// plaintext VAPID private key). Idempotent; no-op once gone. On failure we
// still boot — nothing reads them.
await dropRetiredPushTables().catch((e) =>
  logger.error({ err: e }, "retired push table drop failed at boot — harmless, retried next boot"),
);

// Hash any auth tokens still stored raw (one-time, idempotent, advisory-locked;
// see services/authTokenHashSweep.ts). Runs BEFORE serving so a pending reset
// link issued under the old raw-storage scheme works from the first request —
// lookups now compare hashes only. On failure we still boot: new tokens are
// written hashed regardless, and the sweep retries next boot.
await runAuthTokenHashSweep().catch((e) =>
  logger.error(
    { err: e },
    "auth-token hash sweep failed at boot — pre-deploy pending reset/verification links may not work until the next boot",
  ),
);

// Verify the database connection is actually TLS-encrypted (pg_stat_ssl is
// ground truth for the live socket, not the config's intent). Field-level
// encryption covers stored content, but session rows and query metadata cross
// this connection — production refuses to run it in cleartext. Escape hatch
// for deliberately-private networks: DB_TLS_ENFORCE=off (still logs loudly).
// "unknown" (DB briefly unreachable) warns instead of exiting, matching the
// tolerance of the schema guards above.
{
  const tlsState = await checkDbTls();
  if (tlsState === "plaintext") {
    if (process.env.NODE_ENV === "production" && process.env.DB_TLS_ENFORCE !== "off") {
      logger.error(
        "FATAL: database connection is NOT TLS-encrypted. Refusing to boot in production. " +
          "Set DATABASE_SSL=require (or add sslmode=require to DATABASE_URL) so queries and " +
          "session data are encrypted in transit. If the database is only reachable over a " +
          "private network and you accept cleartext there, set DB_TLS_ENFORCE=off to override.",
      );
      process.exit(1);
    }
    if (process.env.NODE_ENV === "production") {
      logger.warn(
        "DB_TLS_ENFORCE=off: running PRODUCTION with a NON-TLS database connection — acceptable only if the database is reachable solely over a trusted private network",
      );
    } else {
      logger.warn(
        "Database connection is NOT TLS-encrypted — fine for local dev/CI; production would refuse to boot",
      );
    }
  } else if (tlsState === "unknown") {
    logger.warn(
      "Could not determine database TLS state at boot — check pg_stat_ssl manually if this persists",
    );
  } else {
    logger.info("Database connection is TLS-encrypted");
  }
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Encrypt any pre-encryption plaintext rows in place (idempotent, resumable,
  // advisory-locked; verify-before-commit). Runs while serving — reads pass
  // plaintext through until each row is migrated.
  runDataEncryptionMigration().catch((e) =>
    logger.error({ err: e }, "Data-encryption migration failed — plaintext rows remain readable; investigate before next deploy"),
  );

  // Stamp voice_gender from companion gender for rows that predate the column
  // (idempotent single UPDATE; reads also derive a fallback, so a failed run
  // never changes what anyone hears).
  backfillVoiceGender().catch((e) =>
    logger.error({ err: e }, "voice_gender backfill failed — reads fall back to companion gender"),
  );

  // Move profiles stored on a removed language (everything but en/es) to
  // English — the picker no longer offers those codes (ElevenLabs removal).
  // Idempotent single UPDATE; reads already default unknown codes to English,
  // so a failed run changes nothing user-visible.
  backfillLanguageSunset().catch((e) =>
    logger.error({ err: e }, "language sunset backfill failed — removed-code rows behave as English regardless; retry next boot"),
  );

  // Scrub EVI {expression} annotations from user messages persisted before
  // the live normalizer stripped them (see services/messageAnnotationScrub.ts
  // — decrypt-scan bounded by a fixed cutoff, rewrite only changed rows).
  scrubMessageAnnotations().catch((e) =>
    logger.error({ err: e }, "message annotation scrub failed — old rows keep their braces; retry next boot"),
  );

  // Move any remaining relationship_type='romantic' rows to 'friend' (the
  // romantic persona was retired). Idempotent single UPDATE; a failed run
  // changes nothing user-visible because the prompt no longer branches on it.
  migrateRomanticPersona().catch((e) =>
    logger.error({ err: e }, "romantic persona migration failed — rows behave as friend regardless; retry next boot"),
  );

  // Seed memory-fact importance columns (times_referenced, last_referenced_at,
  // emotional_weight) for facts that predate ranking. Idempotent — only touches
  // unseeded rows, so it's a no-op after the first successful pass. Runs while
  // serving; until it completes, unseeded facts just score on their defaults.
  backfillMemoryImportance().catch((e) =>
    logger.error({ err: e }, "memory importance backfill failed — unseeded facts score on defaults"),
  );

  // Bring every stored memory line under the cleaner's rules (memory audit,
  // item 2; services/memoryTextSweep.ts): one bounded, plain line each, and a
  // category among the ten. Idempotent and advisory-locked; a clean database
  // makes it a fast no-op. Background — nothing waits on it.
  runMemoryTextSweep().catch((e) =>
    logger.error({ err: e }, "memory text sweep failed — retried next boot; new rows are cleaned at write regardless"),
  );

  // One-time semantic-dedup sweep of legacy duplicate rows (memory_facts,
  // habits, commitments, goals). Gated behind DEDUP_BACKFILL_ON_BOOT=true so it
  // only runs on the deploy the operator opts into (per-user Haiku calls cost
  // money); idempotent and background — never blocks serving.
  runDedupBackfill().catch((e) =>
    logger.error({ err: e }, "dedup backfill failed — duplicates remain; safe to retry next boot"),
  );

  // Initialise romantic community voices (non-blocking — failures logged and skipped)
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (apiKey) {
    initVoiceLibrary(apiKey).catch((e) =>
      logger.error({ err: e }, "Unexpected error in initVoiceLibrary"),
    );
  } else {
    logger.warn("ELEVENLABS_API_KEY not set — skipping voice library init");
  }

  // Loud boot warning when only one of the two voice agents is configured —
  // routing safe-degrades per call, but ops should know immediately.
  warnIfAgentEnvIncomplete();

  // Enforce that the shared ElevenLabs agent config matches what THIS build
  // supports (July 2026 filler/skip_turn incident). No-ops outside production;
  // never throws.
  reconcileAgentConfig().catch((e) =>
    logger.error({ err: e }, "Unexpected error in agent config guard"),
  );
});
