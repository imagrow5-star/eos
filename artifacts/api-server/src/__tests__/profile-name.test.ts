/**
 * "Your name" — the name the companion calls the user, editable in Settings.
 *
 *   1. PUT /api/profile { userName } is validated: trimmed, whitespace
 *      collapsed, control characters stripped, 1–40 chars; anything else is a
 *      400 and nothing is stored (the raw value used to be stored untouched).
 *   2. originalUserName — the origin record behind Memory's "When we met" —
 *      is captured exactly ONCE and never overwritten:
 *        - the onboarding name step sets it;
 *        - for accounts that predate renaming (null), the FIRST rename keeps
 *          the name they held at that moment;
 *        - every later rename leaves it alone.
 *   3. GET /api/profile exposes it (null until captured).
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { normalizeUserName, USER_NAME_MAX } from "../lib/userName.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Unit: normalizeUserName ─────────────────────────────────────────────────

describe("normalizeUserName", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeUserName("  Priya  ")).toBe("Priya");
    expect(normalizeUserName("Mary   Anne\tSmith")).toBe("Mary Anne Smith");
  });

  it("strips control characters", () => {
    expect(normalizeUserName("Pri\u0000ya\u001F")).toBe("Priya");
    expect(normalizeUserName("Sam\u007F")).toBe("Sam");
  });

  it("rejects empty, whitespace-only and control-only input", () => {
    expect(normalizeUserName("")).toBeNull();
    expect(normalizeUserName("   ")).toBeNull();
    expect(normalizeUserName("\u0000\u0001")).toBeNull();
    expect(normalizeUserName(undefined)).toBeNull();
    expect(normalizeUserName(42)).toBeNull();
  });

  it("caps at 40 characters (after trimming)", () => {
    // Capitalised on purpose: an all-lowercase name is title-cased (see
    // user-name-case.test.ts); this test is about length only.
    const forty = "A" + "a".repeat(USER_NAME_MAX - 1);
    expect(normalizeUserName(forty)).toBe(forty);
    expect(normalizeUserName(`  ${forty}  `)).toBe(forty);
    expect(normalizeUserName("A" + "a".repeat(USER_NAME_MAX))).toBeNull();
  });
});

// ─── Integration ─────────────────────────────────────────────────────────────

const createdEmails: string[] = [];

async function makeUser(tag: string) {
  const email = `profile-name-${tag}-${Date.now()}@example.com`;
  createdEmails.push(email);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email, password: "Sup3r-secret!pw" });
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
      await pool.query(`DELETE FROM messages WHERE user_id = $1`, [row.id]);
      await pool.query(`DELETE FROM profile WHERE user_id = $1`, [row.id]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [row.id]);
    }
  }
  await pool.end();
});

describe("PUT /api/profile userName", () => {
  it("stores a normalized name and returns it", async () => {
    const agent = await makeUser("store");
    const res = await agent.put("/api/profile").send({ userName: "  Priya   Nair " });
    expect(res.status).toBe(200);
    expect(res.body.userName).toBe("Priya Nair");

    const after = await agent.get("/api/profile");
    expect(after.body.userName).toBe("Priya Nair");
  });

  it("rejects empty and over-long names with 400 and stores nothing", async () => {
    const agent = await makeUser("reject");
    const set = await agent.put("/api/profile").send({ userName: "Priya" });
    expect(set.status).toBe(200);

    for (const bad of ["", "   ", "\u0000", "a".repeat(USER_NAME_MAX + 1)]) {
      const r = await agent.put("/api/profile").send({ userName: bad });
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toMatch(/name/i);
    }

    const after = await agent.get("/api/profile");
    expect(after.body.userName).toBe("Priya"); // unchanged
  });
});

describe("originalUserName — captured once, never overwritten", () => {
  it("is null on a fresh profile and exposed by GET", async () => {
    const agent = await makeUser("fresh");
    const res = await agent.get("/api/profile");
    expect(res.status).toBe(200);
    expect(res.body.originalUserName).toBeNull();
  });

  it("a profile with no name yet keeps the FIRST name it is given", async () => {
    const agent = await makeUser("first");
    await agent.put("/api/profile").send({ userName: "Priya" });
    const res = await agent.get("/api/profile");
    expect(res.body.userName).toBe("Priya");
    expect(res.body.originalUserName).toBe("Priya");
  });

  it("a pre-existing account (null original) keeps the name it held at the first rename, then never changes", async () => {
    const agent = await makeUser("legacy");
    // Simulate an account from before renaming existed: a name on the profile
    // but no original captured (exactly the state every existing user is in).
    const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [createdEmails.at(-1)]);
    await agent.get("/api/profile"); // ensure the profile row exists
    // Write the legacy name THROUGH the ORM path (encrypted column) by using
    // the API, then clear the captured original directly — that's the legacy
    // shape: user_name set, original_user_name NULL.
    await agent.put("/api/profile").send({ userName: "Samuel" });
    await pool.query(`UPDATE profile SET original_user_name = NULL WHERE user_id = $1`, [rows[0]!.id]);
    const before = await agent.get("/api/profile");
    expect(before.body.userName).toBe("Samuel");
    expect(before.body.originalUserName).toBeNull();

    // First rename: the original becomes the name they HELD ("Samuel"), not the new one.
    const r1 = await agent.put("/api/profile").send({ userName: "Sam" });
    expect(r1.status).toBe(200);
    expect(r1.body.userName).toBe("Sam");
    expect(r1.body.originalUserName).toBe("Samuel");

    // Second and third renames: the original is untouched.
    await agent.put("/api/profile").send({ userName: "Sammy" });
    const r3 = await agent.put("/api/profile").send({ userName: "S" });
    expect(r3.body.userName).toBe("S");
    expect(r3.body.originalUserName).toBe("Samuel");

    // Saving the same name again, and updating other fields, never touch it.
    await agent.put("/api/profile").send({ userName: "S" });
    await agent.put("/api/profile").send({ country: "IN" });
    const final = await agent.get("/api/profile");
    expect(final.body.userName).toBe("S");
    expect(final.body.originalUserName).toBe("Samuel");
  });

  it("the onboarding name step sets it, and a later rename keeps it", async () => {
    const agent = await makeUser("onboarding");
    // Walk the onboarding flow until it asks for the name — the step order is
    // the server's business, so answer whatever it asks with a safe default.
    const answerFor = (step: string): string => {
      if (step === "name") return "my name is Ananya";
      if (step === "purpose" || step === "path") return "lonely";
      if (step === "companionGender") return "woman";
      return "skip";
    };
    let reachedName = false;
    for (let i = 0; i < 8 && !reachedName; i++) {
      const status = await agent.get("/api/onboarding/status");
      expect(status.status).toBe(200);
      const step = status.body.currentStep as string;
      const r = await agent.post("/api/onboarding/answer").send({ step, answer: answerFor(step) });
      expect(r.status).toBeLessThan(300);
      if (step === "name") reachedName = true;
    }
    expect(reachedName).toBe(true);

    const after = await agent.get("/api/profile");
    expect(after.body.userName).toBe("Ananya");
    expect(after.body.originalUserName).toBe("Ananya");

    // Rename in Settings: the record from onboarding survives.
    await agent.put("/api/profile").send({ userName: "Anu" });
    const renamed = await agent.get("/api/profile");
    expect(renamed.body.userName).toBe("Anu");
    expect(renamed.body.originalUserName).toBe("Ananya");
  });
});
