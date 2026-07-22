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
