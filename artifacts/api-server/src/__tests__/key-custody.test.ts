// ─── Key custody (A1): initDataKey and the KMS-wrapped mode ──────────────────
// The unwrapper is injected in every test — no AWS credentials exist here, and
// that's the point of the seam. What these tests pin down:
//   - raw mode keeps working exactly as before
//   - KMS mode unwraps at boot, and encrypt/decrypt then use the unwrapped key
//   - every failure path fails CLOSED (throws) instead of serving without a key
//   - the raw/wrapped transition window demands the two keys agree

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  initDataKey,
  loadDataKey,
  encryptText,
  decryptText,
  hasWrappedDataKey,
  DataEncryptionError,
  _clearDataKeyCacheForTests,
} from "@workspace/db";

const savedRaw = process.env.DATA_ENCRYPTION_KEY;
const savedWrapped = process.env.DATA_ENCRYPTION_KEY_WRAPPED;

const KEY_A = crypto.randomBytes(32);
const KEY_B = crypto.randomBytes(32);
// Stand-in for a KMS ciphertext blob: opaque bytes, longer than a raw key.
const FAKE_BLOB = crypto.randomBytes(80);

const unwrapToA = async (wrapped: Buffer) => {
  // The blob delivered to the unwrapper must be the decoded env value.
  expect(wrapped.equals(FAKE_BLOB)).toBe(true);
  return KEY_A;
};

beforeEach(() => {
  delete process.env.DATA_ENCRYPTION_KEY;
  delete process.env.DATA_ENCRYPTION_KEY_WRAPPED;
  _clearDataKeyCacheForTests();
});

afterEach(() => {
  if (savedRaw === undefined) delete process.env.DATA_ENCRYPTION_KEY;
  else process.env.DATA_ENCRYPTION_KEY = savedRaw;
  if (savedWrapped === undefined) delete process.env.DATA_ENCRYPTION_KEY_WRAPPED;
  else process.env.DATA_ENCRYPTION_KEY_WRAPPED = savedWrapped;
  _clearDataKeyCacheForTests();
});

describe("initDataKey modes", () => {
  it("returns 'none' with no key configured", async () => {
    expect(await initDataKey()).toBe("none");
  });

  it("returns 'raw' with only DATA_ENCRYPTION_KEY, and round-trips", async () => {
    process.env.DATA_ENCRYPTION_KEY = KEY_A.toString("base64");
    expect(await initDataKey()).toBe("raw");
    const ct = encryptText("hello", "t.c");
    expect(decryptText(ct, "t.c")).toBe("hello");
  });

  it("returns 'kms' with a wrapped key, and encrypt/decrypt use the unwrapped key", async () => {
    process.env.DATA_ENCRYPTION_KEY_WRAPPED = FAKE_BLOB.toString("base64");
    expect(await initDataKey({ unwrapper: unwrapToA })).toBe("kms");

    const ct = encryptText("kms secret", "t.c");
    expect(decryptText(ct, "t.c")).toBe("kms secret");

    // Prove the ciphertext really is under KEY_A: a process holding a
    // different key must fail loudly, and one holding KEY_A raw must succeed.
    _clearDataKeyCacheForTests();
    process.env.DATA_ENCRYPTION_KEY = KEY_B.toString("base64");
    delete process.env.DATA_ENCRYPTION_KEY_WRAPPED;
    expect(() => decryptText(ct, "t.c")).toThrow(DataEncryptionError);

    _clearDataKeyCacheForTests();
    process.env.DATA_ENCRYPTION_KEY = KEY_A.toString("base64");
    expect(decryptText(ct, "t.c")).toBe("kms secret");
  });
});

describe("initDataKey fails closed", () => {
  it("throws when the unwrapper throws (KMS unreachable / bad credentials)", async () => {
    process.env.DATA_ENCRYPTION_KEY_WRAPPED = FAKE_BLOB.toString("base64");
    await expect(
      initDataKey({
        unwrapper: async () => {
          throw new Error("connect ETIMEDOUT kms.us-east-1.amazonaws.com");
        },
      }),
    ).rejects.toThrow(/KMS unwrap .* failed/);
  });

  it("throws when the unwrap yields a non-32-byte key", async () => {
    process.env.DATA_ENCRYPTION_KEY_WRAPPED = FAKE_BLOB.toString("base64");
    await expect(
      initDataKey({ unwrapper: async () => crypto.randomBytes(16) }),
    ).rejects.toThrow(/32-byte/);
  });

  it("throws when a raw key was pasted into the wrapped slot", async () => {
    process.env.DATA_ENCRYPTION_KEY_WRAPPED = KEY_A.toString("base64"); // 32 bytes — too short for a blob
    await expect(initDataKey({ unwrapper: unwrapToA })).rejects.toThrow(
      /does not look like a KMS ciphertext blob/,
    );
  });

  it("sync key access before initDataKey in KMS mode names the wiring bug", () => {
    process.env.DATA_ENCRYPTION_KEY_WRAPPED = FAKE_BLOB.toString("base64");
    expect(() => loadDataKey()).toThrow(/await initDataKey/);
  });
});

describe("raw/wrapped transition window", () => {
  it("accepts both slots when they decode to the SAME key", async () => {
    process.env.DATA_ENCRYPTION_KEY = KEY_A.toString("base64");
    process.env.DATA_ENCRYPTION_KEY_WRAPPED = FAKE_BLOB.toString("base64");
    expect(await initDataKey({ unwrapper: unwrapToA })).toBe("kms");
    const ct = encryptText("transition", "t.c");
    expect(decryptText(ct, "t.c")).toBe("transition");
  });

  it("refuses to boot when the two slots decode to DIFFERENT keys", async () => {
    process.env.DATA_ENCRYPTION_KEY = KEY_B.toString("base64");
    process.env.DATA_ENCRYPTION_KEY_WRAPPED = FAKE_BLOB.toString("base64");
    await expect(initDataKey({ unwrapper: unwrapToA })).rejects.toThrow(/DIFFERENT keys/);
  });
});

describe("hasWrappedDataKey", () => {
  it("detects presence and treats blank as absent", () => {
    expect(hasWrappedDataKey({})).toBe(false);
    expect(hasWrappedDataKey({ DATA_ENCRYPTION_KEY_WRAPPED: "  " })).toBe(false);
    expect(hasWrappedDataKey({ DATA_ENCRYPTION_KEY_WRAPPED: "abc" })).toBe(true);
  });
});
