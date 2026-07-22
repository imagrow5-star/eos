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
// encryptedText/encryptedJsonb/encryptedTextArray columns in lib/db schema.
// Exported for the key-rotation script (scripts/rotate-data-key.ts).
export const SPECS: TableSpec[] = [
  { table: "messages", idCol: "id", cols: [{ name: "content", kind: "text", aad: "messages.content" }] },
  { table: "memory_facts", idCol: "id", cols: [{ name: "fact", kind: "text", aad: "memory_facts.fact" }] },
  { table: "personality_signals", idCol: "id", cols: [{ name: "signal", kind: "text", aad: "personality_signals.signal" }] },
  { table: "wins", idCol: "id", cols: [{ name: "content", kind: "text", aad: "wins.content" }] },
  {
    table: "sealed_notes",
    idCol: "id",
    cols: [
      { name: "prompt", kind: "text", aad: "sealed_notes.prompt" },
      { name: "text", kind: "text", aad: "sealed_notes.text" },
    ],
  },
  {
    table: "weekly_chapters",
    idCol: "id",
    cols: [
      { name: "thread_opening", kind: "text", aad: "weekly_chapters.thread_opening" },
      { name: "threshold_question", kind: "text", aad: "weekly_chapters.threshold_question" },
      { name: "threshold_answer", kind: "text", aad: "weekly_chapters.threshold_answer" },
      { name: "themes", kind: "jsonb", aad: "weekly_chapters.themes" },
      { name: "goal_review", kind: "jsonb", aad: "weekly_chapters.goal_review" },
      { name: "micro_offer", kind: "jsonb", aad: "weekly_chapters.micro_offer" },
      { name: "note_invite", kind: "jsonb", aad: "weekly_chapters.note_invite" },
      { name: "seal_resolution", kind: "jsonb", aad: "weekly_chapters.seal_resolution" },
      { name: "working_through", kind: "jsonb", aad: "weekly_chapters.working_through" },
    ],
  },
  { table: "story_threads", idCol: "id", cols: [{ name: "retellings", kind: "jsonb", aad: "story_threads.retellings" }] },
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
