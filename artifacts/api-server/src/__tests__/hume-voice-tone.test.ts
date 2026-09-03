/**
 * Hume voice-tone injection — end-to-end through the shared handler.
 *
 * streamCompanionReply is mocked (everything else in services/ai stays
 * real) to capture the MODEL-facing user content, proving the tone line is
 * appended there and only there: it must reach the model, must never be
 * persisted to chat history, and must be absent when the turn carries no
 * prosody. Lives in its own file so the mock can't bleed into the other
 * Hume tests, which rely on the real dev-mock reply path.
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import pg from "pg";
import { eq } from "drizzle-orm";
import { db, messagesTable } from "@workspace/db";

const capturedUserContent: string[] = [];

vi.mock("../services/ai.js", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    streamCompanionReply: vi.fn(
      async (
        _system: unknown,
        _context: unknown,
        userContent: string,
        _stage: unknown,
        onChunk: (c: string) => void,
      ) => {
        capturedUserContent.push(userContent);
        onChunk("okay.");
        return { text: "okay.", degraded: false };
      },
    ),
  };
});

import app from "../app.js";
import { mintVoiceToken } from "../lib/voiceToken.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `humetone-${tag}-${Date.now()}-${emails.length}@example.invalid`;
  emails.push(e);
  return e;
}

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

async function signupUser(tag: string) {
  const email = nextEmail(tag);
  const res = await request(app).post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(res.status).toBe(201);
  return { userId: res.body.user.id as number, email };
}

async function persistedUserRows(userId: number): Promise<string[]> {
  const rows = await db
    .select({ role: messagesTable.role, content: messagesTable.content })
    .from(messagesTable)
    .where(eq(messagesTable.userId, userId))
    .orderBy(messagesTable.id);
  return rows.filter((r) => r.role === "user").map((r) => r.content);
}

async function waitFor(pred: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function postTurn(userId: number, messages: unknown[]) {
  return request(app)
    .post("/api/hume-llm/v1/chat/completions")
    .set("Content-Type", "application/json")
    .set("Authorization", `Bearer ${mintVoiceToken(userId)}`)
    .send(JSON.stringify({ messages, model: "eos", stream: true }));
}

// The frustrated-turn capture's dominant scores, verbatim.
const FRUSTRATED = { scores: { Anger: 0.205, Determination: 0.165, Contempt: 0.158, Amusement: 0.149, Joy: 0.037 } };

afterAll(async () => {
  for (const email of emails) await cleanupUser(email);
  await pool.end();
});

describe("voice-tone injection", () => {
  it("prosody on the fresh turn → tone line reaches the model, never the persisted history", async () => {
    const { userId, email } = await signupUser("inject");
    const res = await postTurn(userId, [
      {
        role: "user",
        content: "that's not the answer I needed",
        models: { prosody: FRUSTRATED },
        time: { begin: 100, end: 2200 },
      },
    ]);
    expect(res.status).toBe(200);

    const modelFacing = capturedUserContent[capturedUserContent.length - 1]!;
    expect(modelFacing).toContain("that's not the answer I needed");
    expect(modelFacing).toContain("(voice tone: anger, determination, contempt)");

    await waitFor(async () => (await persistedUserRows(userId)).length > 0);
    const persisted = await persistedUserRows(userId);
    expect(persisted).toEqual(["that's not the answer I needed"]);
    expect(persisted.join("\n")).not.toContain("(voice tone:");
    await cleanupUser(email);
  });

  it("no prosody (Hume instruction turn / text input) → no tone line at all", async () => {
    const { userId, email } = await signupUser("noprosody");
    const before = capturedUserContent.length;
    const res = await postTurn(userId, [
      { role: "user", content: "hello there", models: { prosody: null }, time: { begin: 0, end: 0 } },
    ]);
    expect(res.status).toBe(200);
    const modelFacing = capturedUserContent[capturedUserContent.length - 1]!;
    expect(capturedUserContent.length).toBeGreaterThan(before);
    expect(modelFacing).toContain("hello there");
    expect(modelFacing).not.toContain("(voice tone:");
    await waitFor(async () => (await persistedUserRows(userId)).length > 0);
    await cleanupUser(email);
  });
});
