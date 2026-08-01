import { hasValidDataKey } from "@workspace/db";
import app from "./app";
import { logger } from "./lib/logger";
import { initVoiceLibrary } from "./services/voiceLibrary";
import { reconcileAgentConfig } from "./services/agentConfigGuard";
import { runDataEncryptionMigration } from "./services/dataEncryptionMigration";
import { backfillVoiceGender } from "./services/settings/voiceGenderBackfill";
import { backfillMemoryImportance } from "./services/memory/backfill";
import { runDedupBackfill } from "./services/memory/dedupBackfill";
import { warnIfAgentEnvIncomplete } from "./services/voiceAgentRouting";

// User content is encrypted at rest — without the master key the app can
// neither read nor write it. Refuse to boot rather than serve a broken app.
// KEY LOSS = DATA LOSS: DATA_ENCRYPTION_KEY exists only as an environment
// secret; keep a secure offline backup of each environment's value.
if (!hasValidDataKey()) {
  logger.error(
    "FATAL: DATA_ENCRYPTION_KEY is missing or invalid (expected 32 bytes, base64). " +
      "Refusing to boot — stored user content is encrypted and unreadable without it. " +
      "Set the secret for this environment. NEVER rotate or delete it without a migration: " +
      "losing this key permanently destroys all encrypted user data.",
  );
  process.exit(1);
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

  // Seed memory-fact importance columns (times_referenced, last_referenced_at,
  // emotional_weight) for facts that predate ranking. Idempotent — only touches
  // unseeded rows, so it's a no-op after the first successful pass. Runs while
  // serving; until it completes, unseeded facts just score on their defaults.
  backfillMemoryImportance().catch((e) =>
    logger.error({ err: e }, "memory importance backfill failed — unseeded facts score on defaults"),
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
