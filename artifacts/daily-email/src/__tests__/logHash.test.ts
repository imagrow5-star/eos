/**
 * Privacy audit Tier 2 — daily-email's logHash mirror.
 *
 * This is the same contract as api-server's hashUserIdForLog (duplicated only
 * because this job can't depend on @workspace/api-server). It MUST produce the
 * identical value for the same salt + userId, so both deployables' logs are
 * groupable by the same `uh`. Deterministic and DB-free.
 */

import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import { hashUserIdForLog } from "../logHash";

const SALT = "tier2-test-salt-0123456789abcdef";
const priorSalt = process.env.LOG_HASH_SALT;

afterEach(() => {
  if (priorSalt === undefined) delete process.env.LOG_HASH_SALT;
  else process.env.LOG_HASH_SALT = priorSalt;
});

// Same canonical formula as api-server's helper — the two must agree.
const canonical = (salt: string, userId: number | string): string =>
  crypto.createHash("sha256").update(salt + ":" + String(userId)).digest("hex").slice(0, 8);

describe("daily-email hashUserIdForLog (mirror)", () => {
  it("is deterministic and 8 hex chars", () => {
    process.env.LOG_HASH_SALT = SALT;
    expect(hashUserIdForLog(42)).toBe(hashUserIdForLog(42));
    expect(hashUserIdForLog(42)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("distinct userIds → distinct hashes", () => {
    process.env.LOG_HASH_SALT = SALT;
    expect(hashUserIdForLog(42)).not.toBe(hashUserIdForLog(43));
  });

  it("undefined (no throw) when salt unset", () => {
    delete process.env.LOG_HASH_SALT;
    expect(() => hashUserIdForLog(42)).not.toThrow();
    expect(hashUserIdForLog(42)).toBeUndefined();
  });

  it("numeric and string userIds hash identically", () => {
    process.env.LOG_HASH_SALT = SALT;
    expect(hashUserIdForLog(42)).toBe(hashUserIdForLog("42"));
  });

  it("PARITY: matches the canonical api-server formula (same uh across deployables)", () => {
    process.env.LOG_HASH_SALT = SALT;
    expect(hashUserIdForLog(4242)).toBe(canonical(SALT, 4242));
  });
});
