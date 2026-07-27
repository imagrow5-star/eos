/**
 * Message length cap (cost guard — review finding "cost safety").
 *
 * SendMessageBody.content is bounded at 4000 characters so a single request
 * can never inflate a paid Claude prompt with a megabyte of text (the JSON
 * body limit is 1 MB for the voice transcript endpoint's sake). The cap lives
 * in lib/api-spec/openapi.yaml (MessageInput.maxLength) with the generated
 * zod schema kept in sync by hand.
 *
 * Boundary checks run against the schema directly (no HTTP, no AI cost);
 * one integration test proves the route surfaces the friendly message.
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { SendMessageBody } from "@workspace/api-zod";
import app from "../app.js";

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
    DELETE FROM profile  WHERE user_id = ${uid};
    DELETE FROM users    WHERE id      = ${uid};
    COMMIT;
  `);
}

afterAll(async () => {
  await Promise.all(emails.splice(0).map(cleanupUser));
  await pool.end();
});

describe("chat message length cap", () => {
  it("accepts exactly 4000 characters and rejects 4001 (schema boundary)", () => {
    expect(SendMessageBody.safeParse({ content: "a".repeat(4000) }).success).toBe(true);
    const over = SendMessageBody.safeParse({ content: "a".repeat(4001) });
    expect(over.success).toBe(false);
    if (!over.success) {
      expect(over.error.issues[0]?.message).toMatch(/too long/i);
    }
  });

  it("still rejects empty messages with the friendly wording", () => {
    const empty = SendMessageBody.safeParse({ content: "" });
    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(empty.error.issues[0]?.message).toMatch(/even a word/i);
    }
  });

  it("returns a friendly 400 from the chat routes for an oversized message", async () => {
    const email = `msg-len-${Date.now()}@example.invalid`;
    emails.push(email);
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(signup.status).toBe(201);
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [
      signup.body.user.id,
    ]);

    const big = "a".repeat(4001);

    const sendRes = await agent.post("/api/chat/send").send({ content: big });
    expect(sendRes.status).toBe(400);
    expect(sendRes.body.error).toMatch(/too long/i);
    expect(sendRes.body.error).toMatch(/4,000/);

    // The streaming route rejects BEFORE opening the SSE stream, so clients
    // get a plain JSON error they can render.
    const streamRes = await agent.post("/api/chat/stream").send({ content: big });
    expect(streamRes.status).toBe(400);
    expect(streamRes.headers["content-type"]).toMatch(/application\/json/);
    expect(streamRes.body.error).toMatch(/too long/i);

    // Nothing was written: the oversized text never became a message row.
    const rows = await pool.query(`SELECT COUNT(*)::int AS n FROM messages WHERE user_id = $1`, [
      signup.body.user.id,
    ]);
    expect(rows.rows[0]!.n).toBe(0);
  });
});
