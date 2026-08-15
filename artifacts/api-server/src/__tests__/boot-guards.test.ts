// ─── Boot security guards ─────────────────────────────────────────────────────
// Pure-function coverage for the Phase 0 hardening: SESSION_SECRET strength
// enforcement and the pg_stat_ssl transit-encryption check. The enforcement
// wiring (process.exit) lives in index.ts, which tests never import — these
// tests pin the DECISIONS the wiring acts on, plus one live-DB test proving
// the TLS probe returns a verdict (not "unknown") against a real Postgres.

import { describe, it, expect } from "vitest";
import { poolSslConfig } from "@workspace/db";
import { sessionSecretIssue, checkDbTls } from "../services/bootGuards";

const strong = "x".repeat(44); // openssl rand -base64 32 → 44 chars

describe("sessionSecretIssue", () => {
  it("flags a missing secret in every environment", () => {
    expect(sessionSecretIssue({ NODE_ENV: "production" })).toMatch(/not set/);
    expect(sessionSecretIssue({ NODE_ENV: "development" })).toMatch(/not set/);
    expect(sessionSecretIssue({})).toMatch(/not set/);
  });

  it("accepts a strong secret in production", () => {
    expect(sessionSecretIssue({ NODE_ENV: "production", SESSION_SECRET: strong })).toBeNull();
  });

  it("rejects a short secret in production, with remediation in the message", () => {
    const issue = sessionSecretIssue({ NODE_ENV: "production", SESSION_SECRET: "hunter2" });
    expect(issue).toMatch(/only 7 characters/);
    expect(issue).toMatch(/openssl rand -base64 32/);
    // Rotation is disruptive (logs everyone out) — the message must say so.
    expect(issue).toMatch(/logs every user out/);
  });

  it("accepts exactly 32 characters in production (boundary)", () => {
    expect(
      sessionSecretIssue({ NODE_ENV: "production", SESSION_SECRET: "a".repeat(32) }),
    ).toBeNull();
    expect(
      sessionSecretIssue({ NODE_ENV: "production", SESSION_SECRET: "a".repeat(31) }),
    ).toMatch(/only 31 characters/);
  });

  it("tolerates a short secret outside production (dev/CI use throwaways)", () => {
    expect(sessionSecretIssue({ NODE_ENV: "test", SESSION_SECRET: "short" })).toBeNull();
    expect(sessionSecretIssue({ SESSION_SECRET: "short" })).toBeNull();
  });
});

describe("poolSslConfig", () => {
  it("DATABASE_SSL=require encrypts without certificate verification", () => {
    expect(poolSslConfig({ DATABASE_SSL: "require" })).toEqual({ rejectUnauthorized: false });
    expect(poolSslConfig({ DATABASE_SSL: " REQUIRE " })).toEqual({ rejectUnauthorized: false });
  });

  it("DATABASE_SSL=verify / verify-full enables full certificate verification", () => {
    expect(poolSslConfig({ DATABASE_SSL: "verify" })).toBe(true);
    expect(poolSslConfig({ DATABASE_SSL: "verify-full" })).toBe(true);
  });

  it("unset or unrecognized values leave the decision to the connection string", () => {
    expect(poolSslConfig({})).toBeUndefined();
    expect(poolSslConfig({ DATABASE_SSL: "" })).toBeUndefined();
    expect(poolSslConfig({ DATABASE_SSL: "disable" })).toBeUndefined();
  });
});

describe("checkDbTls (injected query)", () => {
  it("reports encrypted when pg_stat_ssl says ssl=true", async () => {
    expect(await checkDbTls(async () => ({ rows: [{ ssl: true }] }))).toBe("encrypted");
  });

  it("reports plaintext when pg_stat_ssl says ssl=false", async () => {
    expect(await checkDbTls(async () => ({ rows: [{ ssl: false }] }))).toBe("plaintext");
  });

  it("reports unknown when the row is missing or malformed", async () => {
    expect(await checkDbTls(async () => ({ rows: [] }))).toBe("unknown");
    expect(await checkDbTls(async () => ({ rows: [{}] }))).toBe("unknown");
  });

  it("reports unknown (never throws) when the query fails", async () => {
    expect(
      await checkDbTls(async () => {
        throw new Error("connection refused");
      }),
    ).toBe("unknown");
  });
});

describe("checkDbTls (live database)", () => {
  it("returns a real verdict against the test Postgres", async () => {
    // Sandbox/CI Postgres is local and non-TLS, so "plaintext" is the expected
    // verdict here — the point is that the probe WORKS (pg_stat_ssl exists and
    // the row for our own backend is found). "encrypted" is equally a pass for
    // environments that do terminate TLS.
    const state = await checkDbTls();
    expect(["encrypted", "plaintext"]).toContain(state);
  });
});
