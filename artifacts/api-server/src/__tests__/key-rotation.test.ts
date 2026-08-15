/**
 * A2 — key rotation engine (services/dataKeyRotation.ts).
 *
 * Proves the rotation safety contract against a REAL database:
 *   • every kind (text / jsonb / textarray) re-encrypts OLD → NEW and the
 *     result decrypts ONLY under the new key
 *   • plaintext stragglers and plaintext array elements are left untouched
 *   • a second run is a no-op (idempotent / resumable)
 *   • a value encrypted under NEITHER key aborts the run loudly, and the
 *     transaction rolls back — no partial batch survives
 *
 * Runs entirely on a scratch table (via the engine's `specs` parameter):
 * rotating the real shared tables would re-key rows other test files expect
 * to read under the suite's env key.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import pg from "pg";
import { runKeyRotation } from "../services/dataKeyRotation.js";
import type { TableSpec } from "../services/dataEncryptionMigration.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const OLD_KEY = crypto.randomBytes(32);
const NEW_KEY = crypto.randomBytes(32);
const OTHER_KEY = crypto.randomBytes(32);

const PREFIX = "enc:v1:";

function encryptWith(key: Buffer, plaintext: string, aad: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

function decryptWith(key: Buffer, value: string, aad: string): string {
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

const TABLE = "key_rotation_scratch";
const SPECS_SCRATCH: TableSpec[] = [
  {
    table: TABLE,
    idCol: "id",
    cols: [
      { name: "content", kind: "text", aad: `${TABLE}.content` },
      { name: "payload", kind: "jsonb", aad: `${TABLE}.payload` },
      { name: "items", kind: "textarray", aad: `${TABLE}.items` },
    ],
  },
];

beforeAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await pool.query(`
    CREATE TABLE ${TABLE} (
      id serial PRIMARY KEY,
      content text,
      payload jsonb,
      items text[]
    )
  `);
});

afterAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await pool.end();
});

describe("runKeyRotation", () => {
  it("re-encrypts text/jsonb/textarray under the new key, skips plaintext, is idempotent", async () => {
    const aadText = `${TABLE}.content`;
    const aadJson = `${TABLE}.payload`;
    const aadArr = `${TABLE}.items`;

    // Row 1: fully encrypted under OLD across all kinds (jsonb is a JSON
    // string scalar whose value is the encrypted JSON payload — same shape
    // encryptJson produces).
    const jsonPlain = JSON.stringify({ mood: "steady", note: "rotation test" });
    await pool.query(
      `INSERT INTO ${TABLE} (content, payload, items) VALUES ($1, $2::jsonb, $3)`,
      [
        encryptWith(OLD_KEY, "the quick brown fox", aadText),
        JSON.stringify(encryptWith(OLD_KEY, jsonPlain, aadJson)),
        [encryptWith(OLD_KEY, "first", aadArr), "plain-element", encryptWith(OLD_KEY, "third", aadArr)],
      ],
    );
    // Row 2: plaintext straggler — rotation must not touch it.
    await pool.query(`INSERT INTO ${TABLE} (content) VALUES ($1)`, ["never encrypted"]);
    // Row 3: nulls everywhere — must be ignored.
    await pool.query(`INSERT INTO ${TABLE} (content) VALUES (NULL)`);

    const first = await runKeyRotation({ pool, oldKey: OLD_KEY, newKey: NEW_KEY, specs: SPECS_SCRATCH });
    expect(first.counts[TABLE]).toBe(1); // only row 1 had anything to rotate
    expect(first.total).toBe(1);

    const { rows } = await pool.query(`SELECT * FROM ${TABLE} ORDER BY id ASC`);

    // Row 1: decrypts under NEW, refuses under OLD.
    expect(decryptWith(NEW_KEY, rows[0].content, aadText)).toBe("the quick brown fox");
    expect(() => decryptWith(OLD_KEY, rows[0].content, aadText)).toThrow();
    expect(decryptWith(NEW_KEY, rows[0].payload, aadJson)).toBe(jsonPlain);
    expect(decryptWith(NEW_KEY, rows[0].items[0], aadArr)).toBe("first");
    expect(rows[0].items[1]).toBe("plain-element"); // plaintext element untouched
    expect(decryptWith(NEW_KEY, rows[0].items[2], aadArr)).toBe("third");

    // Row 2 and 3 untouched.
    expect(rows[1].content).toBe("never encrypted");
    expect(rows[2].content).toBeNull();

    // Second run: nothing left to rotate.
    const second = await runKeyRotation({ pool, oldKey: OLD_KEY, newKey: NEW_KEY, specs: SPECS_SCRATCH });
    expect(second.total).toBe(0);
  });

  it("aborts loudly (and rolls back) on a value encrypted under neither key", async () => {
    await pool.query(`DELETE FROM ${TABLE}`);
    await pool.query(`INSERT INTO ${TABLE} (content) VALUES ($1)`, [
      encryptWith(OLD_KEY, "rotatable", `${TABLE}.content`),
    ]);
    await pool.query(`INSERT INTO ${TABLE} (content) VALUES ($1)`, [
      encryptWith(OTHER_KEY, "orphaned ciphertext", `${TABLE}.content`),
    ]);

    await expect(
      runKeyRotation({ pool, oldKey: OLD_KEY, newKey: NEW_KEY, specs: SPECS_SCRATCH }),
    ).rejects.toThrow();

    // The batch rolled back: the rotatable row is STILL under the old key —
    // no partial rotation survived the abort.
    const { rows } = await pool.query(`SELECT content FROM ${TABLE} ORDER BY id ASC`);
    expect(decryptWith(OLD_KEY, rows[0].content, `${TABLE}.content`)).toBe("rotatable");
  });
});
