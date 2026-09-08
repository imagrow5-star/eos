/**
 * Name casing (lib/userName.ts presentCaseName + routes/profile.ts healNameCase).
 *
 * An all-lowercase name is title-cased at every write, and — once — on read
 * for rows that predate the rule. A name with any capital is never touched.
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { eq } from "drizzle-orm";
import { db, profileTable } from "@workspace/db";
import app from "../app.js";
import { presentCaseName, normalizeUserName } from "../lib/userName.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const createdEmails: string[] = [];

async function makeUser(tag: string) {
  const email = `name-case-${tag}-${Date.now()}@example.com`;
  createdEmails.push(email);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email, password: "Sup3r-secret!pw" });
  expect(res.status).toBeLessThan(300);
  await pool.query(`UPDATE users SET email_verified_at = NOW() WHERE email = $1`, [email]);
  const { rows } = await pool.query<{ id: number }>(`SELECT id FROM users WHERE email = $1`, [email]);
  return { agent, userId: rows[0]!.id };
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

describe("presentCaseName", () => {
  it("title-cases a name with no capital at all", () => {
    expect(presentCaseName("naveen")).toBe("Naveen");
    expect(presentCaseName("naveen kumar")).toBe("Naveen Kumar");
    expect(presentCaseName("élodie")).toBe("Élodie");
  });

  it("leaves a name with any capital exactly as written", () => {
    for (const n of ["McKenzie", "van der Berg", "Naveen", "SAM", "dEEpak"]) expect(presentCaseName(n)).toBe(n);
  });

  it("leaves empty and letterless input alone", () => {
    expect(presentCaseName("")).toBe("");
    expect(presentCaseName("123")).toBe("123");
  });

  it("is applied by the Settings validator", () => {
    expect(normalizeUserName("  naveen  ")).toBe("Naveen");
    expect(normalizeUserName("McKenzie")).toBe("McKenzie");
  });
});

describe("write paths and the one-time read repair", () => {
  it("PUT /api/profile title-cases an all-lowercase name", async () => {
    const { agent } = await makeUser("put");
    const res = await agent.put("/api/profile").send({ userName: "naveen" });
    expect(res.status).toBe(200);
    expect(res.body.userName).toBe("Naveen");
    const keep = await agent.put("/api/profile").send({ userName: "McKenzie" });
    expect(keep.body.userName).toBe("McKenzie");
  });

  it("a row stored lowercase before the rule is repaired once on read, in the DB too", async () => {
    const { agent, userId } = await makeUser("heal");
    await agent.get("/api/profile"); // create the row
    // Write the legacy shape through the ORM (the columns are encrypted).
    await db.update(profileTable).set({ userName: "naveen", originalUserName: "naveen" }).where(eq(profileTable.userId, userId));

    const res = await agent.get("/api/profile");
    expect(res.body.userName).toBe("Naveen");
    expect(res.body.originalUserName).toBe("Naveen");

    const [row] = await db.select({ userName: profileTable.userName, originalUserName: profileTable.originalUserName }).from(profileTable).where(eq(profileTable.userId, userId));
    expect(row).toEqual({ userName: "Naveen", originalUserName: "Naveen" });
  });

  it("the repair never touches a name with a capital, and never overwrites an original", async () => {
    const { agent, userId } = await makeUser("keep");
    await agent.get("/api/profile");
    await db.update(profileTable).set({ userName: "van der Berg", originalUserName: "Samuel" }).where(eq(profileTable.userId, userId));
    const res = await agent.get("/api/profile");
    expect(res.body.userName).toBe("van der Berg");
    expect(res.body.originalUserName).toBe("Samuel");
  });
});
