/**
 * Country validation at profile write time.
 *
 * The daily-email job resolves country → timezone defensively (unknown codes
 * hold the email), but a bogus stored country still means a user silently
 * never gets morning emails when their device timezone is missing. So the
 * write path must:
 *   1. accept only picker-producible codes (Intl.DisplayNames), "other", "";
 *   2. store "UK" for GB (deliberate legacy storage alias);
 *   3. normalize superseded codes (SU, ZR, BU, …) to canonical modern codes,
 *      in lockstep with LEGACY_COUNTRY_ALIASES in the daily-email job;
 *   4. reject everything else with a 400, never storing garbage.
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { normalizeCountryForStorage, LEGACY_COUNTRY_ALIASES } from "../lib/basics.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Unit: normalizeCountryForStorage ────────────────────────────────────────

describe("normalizeCountryForStorage", () => {
  it("accepts real ISO codes, case-insensitively", () => {
    expect(normalizeCountryForStorage("IN")).toBe("IN");
    expect(normalizeCountryForStorage("in")).toBe("IN");
    expect(normalizeCountryForStorage(" us ")).toBe("US");
  });

  it("stores UK for both UK and GB", () => {
    expect(normalizeCountryForStorage("GB")).toBe("UK");
    expect(normalizeCountryForStorage("uk")).toBe("UK");
  });

  it("accepts empty (clear) and the literal other", () => {
    expect(normalizeCountryForStorage("")).toBe("");
    expect(normalizeCountryForStorage("  ")).toBe("");
    expect(normalizeCountryForStorage("other")).toBe("other");
    expect(normalizeCountryForStorage("OTHER")).toBe("other");
  });

  it("normalizes every legacy alias to its canonical modern code", () => {
    for (const [legacy, canonical] of Object.entries(LEGACY_COUNTRY_ALIASES)) {
      expect(normalizeCountryForStorage(legacy)).toBe(canonical);
    }
    // Spot-check the ones named in the task
    expect(normalizeCountryForStorage("SU")).toBe("RU");
    expect(normalizeCountryForStorage("ZR")).toBe("CD");
    expect(normalizeCountryForStorage("BU")).toBe("MM");
  });

  it("rejects garbage", () => {
    expect(normalizeCountryForStorage("XX")).toBeNull();
    expect(normalizeCountryForStorage("USA")).toBeNull();
    expect(normalizeCountryForStorage("India")).toBeNull();
    expect(normalizeCountryForStorage("U1")).toBeNull();
    expect(normalizeCountryForStorage("<script>")).toBeNull();
  });
});

// ─── Integration: PUT /api/profile ───────────────────────────────────────────

const createdEmails: string[] = [];

async function makeUser(tag: string) {
  const email = `country-valid-${tag}-${Date.now()}@example.com`;
  createdEmails.push(email);
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/signup")
    .send({ email, password: "Sup3r-secret!pw" });
  expect(res.status).toBeLessThan(300);
  // Profile routes are gated on a verified email — mark verified directly.
  await pool.query(`UPDATE users SET email_verified_at = NOW() WHERE email = $1`, [email]);
  return agent;
}

afterAll(async () => {
  for (const email of createdEmails) {
    const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    for (const row of rows) {
      await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1`, [String(row.id)]);
      await pool.query(`DELETE FROM email_verification_tokens WHERE user_id = $1`, [row.id]);
      await pool.query(`DELETE FROM profile WHERE user_id = $1`, [row.id]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [row.id]);
    }
  }
  await pool.end();
});

describe("PUT /api/profile country validation", () => {
  it("stores a valid code and normalizes legacy codes", async () => {
    const agent = await makeUser("valid");
    const ok = await agent.put("/api/profile").send({ country: "in" });
    expect(ok.status).toBe(200);
    expect(ok.body.country).toBe("IN");

    const legacy = await agent.put("/api/profile").send({ country: "SU" });
    expect(legacy.status).toBe(200);
    expect(legacy.body.country).toBe("RU");

    const gb = await agent.put("/api/profile").send({ country: "GB" });
    expect(gb.status).toBe(200);
    expect(gb.body.country).toBe("UK");
  });

  it("rejects an invalid code with 400 and does not store it", async () => {
    const agent = await makeUser("invalid");
    const set = await agent.put("/api/profile").send({ country: "IN" });
    expect(set.status).toBe(200);

    const bad = await agent.put("/api/profile").send({ country: "XX" });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/country/i);

    const after = await agent.get("/api/profile");
    expect(after.body.country).toBe("IN"); // unchanged
  });

  it("accepts 'other' and empty-to-clear", async () => {
    const agent = await makeUser("clear");
    const other = await agent.put("/api/profile").send({ country: "other" });
    expect(other.status).toBe(200);
    expect(other.body.country).toBe("other");

    const cleared = await agent.put("/api/profile").send({ country: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.country).toBe("");
  });
});
