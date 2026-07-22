/**
 * Application-level encryption at rest for sensitive user content.
 *
 * ─── Pattern: AES-256-GCM directly under a single master key ─────────────────
 * Every sensitive value is encrypted with AES-256-GCM using a fresh random
 * 96-bit IV and an AAD that binds the ciphertext to its table+column, then
 * stored as `enc:v1:<base64(iv ‖ tag ‖ ciphertext)>` in the SAME column
 * (text stays text, jsonb holds a JSON string scalar, text[] is element-wise).
 *
 * Why NOT per-row data keys (classic envelope): wrapping a per-row DEK under a
 * KEK only adds a real security boundary when the KEK lives elsewhere (a KMS
 * that never releases it). Here both would sit in the same process memory and
 * come from the same env var, so per-row DEKs would double the crypto work and
 * row size while an attacker with DB access gains nothing either way — they
 * never see any key. Rotation stays possible: the `enc:v1:` version prefix
 * lets a future v2 key re-encrypt rows with the same verify-before-commit
 * migration used for the initial rollout.
 *
 * ─── Invariants ───────────────────────────────────────────────────────────────
 * - decrypt of a NON-prefixed value returns it unchanged (plaintext
 *   passthrough) — this is what makes the live migration safe.
 * - decrypt of a prefixed value NEVER falls back to returning ciphertext: a
 *   GCM auth failure (wrong key / corrupted row) throws loudly.
 * - null/undefined are never encrypted; column nullability is unchanged.
 *
 * ─── KEY LOSS = DATA LOSS ────────────────────────────────────────────────────
 * The master key lives ONLY in the DATA_ENCRYPTION_KEY environment secret
 * (32 bytes, base64). It is never written to the database or the repo.
 * If this key is lost, every encrypted row becomes permanently unreadable —
 * there is no recovery path. The founder must keep a secure offline backup
 * of the key value for each environment.
 */
import crypto from "node:crypto";

const PREFIX = "enc:v1:";
const ALG = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

export class DataEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataEncryptionError";
  }
}

// undefined = not resolved yet; null = resolved, no key present
let cachedKey: Buffer | null | undefined;

/** Resolve and cache the master key. Returns null when the env var is absent. */
export function loadDataKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw || raw.trim() === "") {
    cachedKey = null;
    return null;
  }
  const buf = Buffer.from(raw.trim(), "base64");
  if (buf.length !== 32) {
    throw new DataEncryptionError(
      `DATA_ENCRYPTION_KEY must be 32 bytes of base64 (got ${buf.length} bytes after decode)`,
    );
  }
  cachedKey = buf;
  return buf;
}

export function hasValidDataKey(): boolean {
  try {
    return loadDataKey() !== null;
  } catch {
    return false;
  }
}

function requireKey(): Buffer {
  const key = loadDataKey();
  if (!key) {
    throw new DataEncryptionError(
      "DATA_ENCRYPTION_KEY is not set — refusing to read or write encrypted user data. " +
        "This key is the ONLY way to decrypt stored content; losing it means losing the data.",
    );
  }
  return key;
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptText(plaintext: string, aad: string): string {
  const key = requireKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptText(value: string, aad: string): string {
  if (!isEncrypted(value)) return value; // plaintext passthrough (pre-migration rows)
  const key = requireKey();
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  if (raw.length < IV_LEN + TAG_LEN) {
    throw new DataEncryptionError(`Corrupt ciphertext: too short (aad=${aad})`);
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // NEVER silently return ciphertext or garbage — this is a wrong-key or
    // corrupted-row situation and must surface immediately.
    throw new DataEncryptionError(
      `Decryption failed (wrong DATA_ENCRYPTION_KEY or corrupted row, aad=${aad})`,
    );
  }
}

/** JSON value → encrypted string (stored as a jsonb string scalar). */
export function encryptJson(value: unknown, aad: string): string {
  return encryptText(JSON.stringify(value), aad);
}

/** Encrypted jsonb string scalar → parsed value; plaintext objects/arrays pass through. */
export function decryptJson<T>(value: unknown, aad: string): T {
  if (typeof value === "string" && isEncrypted(value)) {
    return JSON.parse(decryptText(value, aad)) as T;
  }
  return value as T; // pre-migration plaintext jsonb passthrough
}

/** Element-wise encryption for text[] columns (already-encrypted elements are kept). */
export function encryptTextArray(values: string[], aad: string): string[] {
  return values.map((v) => (isEncrypted(v) ? v : encryptText(v, aad)));
}

export function decryptTextArray(values: string[], aad: string): string[] {
  return values.map((v) => decryptText(v, aad));
}

/** Generate a fresh master key (32 random bytes, base64). Used by ops tooling only. */
export function generateDataKey(): string {
  return crypto.randomBytes(32).toString("base64");
}

/** Test seam: forget the cached key so env changes take effect. */
export function _clearDataKeyCacheForTests(): void {
  cachedKey = undefined;
}
