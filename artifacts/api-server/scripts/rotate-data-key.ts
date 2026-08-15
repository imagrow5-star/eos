/**
 * One-off key rotation CLI: re-encrypt every encrypted column OLD key → NEW key.
 *
 * Usage:
 *   OLD_DATA_ENCRYPTION_KEY=<old base64> DATA_ENCRYPTION_KEY=<new base64> \
 *     pnpm exec tsx scripts/rotate-data-key.ts
 *
 * Why this exists: if a key is ever exposed (e.g. it landed in a tracked
 * config file), the exposed key must be treated as burned. All rotation
 * logic — and its safety contract (optimistic guards, verify-before-commit,
 * idempotence, loud aborts) — lives in src/services/dataKeyRotation.ts,
 * where it is exercised by the key-rotation test suite; this file only
 * parses env and wires the pool.
 */
import pg from "pg";
import { runKeyRotation } from "../src/services/dataKeyRotation";

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

async function main() {
  const oldKey = loadKey("OLD_DATA_ENCRYPTION_KEY");
  const newKey = loadKey("DATA_ENCRYPTION_KEY");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { total } = await runKeyRotation({
      pool,
      oldKey,
      newKey,
      log: (line) => console.log(line),
    });
    console.log(`done — ${total} rows re-encrypted under the new key`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("rotation failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
