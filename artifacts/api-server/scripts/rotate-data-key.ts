/**
 * One-off key rotation: re-encrypt every encrypted column from OLD key → NEW key.
 *
 * Usage:
 *   OLD_DATA_ENCRYPTION_KEY=<old base64> DATA_ENCRYPTION_KEY=<new base64> \
 *     pnpm exec tsx scripts/rotate-data-key.ts
 *
 * Why this exists: if a key is ever exposed (e.g. it landed in a tracked
 * config file), the exposed key must be treated as burned. This script
 * decrypts each row with the OLD key and re-encrypts with the NEW one, with
 * the same safety contract as the boot migration:
 *   - per-row optimistic guard (WHERE col = <old ciphertext>) so concurrent
 *     live writes are never clobbered
 *   - same-transaction SELECT-back + decrypt-with-NEW + compare against the
 *     OLD-key plaintext; COMMIT only if every row matches
 *   - idempotent/resumable: rows already decryptable with NEW are skipped
 *   - logs counts only, never content, never key material
 *
 * Rows that fail to decrypt with BOTH keys abort the run loudly.
 * Plaintext rows (pre-encryption stragglers) are left untouched — the boot
 * migration under the NEW key handles them.
 */
import crypto from "node:crypto";
import pg from "pg";
import { SPECS, type ColSpec } from "../src/services/dataEncryptionMigration";

const PREFIX = "enc:v1:";
const IV_LEN = 12;
const TAG_LEN = 16;

function loadKey(name: string): Buffer {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required`);
  // Accept both encodings of 32 random bytes: 64 hex chars (openssl rand
  // -hex 32) or standard base64 (openssl rand -base64 32). Hex must be
  // tested first — a hex string is base64-decodable, but to the wrong length.
  const t = raw.trim().replace(/^["']|["']$/g, "");
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, "hex");
  const key = Buffer.from(t, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes (base64 or 64 hex chars)`);
  return key;
}

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

const OLD_KEY = loadKey("OLD_DATA_ENCRYPTION_KEY");
const NEW_KEY = loadKey("DATA_ENCRYPTION_KEY");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const BATCH = 200;

/** Rotate one encrypted string value; returns null if it needs no rotation. */
function rotateValue(value: string, aad: string): string | null {
  if (!value.startsWith(PREFIX)) return null; // plaintext straggler — boot migration's job
  try {
    decryptWith(NEW_KEY, value, aad);
    return null; // already on the new key
  } catch {
    /* fall through to old key */
  }
  const plaintext = decryptWith(OLD_KEY, value, aad); // throws loudly if neither key works
  return encryptWith(NEW_KEY, plaintext, aad);
}

function rotateColumnValue(kind: ColSpec["kind"], v: unknown, aad: string): unknown | null {
  if (v === null || v === undefined) return null;
  if (kind === "text") return rotateValue(v as string, aad);
  if (kind === "jsonb") {
    if (typeof v !== "string") return null; // legacy plaintext jsonb
    const rotated = rotateValue(v, aad);
    return rotated === null ? null : JSON.stringify(rotated);
  }
  const arr = v as string[];
  const rotated = arr.map((el) => rotateValue(el, aad) ?? el);
  return rotated.some((el, i) => el !== arr[i]) ? rotated : null;
}

async function main() {
  let total = 0;
  for (const spec of SPECS) {
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
            const next = rotateColumnValue(c.kind, row[c.name], c.aad);
            if (next === null) continue;
            params.push(next);
            sets.push(`"${c.name}" = $${params.length}${c.kind === "jsonb" ? "::jsonb" : ""}`);
            if (c.kind === "jsonb") {
              params.push(JSON.stringify(row[c.name]));
              guards.push(`"${c.name}" = $${params.length}::jsonb`);
              expected.push({ col: c, plaintext: decryptWith(OLD_KEY, row[c.name] as string, c.aad) });
            } else if (c.kind === "text") {
              params.push(row[c.name]);
              guards.push(`"${c.name}" = $${params.length}`);
              expected.push({ col: c, plaintext: decryptWith(OLD_KEY, row[c.name] as string, c.aad) });
            } else {
              params.push(row[c.name]);
              guards.push(`"${c.name}" = $${params.length}`);
              expected.push({
                col: c,
                plaintext: (row[c.name] as string[]).map((el) =>
                  el.startsWith(PREFIX) ? decryptWith(OLD_KEY, el, c.aad) : el,
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
                el.startsWith(PREFIX) ? decryptWith(NEW_KEY, el, col.aad) : el,
              );
              const exp = plaintext as string[];
              if (dec.length !== exp.length || dec.some((v, i) => v !== exp[i])) {
                throw new Error(`verify mismatch ${spec.table}.${col.name} — rolled back`);
              }
            } else {
              const stored = col.kind === "jsonb" ? (now as string) : (now as string);
              if (decryptWith(NEW_KEY, stored, col.aad) !== plaintext) {
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
    total += rotated;
    console.log(`${spec.table}: rotated ${rotated}`);
  }
  console.log(`done — ${total} rows re-encrypted under the new key`);
  await pool.end();
}

main().catch((err) => {
  console.error("rotation failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
