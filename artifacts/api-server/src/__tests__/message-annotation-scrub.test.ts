/**
 * Boot scrub for EVI {expression} annotations in persisted messages
 * (services/messageAnnotationScrub.ts). Rows are written through drizzle so
 * content is encrypted at rest exactly like production; the scrub must
 * decrypt, strip, and rewrite only the rows that need it — and must never
 * blank an annotation-only message or touch assistant rows / fresh rows
 * past the cutoff.
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { eq, asc } from "drizzle-orm";
import { db, messagesTable } from "@workspace/db";
import app from "../app.js";
import { scrubMessageAnnotations } from "../services/messageAnnotationScrub.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM email_verification_tokens WHERE user_id = ${uid};
    DELETE FROM messages WHERE user_id = ${uid};
    DELETE FROM profile WHERE user_id = ${uid};
    DELETE FROM users   WHERE id      = ${uid};
    COMMIT;
  `);
}

async function signupUserId(tag: string): Promise<number> {
  const email = `annot-scrub-${tag}-${Date.now()}@example.invalid`;
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(res.status).toBe(201);
  return res.body.user.id as number;
}

afterAll(async () => {
  for (const email of emails) await cleanupUser(email);
  await pool.end();
});

describe("scrubMessageAnnotations", () => {
  it("strips braces from old user rows; leaves assistant, clean, annotation-only, and fresh rows alone", async () => {
    const userId = await signupUserId("mix");
    const old = new Date("2026-09-03T12:00:00Z");
    const fresh = new Date("2026-09-10T12:00:00Z"); // past the cutoff
    const rows = [
      { role: "user", content: "Rato. {very slightly excited, very slightly amused}", createdAt: old },
      { role: "user", content: "hola {calm} como estas {curious}", createdAt: old },
      { role: "user", content: "a clean message", createdAt: old },
      { role: "user", content: "{only annotation}", createdAt: old }, // never blanked
      { role: "assistant", content: "Claro. {literal assistant braces}", createdAt: old },
      { role: "user", content: "fresh {should not be touched}", createdAt: fresh },
    ];
    for (const r of rows) await db.insert(messagesTable).values({ userId, ...r });

    const scrubbed = await scrubMessageAnnotations();
    expect(scrubbed).toBeGreaterThanOrEqual(2);

    const after = await db
      .select({ role: messagesTable.role, content: messagesTable.content })
      .from(messagesTable)
      .where(eq(messagesTable.userId, userId))
      .orderBy(asc(messagesTable.id));
    expect(after.map((r) => r.content)).toEqual([
      "Rato.",
      "hola como estas",
      "a clean message",
      "{only annotation}",
      "Claro. {literal assistant braces}",
      "fresh {should not be touched}",
    ]);

    // The stored bytes are ciphertext — the scrub wrote through encryption.
    const raw = await pool.query<{ content: string }>(
      "SELECT content FROM messages WHERE user_id = $1 ORDER BY id LIMIT 1",
      [userId],
    );
    expect(raw.rows[0]!.content).not.toBe("Rato.");

    // Idempotent: a second pass changes nothing.
    expect(await scrubMessageAnnotations()).toBe(0);
  });
});
