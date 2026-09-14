/**
 * In-place encryption migration for pre-existing plaintext rows.
 *
 * Strategy (the "encrypt-alongside → verify → swap" equivalent, per batch):
 *   1. SELECT a batch of rows that still contain plaintext (detector-driven —
 *      `enc:v1:` prefix means done, so the job is idempotent and resumable
 *      after any crash; new writes are already encrypted by the ORM layer).
 *   2. Encrypt in memory.
 *   3. In ONE transaction: UPDATE each row with an optimistic guard
 *      (`AND col = <original>`) so a concurrent live write is never
 *      clobbered, SELECT the rows back, decrypt them, and compare against the
 *      originals held in memory. COMMIT only if every row round-trips
 *      byte-identically; otherwise ROLLBACK and abort loudly.
 *      → No original value is ever destroyed before its encrypted
 *        replacement has been decrypted and verified inside the same
 *        transaction.
 *
 * Safe to run while serving traffic: reads pass plaintext through untouched
 * (decrypt is a no-op on unprefixed values) and new writes are always
 * encrypted. An advisory lock keeps concurrent instances (autoscale) from
 * migrating simultaneously — losers skip and stay fully functional.
 *
 * Logs COUNTS ONLY — never row content.
 */
import {
  pool,
  encryptText,
  encryptJson,
  encryptTextArray,
  decryptText,
  decryptJson,
  decryptTextArray,
  isEncrypted,
} from "@workspace/db";
import { logger } from "../lib/logger";

type ColKind = "text" | "jsonb" | "textarray";
export type ColSpec = { name: string; kind: ColKind; aad: string };
export type TableSpec = { table: string; idCol: string; cols: ColSpec[] };

const BATCH_SIZE = 200;
const LOCK_KEY = "data-encryption-migration";

// Every sensitive column in the system. Must stay in lockstep with the
// encrypted* columns in the lib/db schema: `__tests__/encryption-registry.test.ts`
// compares this list against `ENCRYPTED_COLUMNS` (which the column
// constructors fill in as the schema loads) and fails on any column present
// in one and not the other. A column missing here is skipped by the
// key-rotation engine (services/dataKeyRotation.ts) and would be lost the day
// the old key is retired — that happened once, silently, to five columns.
export const SPECS: TableSpec[] = [
  { table: "messages", idCol: "id", cols: [{ name: "content", kind: "text", aad: "messages.content" }] },
  {
    table: "memory_facts",
    idCol: "id",
    cols: [
      { name: "fact", kind: "text", aad: "memory_facts.fact" },
      // The wording a fact had before the conversation updated it (nullable).
      { name: "previous_fact", kind: "text", aad: "memory_facts.previous_fact" },
    ],
  },
  // memory_feelings shipped after the encryption rollout, so it has no
  // plaintext legacy rows — it is listed so the ROTATION script (which
  // iterates these SPECS) covers it, and as the registry of encrypted columns.
  {
    table: "memory_feelings",
    idCol: "id",
    cols: [
      { name: "feeling", kind: "text", aad: "memory_feelings.feeling" },
      // The emotion category was plaintext beside the encrypted feeling text
      // (security review): "shame" next to ciphertext still says a lot.
      { name: "category", kind: "text", aad: "memory_feelings.category" },
    ],
  },
  // Reminders: the person's own words (security review).
  { table: "reminders", idCol: "id", cols: [{ name: "content", kind: "text", aad: "reminders.content" }] },
  // Landing-page "Ask the founder" messages: a stranger's worry, in their words
  // (security review). No user_id — keyed by the row id.
  { table: "leads", idCol: "id", cols: [{ name: "message", kind: "text", aad: "leads.message" }] },
  // Crisis floor event log: the pattern name, the country served, the channel
  // and the dismissal flag are all encrypted (security review). Only the two
  // timestamps stay plaintext — the rolling windows filter on them in SQL;
  // everything else is filtered in JS (services/crisis/events.ts).
  {
    table: "crisis_events",
    idCol: "id",
    cols: [
      { name: "pattern_matched", kind: "text", aad: "crisis_events.pattern_matched" },
      { name: "country_served", kind: "text", aad: "crisis_events.country_served" },
      { name: "source", kind: "text", aad: "crisis_events.source" },
      // boolean → text by ensureColumnTypes(); plaintext "true"/"false" until encrypted.
      { name: "block_dismissed", kind: "text", aad: "crisis_events.block_dismissed" },
    ],
  },
  // The mood timeline: integer → text by ensureColumnTypes(); digit strings
  // until encrypted. Never aggregated in SQL.
  { table: "mood_scores", idCol: "id", cols: [{ name: "score", kind: "text", aad: "mood_scores.score" }] },
  { table: "personality_signals", idCol: "id", cols: [{ name: "signal", kind: "text", aad: "personality_signals.signal" }] },
  { table: "wins", idCol: "id", cols: [{ name: "content", kind: "text", aad: "wins.content" }] },
  {
    table: "sealed_notes",
    idCol: "id",
    cols: [
      { name: "prompt", kind: "text", aad: "sealed_notes.prompt" },
      { name: "text", kind: "text", aad: "sealed_notes.text" },
      // Encrypted boolean flag: the column is converted boolean→text by
      // ensureColumnTypes() below BEFORE this sweep runs, so the
      // detector sees plaintext "true"/"false" strings and encrypts them
      // like any other text value.
      { name: "crisis_flagged", kind: "text", aad: "sealed_notes.crisis_flagged" },
    ],
  },
  // ── Conversation-derived planning tables (review finding) ─────────────────
  // Free text extracted verbatim from conversations. Enum/date/counter
  // columns (state, scheduled_*, is_complete, streak, "order") stay plaintext
  // on purpose — SQL filters and sorts on them.
  {
    table: "commitments",
    idCol: "id",
    cols: [
      { name: "content", kind: "text", aad: "commitments.content" },
      { name: "cue", kind: "text", aad: "commitments.cue" },
      { name: "quality_note", kind: "text", aad: "commitments.quality_note" },
    ],
  },
  {
    table: "goals",
    idCol: "id",
    cols: [
      { name: "title", kind: "text", aad: "goals.title" },
      { name: "description", kind: "text", aad: "goals.description" },
    ],
  },
  { table: "goal_tasks", idCol: "id", cols: [{ name: "content", kind: "text", aad: "goal_tasks.content" }] },
  {
    table: "habits",
    idCol: "id",
    cols: [
      { name: "name", kind: "text", aad: "habits.name" },
      { name: "when_then", kind: "text", aad: "habits.when_then" },
      { name: "reason", kind: "text", aad: "habits.reason" },
    ],
  },
  {
    table: "weekly_chapters",
    idCol: "id",
    cols: [
      { name: "thread_opening", kind: "text", aad: "weekly_chapters.thread_opening" },
      { name: "threshold_question", kind: "text", aad: "weekly_chapters.threshold_question" },
      { name: "threshold_answer", kind: "text", aad: "weekly_chapters.threshold_answer" },
      // integer → text by ensureColumnTypes(); digit strings until encrypted.
      { name: "threshold_mood", kind: "text", aad: "weekly_chapters.threshold_mood" },
      { name: "threshold_loneliness", kind: "text", aad: "weekly_chapters.threshold_loneliness" },
      { name: "themes", kind: "jsonb", aad: "weekly_chapters.themes" },
      { name: "goal_review", kind: "jsonb", aad: "weekly_chapters.goal_review" },
      { name: "micro_offer", kind: "jsonb", aad: "weekly_chapters.micro_offer" },
      { name: "note_invite", kind: "jsonb", aad: "weekly_chapters.note_invite" },
      { name: "seal_resolution", kind: "jsonb", aad: "weekly_chapters.seal_resolution" },
      { name: "working_through", kind: "jsonb", aad: "weekly_chapters.working_through" },
    ],
  },
  {
    table: "story_threads",
    idCol: "id",
    cols: [
      // The label names the thing they keep returning to (security review).
      { name: "label", kind: "text", aad: "story_threads.label" },
      { name: "retellings", kind: "jsonb", aad: "story_threads.retellings" },
    ],
  },
  // Stories (the Journey markers): the circle fragment and the card JSON are
  // the person's own words. story_drops keeps every card a gate refused.
  {
    table: "stories",
    idCol: "id",
    cols: [
      { name: "fragment", kind: "text", aad: "stories.fragment" },
      { name: "cards", kind: "text", aad: "stories.cards" },
    ],
  },
  { table: "story_drops", idCol: "id", cols: [{ name: "text", kind: "text", aad: "story_drops.text" }] },
  // The finished reflection report (Markdown built from the export payload).
  { table: "reflection_reports", idCol: "id", cols: [{ name: "content", kind: "text", aad: "reflection_reports.content" }] },
  {
    table: "personalization_state",
    idCol: "user_id",
    cols: [{ name: "recent_phrases", kind: "textarray", aad: "personalization_state.recent_phrases" }],
  },
  {
    table: "profile",
    idCol: "id",
    cols: [
      { name: "user_name", kind: "text", aad: "profile.user_name" },
      { name: "original_user_name", kind: "text", aad: "profile.original_user_name" },
      { name: "user_gender_custom", kind: "text", aad: "profile.user_gender_custom" },
    ],
  },
];

function plaintextPredicate(c: ColSpec): string {
  switch (c.kind) {
    case "text":
      return `("${c.name}" IS NOT NULL AND "${c.name}" NOT LIKE 'enc:v1:%')`;
    case "jsonb":
      // Encrypted form is a jsonb *string scalar* with our prefix; anything
      // else (object/array/number/other string) is legacy plaintext.
      return `("${c.name}" IS NOT NULL AND (jsonb_typeof("${c.name}") <> 'string' OR ("${c.name}" #>> '{}') NOT LIKE 'enc:v1:%'))`;
    case "textarray":
      return `("${c.name}" IS NOT NULL AND EXISTS (SELECT 1 FROM unnest("${c.name}") AS __el WHERE __el NOT LIKE 'enc:v1:%'))`;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, (b as unknown[])[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

export type MigrationCounts = Record<string, { migrated: number; skippedConcurrent: number }>;

/**
 * One-time column-type conversions (boolean/integer → text) so a value can be
 * encrypted like any other text value. Idempotent: each guard checks
 * information_schema and does nothing once the column is already text.
 * Values survive as plaintext strings (the ::text cast), which the sweep
 * right after encrypts and reads pass through until then — no row is ever
 * nulled or dropped. Runs under the migration's advisory lock, so concurrent
 * instances can't both rewrite a table. Fresh databases skip this entirely:
 * drizzle-kit push creates the columns as text from the schema definition.
 */
export const COLUMN_TYPE_CONVERSIONS: ReadonlyArray<{
  table: string;
  column: string;
  fromType: "boolean" | "integer";
  /** Re-applied after the cast, as a text literal; omitted = no default. */
  defaultText?: string;
}> = [
  { table: "sealed_notes", column: "crisis_flagged", fromType: "boolean", defaultText: "false" },
  // Security review: the mood timeline, the weekly slider answers, and the
  // crisis-event shape (country, channel, dismissal) were plaintext.
  { table: "mood_scores", column: "score", fromType: "integer" },
  { table: "weekly_chapters", column: "threshold_mood", fromType: "integer" },
  { table: "weekly_chapters", column: "threshold_loneliness", fromType: "integer" },
  { table: "crisis_events", column: "block_dismissed", fromType: "boolean", defaultText: "false" },
];

async function ensureColumnTypes(client: { query: (text: string) => Promise<unknown> }): Promise<void> {
  for (const c of COLUMN_TYPE_CONVERSIONS) {
    // Identifiers come from the static list above, never from input.
    const setDefault = c.defaultText !== undefined
      ? `ALTER TABLE ${c.table} ALTER COLUMN ${c.column} SET DEFAULT '${c.defaultText}';`
      : "";
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = '${c.table}'
            AND column_name = '${c.column}'
            AND data_type = '${c.fromType}'
        ) THEN
          ALTER TABLE ${c.table} ALTER COLUMN ${c.column} DROP DEFAULT;
          ALTER TABLE ${c.table} ALTER COLUMN ${c.column} TYPE text USING ${c.column}::text;
          ${setDefault}
        END IF;
      END $$;
    `);
  }
}

async function migrateTable(spec: TableSpec): Promise<{ migrated: number; skippedConcurrent: number }> {
  const colList = spec.cols.map((c) => `"${c.name}"`).join(", ");
  const anyPlain = spec.cols.map(plaintextPredicate).join(" OR ");
  let migrated = 0;
  let skippedConcurrent = 0;

  for (;;) {
    const { rows } = await pool.query(
      `SELECT "${spec.idCol}" AS __id, ${colList} FROM "${spec.table}" WHERE ${anyPlain} ORDER BY "${spec.idCol}" LIMIT ${BATCH_SIZE}`,
    );
    if (rows.length === 0) break;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const verifyTargets: Array<{ id: unknown; originals: Record<string, unknown> }> = [];

      for (const row of rows) {
        const sets: string[] = [];
        const params: unknown[] = [];
        const guards: string[] = [];

        for (const c of spec.cols) {
          const orig = row[c.name];
          if (orig === null || orig === undefined) continue;
          if (c.kind === "text") {
            if (isEncrypted(orig)) continue; // this column already done for this row
            params.push(encryptText(orig as string, c.aad));
            sets.push(`"${c.name}" = $${params.length}`);
            params.push(orig);
            guards.push(`"${c.name}" = $${params.length}`);
          } else if (c.kind === "jsonb") {
            if (typeof orig === "string" && isEncrypted(orig)) continue;
            params.push(JSON.stringify(encryptJson(orig, c.aad)));
            sets.push(`"${c.name}" = $${params.length}::jsonb`);
            params.push(JSON.stringify(orig));
            guards.push(`"${c.name}" = $${params.length}::jsonb`);
          } else {
            const arr = orig as string[];
            if (arr.every((el) => isEncrypted(el))) continue;
            params.push(encryptTextArray(arr, c.aad));
            sets.push(`"${c.name}" = $${params.length}`);
            params.push(arr);
            guards.push(`"${c.name}" = $${params.length}`);
          }
        }
        if (sets.length === 0) continue;

        params.push(row.__id);
        const res = await client.query(
          `UPDATE "${spec.table}" SET ${sets.join(", ")} WHERE "${spec.idCol}" = $${params.length} AND ${guards.join(" AND ")}`,
          params,
        );
        if (res.rowCount === 1) {
          verifyTargets.push({ id: row.__id, originals: row });
        } else {
          // A live write changed this row between our SELECT and UPDATE.
          // Skip it — the app already writes encrypted, and if it is somehow
          // still plaintext the next detector pass picks it up.
          skippedConcurrent += 1;
        }
      }

      // Verification pass: decrypt every row we just rewrote and confirm it
      // matches the original BEFORE committing (i.e. before any plaintext
      // original is truly gone).
      if (verifyTargets.length > 0) {
        const ids = verifyTargets.map((v) => v.id);
        const { rows: after } = await client.query(
          `SELECT "${spec.idCol}" AS __id, ${colList} FROM "${spec.table}" WHERE "${spec.idCol}" = ANY($1)`,
          [ids],
        );
        const byId = new Map(after.map((r) => [String(r.__id), r]));
        for (const target of verifyTargets) {
          const now = byId.get(String(target.id));
          if (!now) throw new Error(`verification row vanished (${spec.table})`);
          for (const c of spec.cols) {
            const orig = target.originals[c.name];
            if (orig === null || orig === undefined) continue;
            // Only verify what this pass rewrote. A column that was already
            // ciphertext in the original (a table where one column was
            // encrypted in an earlier release and another only now) was
            // skipped above, and its original is not plaintext to compare to.
            if (c.kind === "text" && isEncrypted(orig)) continue;
            if (c.kind === "jsonb" && typeof orig === "string" && isEncrypted(orig)) continue;
            if (c.kind === "textarray" && Array.isArray(orig) && (orig as string[]).every((el) => isEncrypted(el))) continue;
            let ok: boolean;
            if (c.kind === "text") {
              ok = decryptText(now[c.name] as string, c.aad) === orig;
            } else if (c.kind === "jsonb") {
              ok = deepEqual(decryptJson(now[c.name], c.aad), orig);
            } else {
              const dec = decryptTextArray(now[c.name] as string[], c.aad);
              const origArr = orig as string[];
              ok = dec.length === origArr.length && dec.every((v, i) => v === origArr[i]);
            }
            if (!ok) {
              throw new Error(
                `verification mismatch in ${spec.table}.${c.name} — rolling back batch, aborting migration`,
              );
            }
          }
        }
      }

      await client.query("COMMIT");
      migrated += verifyTargets.length;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // If everything left in the detector was skipped-concurrent we could spin;
    // break when a full pass produced no work.
    if (rows.length < BATCH_SIZE && migrated === 0 && skippedConcurrent > 0) break;
  }

  return { migrated, skippedConcurrent };
}

/**
 * Run the full migration under an advisory lock. Returns per-table counts
 * (also used by tests). Never logs content — counts and timings only.
 */
export async function runDataEncryptionMigration(): Promise<MigrationCounts | null> {
  const started = Date.now();
  const lockClient = await pool.connect();
  try {
    const { rows } = await lockClient.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [LOCK_KEY],
    );
    if (!rows[0]?.locked) {
      logger.info("data-encryption migration: another instance holds the lock — skipping");
      return null;
    }
    try {
      // Column-shape prerequisite first (idempotent, guarded, same lock).
      await ensureColumnTypes(lockClient);
      const counts: MigrationCounts = {};
      for (const spec of SPECS) {
        counts[spec.table] = await migrateTable(spec);
      }
      const total = Object.values(counts).reduce((s, c) => s + c.migrated, 0);
      logger.info(
        { counts, totalMigrated: total, ms: Date.now() - started },
        "data-encryption migration complete",
      );
      return counts;
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [LOCK_KEY]);
    }
  } finally {
    lockClient.release();
  }
}
