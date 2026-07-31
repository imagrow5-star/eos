/**
 * Privacy audit Tier 2 — hashUserIdForLog helper + systemPrompt refactor.
 *
 * The helper is the single source of truth for the salted log-hash. These are
 * deterministic and DB-free.
 */

import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";

const SALT = "tier2-test-salt-0123456789abcdef";
const priorSalt = process.env.LOG_HASH_SALT;

afterEach(() => {
  if (priorSalt === undefined) delete process.env.LOG_HASH_SALT;
  else process.env.LOG_HASH_SALT = priorSalt;
});

// The exact legacy inline formula from Sprint 2A systemPrompt.ts, kept here as
// the regression oracle: the refactor must not change the emitted value.
const legacyFormula = (salt: string, userId: number | string): string =>
  crypto.createHash("sha256").update(salt + ":" + userId).digest("hex").slice(0, 8);

describe("hashUserIdForLog", () => {
  it("is deterministic: same userId + same salt → same hash", () => {
    process.env.LOG_HASH_SALT = SALT;
    expect(hashUserIdForLog(42)).toBe(hashUserIdForLog(42));
    expect(hashUserIdForLog(42)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("produces distinct hashes for different userIds", () => {
    process.env.LOG_HASH_SALT = SALT;
    expect(hashUserIdForLog(42)).not.toBe(hashUserIdForLog(43));
  });

  it("returns undefined (never throws) when the salt is unset", () => {
    delete process.env.LOG_HASH_SALT;
    expect(() => hashUserIdForLog(42)).not.toThrow();
    expect(hashUserIdForLog(42)).toBeUndefined();
  });

  it("returns undefined for an empty-string salt (treated as unset)", () => {
    process.env.LOG_HASH_SALT = "";
    expect(hashUserIdForLog(42)).toBeUndefined();
  });

  it("hashes numeric and string userIds identically (42 === \"42\")", () => {
    process.env.LOG_HASH_SALT = SALT;
    expect(hashUserIdForLog(42)).toBe(hashUserIdForLog("42"));
  });

  it("REGRESSION: matches the legacy inline systemPrompt formula exactly", () => {
    process.env.LOG_HASH_SALT = SALT;
    // systemPrompt.ts (Sprint 2A) used salt + ":" + userId with a numeric id;
    // the refactor now calls hashUserIdForLog(userId). Same value for same input.
    expect(hashUserIdForLog(4242)).toBe(legacyFormula(SALT, 4242));
    expect(hashUserIdForLog("4242")).toBe(legacyFormula(SALT, 4242));
  });
});
