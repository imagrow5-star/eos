/**
 * Security review follow-up: the last four plaintext columns that hold a
 * person's words or the shape of their feelings are ciphertext at rest —
 * reminders.content, leads.message, story_threads.label and
 * memory_feelings.category. Proves, against the real DB:
 *   • writes through the ORM land as "enc:v1:…" in the raw rows;
 *   • reads through the ORM round-trip;
 *   • the account export decrypts them;
 *   • legacy plaintext rows read back and the boot sweep encrypts them.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { eq } from "drizzle-orm";
import request from "supertest";
import {
  db,
  usersTable,
  remindersTable,
  storyThreadsTable,
  memoryFeelingsTable,
  leadsTable,
  decryptText,
} from "@workspace/db";
import app from "../app.js";
import { runDataEncryptionMigration } from "../services/dataEncryptionMigration.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const DB = Boolean(process.env.DATABASE_URL);
const EMAIL = `remaining-enc-${Date.now()}@example.invalid`;
const LEAD_EMAIL = `remaining-enc-lead-${Date.now()}@example.invalid`;
const PASSWORD = "Password123";
let userId = 0;
const agent = request.agent(app);

beforeAll(async () => {
  if (!DB) return;
  const res = await agent.post("/api/auth/signup").send({ email: EMAIL, password: PASSWORD });
  expect(res.status).toBe(201);
  userId = res.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
});

afterAll(async () => {
  if (DB && userId) {
    await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1`, [String(userId)]);
    for (const t of ["reminders", "story_threads", "memory_feelings", "profile"]) {
      await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
    }
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    await pool.query("DELETE FROM leads WHERE email = $1", [LEAD_EMAIL]);
  }
  await pool.end();
});

describe.skipIf(!DB)("reminders, leads, story-thread labels and feeling categories are ciphertext at rest", () => {
  it("ORM writes are ciphertext on disk and round-trip", async () => {
    const [rem] = await db.insert(remindersTable).values({ userId, content: "call mum about the scan" }).returning({ id: remindersTable.id });
    const [thread] = await db
      .insert(storyThreadsTable)
      .values({ userId, slug: "the-airport-goodbye", label: "the airport goodbye", firstSeenWeek: "2026-09-07", lastSeenWeek: "2026-09-07", retellings: [] })
      .returning({ id: storyThreadsTable.id });
    const [feel] = await db
      .insert(memoryFeelingsTable)
      .values({ userId, feeling: "small at sunday dinner", category: "shame" })
      .returning({ id: memoryFeelingsTable.id });
    const [lead] = await db.insert(leadsTable).values({ email: LEAD_EMAIL, message: "will you read this", source: "landing_hero", consentText: "c" }).returning({ id: leadsTable.id });

    const raw = await pool.query<{ v: string }>(
      `SELECT content AS v FROM reminders WHERE id = $1
       UNION ALL SELECT label FROM story_threads WHERE id = $2
       UNION ALL SELECT category FROM memory_feelings WHERE id = $3
       UNION ALL SELECT message FROM leads WHERE id = $4`,
      [rem!.id, thread!.id, feel!.id, lead!.id],
    );
    expect(raw.rows).toHaveLength(4);
    for (const r of raw.rows) expect(r.v).toMatch(/^enc:v1:/);
    // Probe with the whole phrases: base64 ciphertext is drawn from a random
    // IV and can contain any short letter run ("mum" did, once, in CI), but it
    // never contains a space. The one-word category is checked for exact
    // equality instead.
    const dump = JSON.stringify(raw.rows);
    for (const phrase of ["call mum about the scan", "the airport goodbye", "will you read this"]) {
      expect(dump).not.toContain(phrase);
    }
    for (const r of raw.rows) expect(r.v).not.toBe("shame");

    const [r2] = await db.select().from(remindersTable).where(eq(remindersTable.id, rem!.id));
    expect(r2!.content).toBe("call mum about the scan");
    const [t2] = await db.select().from(storyThreadsTable).where(eq(storyThreadsTable.id, thread!.id));
    expect(t2!.label).toBe("the airport goodbye");
    const [f2] = await db.select().from(memoryFeelingsTable).where(eq(memoryFeelingsTable.id, feel!.id));
    expect(f2!.category).toBe("shame");
    const [l2] = await db.select().from(leadsTable).where(eq(leadsTable.id, lead!.id));
    expect(l2!.message).toBe("will you read this");
  });

  it("the account export decrypts all three user-owned columns", async () => {
    const res = await agent.get("/api/account/export");
    expect(res.status).toBe(200);
    const body = res.body as {
      reminders: { content: string }[];
      storyThreads: { label: string }[];
      memoryFeelings: { feeling: string; category: string }[];
    };
    expect(body.reminders.map((r) => r.content)).toContain("call mum about the scan");
    expect(body.storyThreads.map((t) => t.label)).toContain("the airport goodbye");
    expect(body.memoryFeelings.map((f) => f.category)).toContain("shame");
  });

  it("legacy plaintext rows read back and the boot sweep encrypts them", async () => {
    const ins = await pool.query<{ id: number }>(
      "INSERT INTO memory_feelings (user_id, feeling, category) VALUES ($1, 'legacy feeling', 'grief') RETURNING id",
      [userId],
    );
    const [before] = await db.select().from(memoryFeelingsTable).where(eq(memoryFeelingsTable.id, ins.rows[0]!.id));
    expect(before!.category).toBe("grief"); // passthrough during the migration window

    await runDataEncryptionMigration();

    const raw = await pool.query<{ category: string; feeling: string }>("SELECT category, feeling FROM memory_feelings WHERE id = $1", [ins.rows[0]!.id]);
    expect(raw.rows[0]!.category).toMatch(/^enc:v1:/);
    expect(decryptText(raw.rows[0]!.category, "memory_feelings.category")).toBe("grief");
    expect(decryptText(raw.rows[0]!.feeling, "memory_feelings.feeling")).toBe("legacy feeling");
  });
});
