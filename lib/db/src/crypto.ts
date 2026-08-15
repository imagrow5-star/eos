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
 * ─── Key custody: two modes ──────────────────────────────────────────────────
 * RAW mode (the original): DATA_ENCRYPTION_KEY holds the master key itself
 * (32 random bytes — 44-char base64 or 64-char hex). Whoever can read the
 * environment can read the key.
 *
 * KMS mode (hardened): DATA_ENCRYPTION_KEY_WRAPPED holds the master key
 * ENCRYPTED under a KMS key that never leaves the KMS (base64 ciphertext blob
 * from `aws kms encrypt`). At boot, initDataKey() sends the blob to the KMS,
 * receives the unwrapped 32 bytes, and keeps them in process memory only.
 * The environment alone is no longer enough to decrypt the database — an
 * attacker also needs live KMS credentials, and every unwrap is auditable in
 * CloudTrail. The unwrapper is injectable so tests (and a future non-AWS KMS)
 * don't need real cloud credentials.
 *
 * Fail closed: in KMS mode, an unreachable KMS or a failed unwrap throws —
 * the app must refuse to serve rather than run without the key.
 *
 * ─── KEY LOSS = DATA LOSS ────────────────────────────────────────────────────
 * The master key exists ONLY as the environment secret (raw or wrapped) plus
 * whatever offline backup the founder keeps. It is never written to the
 * database or the repo. If the key is lost (or, in KMS mode, the KMS key is
 * deleted), every encrypted row becomes permanently unreadable — there is no
 * recovery path. Keep a secure offline backup of the RAW key value for each
 * environment, even when running in KMS mode.
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

/** Strip copy-paste quotes and whitespace from an env secret. */
function cleanSecret(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "");
}

export function hasWrappedDataKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const wrapped = env.DATA_ENCRYPTION_KEY_WRAPPED;
  return typeof wrapped === "string" && wrapped.trim() !== "";
}

/** Resolve and cache the master key. Returns null when the env var is absent. */
export function loadDataKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw || raw.trim() === "") {
    // In KMS mode the key arrives via initDataKey() at boot — a sync read
    // before that is a wiring bug, and caching null here would turn it into
    // a confusing "key not set" later. Fail with the real story instead.
    if (hasWrappedDataKey()) {
      throw new DataEncryptionError(
        "DATA_ENCRYPTION_KEY_WRAPPED is set but the key has not been unwrapped yet — " +
          "await initDataKey() at boot before any encrypt/decrypt call",
      );
    }
    cachedKey = null;
    return null;
  }
  // Accept 32 random bytes in either common encoding: 64 hex chars
  // (openssl rand -hex 32) or standard base64 (openssl rand -base64 32).
  // Hex must be tested FIRST — a hex string also base64-decodes, but to 48
  // (wrong) bytes. Surrounding quotes from copy-paste are tolerated.
  const t = cleanSecret(raw);
  const buf = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, "hex") : Buffer.from(t, "base64");
  if (buf.length !== 32) {
    throw new DataEncryptionError(
      `DATA_ENCRYPTION_KEY must be 32 bytes — 44-char base64 or 64-char hex (got ${buf.length} bytes after decode)`,
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

// ─── KMS-mode boot initialization ─────────────────────────────────────────────

/** Turns a KMS ciphertext blob back into the raw 32-byte master key. */
export type KeyUnwrapper = (wrapped: Buffer) => Promise<Buffer>;

export type DataKeyMode = "kms" | "raw" | "none";

/**
 * Resolve the master key at boot. Call this (and await it) exactly once,
 * before any encrypt/decrypt: api-server does it in index.ts, daily-email at
 * the top of run().
 *
 * - DATA_ENCRYPTION_KEY_WRAPPED set → unwrap via the KMS (or the injected
 *   test unwrapper), cache the result in memory, return "kms". Any failure
 *   throws — fail closed, never serve without the key.
 * - Otherwise DATA_ENCRYPTION_KEY set → same as before, return "raw".
 * - Neither → "none" (callers decide whether that's fatal).
 *
 * Transition safety: while migrating an environment to KMS mode, both vars
 * may briefly coexist. They must decode to the SAME key — a mismatch means
 * writes would go under one key while the operator believes the other is
 * canonical, so it throws rather than guessing.
 */
export async function initDataKey(
  opts: { unwrapper?: KeyUnwrapper } = {},
): Promise<DataKeyMode> {
  const wrappedRaw = process.env.DATA_ENCRYPTION_KEY_WRAPPED;
  if (!wrappedRaw || wrappedRaw.trim() === "") {
    return loadDataKey() !== null ? "raw" : "none";
  }

  const blob = Buffer.from(cleanSecret(wrappedRaw), "base64");
  // A KMS ciphertext blob is the wrapped key plus KMS metadata — always well
  // over 32 bytes. A short decode means the operator pasted the raw key here.
  if (blob.length <= 32) {
    throw new DataEncryptionError(
      "DATA_ENCRYPTION_KEY_WRAPPED does not look like a KMS ciphertext blob — " +
        "did the RAW key get pasted into the wrapped slot? (raw keys go in DATA_ENCRYPTION_KEY)",
    );
  }

  const unwrap = opts.unwrapper ?? (await defaultKmsUnwrapper());
  let key: Buffer;
  try {
    key = await unwrap(blob);
  } catch (err) {
    throw new DataEncryptionError(
      "KMS unwrap of DATA_ENCRYPTION_KEY_WRAPPED failed — refusing to run without the data key. " +
        `Check KMS reachability/credentials (kms:Decrypt on the wrapping key). Cause: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
  if (key.length !== 32) {
    throw new DataEncryptionError(
      `KMS unwrap returned ${key.length} bytes — the wrapped secret is not a 32-byte master key`,
    );
  }

  // Both slots set during a migration window: they must agree.
  const rawEnv = process.env.DATA_ENCRYPTION_KEY;
  if (rawEnv && rawEnv.trim() !== "") {
    cachedKey = undefined; // make loadDataKey re-read the env, not a stale cache
    const rawKey = loadDataKey();
    if (rawKey && !crypto.timingSafeEqual(rawKey, key)) {
      throw new DataEncryptionError(
        "DATA_ENCRYPTION_KEY and DATA_ENCRYPTION_KEY_WRAPPED decode to DIFFERENT keys — " +
          "refusing to guess which one is canonical. Fix the environment so they match, " +
          "or remove the raw key once KMS mode is verified.",
      );
    }
  }

  cachedKey = key;
  return "kms";
}

/**
 * Default production unwrapper: AWS KMS Decrypt. Loaded lazily so the AWS SDK
 * never touches memory in raw-key mode or in tests. Region and credentials
 * come from the standard AWS env vars (AWS_REGION, AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY) — the IAM principal needs kms:Decrypt on the
 * wrapping key and nothing else.
 */
async function defaultKmsUnwrapper(): Promise<KeyUnwrapper> {
  const { KMSClient, DecryptCommand } = await import("@aws-sdk/client-kms");
  const client = new KMSClient({});
  return async (wrapped: Buffer) => {
    const out = await client.send(new DecryptCommand({ CiphertextBlob: wrapped }));
    if (!out.Plaintext) throw new Error("KMS Decrypt returned no plaintext");
    return Buffer.from(out.Plaintext);
  };
}

function requireKey(): Buffer {
  const key = loadDataKey();
  if (!key) {
    throw new DataEncryptionError(
      "No data encryption key available (DATA_ENCRYPTION_KEY unset and no unwrapped KMS key) — " +
        "refusing to read or write encrypted user data. " +
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
