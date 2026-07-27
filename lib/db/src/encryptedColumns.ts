/**
 * Drizzle column types that transparently encrypt on write and decrypt on read.
 *
 * These are the single choke point for ORM traffic: every `db.select()` /
 * `db.insert()` / `db.update()` on a wrapped column goes through
 * toDriver/fromDriver, so application code keeps working with plaintext and
 * can never accidentally write plaintext to disk through drizzle.
 *
 * Two things DO NOT go through these mappers and need explicit handling:
 *   1. Raw SQL (`pool.query`) — must call decryptText/decryptJson manually
 *      (account export does this).
 *   2. SQL-side VALUE comparisons (`eq(col, x)`, `LIKE`) — ciphertexts are
 *      non-deterministic (random IV), so equality/LIKE must move into app
 *      code on decrypted rows. Voice-call dedup and personality-signal
 *      dedup were rewritten accordingly.
 *
 * NULL values bypass the mappers entirely (drizzle sends/returns NULL), so
 * nullable columns behave exactly as before.
 */
import { customType } from "drizzle-orm/pg-core";
import {
  decryptJson,
  decryptText,
  decryptTextArray,
  encryptJson,
  encryptText,
  encryptTextArray,
} from "./crypto";

/** text column, encrypted at rest. */
export function encryptedText(name: string, aad: string) {
  return customType<{ data: string; driverData: string }>({
    dataType() {
      return "text";
    },
    toDriver(value: string): string {
      return encryptText(value, aad);
    },
    fromDriver(value: unknown): string {
      return typeof value === "string" ? decryptText(value, aad) : (value as string);
    },
  })(name);
}

/**
 * jsonb column, encrypted at rest as a JSON string scalar (`"enc:v1:…"`).
 * toDriver returns the JSON-stringified form because that is what the pg
 * driver sends for jsonb parameters (mirrors drizzle's own jsonb mapping);
 * fromDriver receives the driver-parsed value (string when encrypted,
 * object/array for legacy plaintext rows).
 */
export function encryptedJsonb<T = unknown>(name: string, aad: string) {
  return customType<{ data: T; driverData: string }>({
    dataType() {
      return "jsonb";
    },
    toDriver(value: T): string {
      return JSON.stringify(encryptJson(value, aad));
    },
    fromDriver(value: unknown): T {
      return decryptJson<T>(value, aad);
    },
  })(name);
}

/**
 * Boolean flag, encrypted at rest (stored as an encrypted text column holding
 * "true"/"false"). Built for sealed_notes.crisis_flagged: the note TEXT beside
 * it was encrypted while the flag sat in plaintext, letting anyone with a DB
 * dump run `WHERE crisis_flagged = true` and list users flagged for crisis
 * language. Nothing filters on this flag in SQL (every reader loads the row
 * through drizzle and checks it in app code), so the tradeoff of losing
 * SQL-side queryability costs nothing today. If a future feature ever needs
 * to FILTER on it server-side, that query must move to app code on decrypted
 * rows — same rule as every other encrypted column (see header).
 *
 * Legacy plaintext passthrough covers both shapes: a raw boolean (column not
 * yet converted to text) and the "true"/"false" strings produced by the
 * boolean→text migration cast.
 */
export function encryptedBoolean(name: string, aad: string) {
  return customType<{ data: boolean; driverData: string }>({
    dataType() {
      return "text";
    },
    toDriver(value: boolean): string {
      return encryptText(value ? "true" : "false", aad);
    },
    fromDriver(value: unknown): boolean {
      if (typeof value === "boolean") return value; // pre-conversion column
      if (typeof value === "string") return decryptText(value, aad) === "true";
      return false;
    },
  })(name);
}

/** text[] column, element-wise encrypted at rest. */
export function encryptedTextArray(name: string, aad: string) {
  return customType<{ data: string[]; driverData: string[] }>({
    dataType() {
      return "text[]";
    },
    toDriver(value: string[]): string[] {
      return encryptTextArray(value, aad);
    },
    fromDriver(value: unknown): string[] {
      return Array.isArray(value) ? decryptTextArray(value as string[], aad) : (value as string[]);
    },
  })(name);
}
