/**
 * Key rotation engine: re-encrypt every encrypted column OLD key → NEW key.
 *
 * Extracted from scripts/rotate-data-key.ts so the safety contract is
 * testable against a real database (see __tests__/key-rotation.test.ts);
 * the script is now a thin CLI wrapper around runKeyRotation().
 *
 * Safety contract (same as the boot encryption migration):
 *   - per-row optimistic guard (WHERE col = <old ciphertext>) so concurrent
 *     live writes are never clobbered
 *   - same-transaction SELECT-back + decrypt-with-NEW + compare against the
 *     OLD-key plaintext; COMMIT only if every row matches
 *   - idempotent/resumable: rows already decryptable with NEW are skipped
 *   - plaintext rows (pre-encryption stragglers) are left untouched — the
 *     boot migration under the NEW key handles them
 *   - rows that decrypt with NEITHER key abort the run loudly
 *   - logs counts only, never content, never key material
 *
 * Keys are explicit parameters — the engine never touches the process-global
 * key cache, so it can rotate between arbitrary keys regardless of what the
 * running app is configured with.
 */
import crypto from "node:crypto";
import type pg from "pg";
import { SPECS, type ColSpec, type TableSpec } from "./dataEncryptionMigration";

const PREFIX = "enc:v1:";
const IV_LEN = 12;
const TAG_LEN = 16;
const BATCH = 200;

function encryptWith(key: Buffer, plaintext: string, aad: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function decryptWith(key: Buffer, value: string, aad: string): string {
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Rotate one encrypted string value; returns null if it needs no rotation. */
function rotateValue(oldKey: Buffer, newKey: Buffer, value: string, aad: string): string | null {
  if (!value.startsWith(PREFIX)) return null; // plaintext straggler — boot migration's job
  try {
    decryptWith(newKey, value, aad);
    return null; // already on the new key
  } catch {
    /* fall through to old key */
  }
  const plaintext = decryptWith(oldKey, value, aad); // throws loudly if neither key works
  return encryptWith(newKey, plaintext, aad);
}

function rotateColumnValue(
  oldKey: Buffer,
  newKey: Buffer,
  kind: ColSpec["kind"],
  v: unknown,
  aad: string,
): unknown | null {
  if (v === null || v === undefined) return null;
  if (kind === "text") return rotateValue(oldKey, newKey, v as string, aad);
  if (kind === "jsonb") {
    if (typeof v !== "string") return null; // legacy plaintext jsonb
    const rotated = rotateValue(oldKey, newKey, v, aad);
    return rotated === null ? null : JSON.stringify(rotated);
  }
  const arr = v as string[];
  const rotated = arr.map((el) => rotateValue(oldKey, newKey, el, aad) ?? el);
  return rotated.some((el, i) => el !== arr[i]) ? rotated : null;
}

export type RotationCounts = Record<string, number>;

export async function runKeyRotation(opts: {
  pool: pg.Pool;
  oldKey: Buffer;
  newKey: Buffer;
  specs?: TableSpec[];
  log?: (line: string) => void;
}): Promise<{ counts: RotationCounts; total: number }> {
  const { pool, oldKey, newKey } = opts;
  const specs = opts.specs ?? SPECS;
  const log = opts.log ?? (() => {});
  const counts: RotationCounts = {};
  let total = 0;

  for (const spec of specs) {
    const colList = spec.cols.map((c) => `"${c.name}"`).join(", ");
    let rotated = 0;
    let offsetId: unknown = null;

    for (;;) {
      const { rows } = await pool.query(
        `SELECT "${spec.idCol}" AS __id, ${colList} FROM "${spec.table}"
         ${offsetId === null ? "" : `WHERE "${spec.idCol}" > $1`}
         ORDER BY "${spec.idCol}" LIMIT ${BATCH}`,
        offsetId === null ? [] : [offsetId],
      );
      if (rows.length === 0) break;
      offsetId = rows[rows.length - 1].__id;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const row of rows) {
          const sets: string[] = [];
          const params: unknown[] = [];
          const guards: string[] = [];
          const expected: Array<{ col: ColSpec; plaintext: string | string[] }> = [];

          for (const c of spec.cols) {
            const next = rotateColumnValue(oldKey, newKey, c.kind, row[c.name], c.aad);
            if (next === null) continue;
            params.push(next);
            sets.push(`"${c.name}" = $${params.length}${c.kind === "jsonb" ? "::jsonb" : ""}`);
            if (c.kind === "jsonb") {
              params.push(JSON.stringify(row[c.name]));
              guards.push(`"${c.name}" = $${params.length}::jsonb`);
              expected.push({ col: c, plaintext: decryptWith(oldKey, row[c.name] as string, c.aad) });
            } else if (c.kind === "text") {
              params.push(row[c.name]);
              guards.push(`"${c.name}" = $${params.length}`);
              expected.push({ col: c, plaintext: decryptWith(oldKey, row[c.name] as string, c.aad) });
            } else {
              params.push(row[c.name]);
              guards.push(`"${c.name}" = $${params.length}`);
              expected.push({
                col: c,
                plaintext: (row[c.name] as string[]).map((el) =>
                  el.startsWith(PREFIX) ? decryptWith(oldKey, el, c.aad) : el,
                ),
              });
            }
          }
          if (sets.length === 0) continue;

          params.push(row.__id);
          const res = await client.query(
            `UPDATE "${spec.table}" SET ${sets.join(", ")} WHERE "${spec.idCol}" = $${params.length} AND ${guards.join(" AND ")}`,
            params,
          );
          if (res.rowCount !== 1) continue; // concurrent write — next pass will catch it

          // verify inside the txn: NEW-key decrypt must equal OLD-key plaintext
          const { rows: after } = await client.query(
            `SELECT ${colList} FROM "${spec.table}" WHERE "${spec.idCol}" = $1`,
            [row.__id],
          );
          for (const { col, plaintext } of expected) {
            const now = after[0][col.name];
            if (col.kind === "textarray") {
              const dec = (now as string[]).map((el) =>
                el.startsWith(PREFIX) ? decryptWith(newKey, el, col.aad) : el,
              );
              const exp = plaintext as string[];
              if (dec.length !== exp.length || dec.some((v, i) => v !== exp[i])) {
                throw new Error(`verify mismatch ${spec.table}.${col.name} — rolled back`);
              }
            } else {
              if (decryptWith(newKey, now as string, col.aad) !== plaintext) {
                throw new Error(`verify mismatch ${spec.table}.${col.name} — rolled back`);
              }
            }
          }
          rotated += 1;
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
    counts[spec.table] = rotated;
    total += rotated;
    log(`${spec.table}: rotated ${rotated}`);
  }
  return { counts, total };
}
