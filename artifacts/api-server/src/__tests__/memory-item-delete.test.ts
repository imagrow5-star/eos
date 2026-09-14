/**
 * Memory audit, item 4 — forgetting one feeling, win, mood day or
 * personality signal. Each is a hard delete of one row, ownership-checked,
 * 404 for a row that isn't yours, and it drops the person's frozen voice
 * prompt so a live call rebuilds on its next turn.
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { db, memoryFeelingsTable, winsTable, moodScoresTable, personalitySignalsTable } from "@workspace/db";
import app from "../app.js";
import { setFrozenSystem, peekFrozenSystem } from "../services/voicePromptCache.js";

const DB = Boolean(process.env.DATABASE_URL);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

afterAll(async () => {
  for (const email of emails) {
    const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
    if (!r.rowCount) continue;
    const uid = r.rows[0]!.id;
    await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1`, [String(uid)]);
    for (const t of ["memory_feelings", "wins", "mood_scores", "personality_signals", "email_verification_tokens", "profile"]) {
      await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [uid]);
    }
    await pool.query("DELETE FROM users WHERE id = $1", [uid]);
  }
  await pool.end();
});

async function makeUser(tag: string) {
  const email = `item-delete-${tag}-${Date.now()}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  await agent.get("/api/profile");
  return { agent, userId };
}

describe.skipIf(!DB)("forget one item", () => {
  it("feelings, wins, mood days and signals: own rows go, and the frozen voice prompt drops", async () => {
    const { agent, userId } = await makeUser("own");
    const [feeling] = await db.insert(memoryFeelingsTable).values({ userId, feeling: "The run left a quiet pride behind.", category: "pride" }).returning({ id: memoryFeelingsTable.id });
    const [win] = await db.insert(winsTable).values({ userId, content: "I called Mum back" }).returning({ id: winsTable.id });
    await db.insert(moodScoresTable).values({ userId, score: 6, date: "2026-09-10" });
    const [signal] = await db.insert(personalitySignalsTable).values({ userId, signal: "Opens up slowly", observedCount: 3, isActive: true }).returning({ id: personalitySignalsTable.id });

    const parts = { stable: "s", context: "c" };
    const cases: Array<[string, string]> = [
      ["feelings", `/api/memory/feelings/${feeling!.id}`],
      ["wins", `/api/memory/wins/${win!.id}`],
      ["moods", `/api/memory/moods/2026-09-10`],
      ["signals", `/api/memory/signals/${signal!.id}`],
    ];
    for (const [name, path] of cases) {
      setFrozenSystem(userId, 1000, { parts, toneExtra: "" });
      const res = await agent.delete(path);
      expect(res.status, name).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(peekFrozenSystem(userId, 1000), name).toBeNull();
      expect((await agent.delete(path)).status, `${name} again`).toBe(404);
    }
    expect((await agent.get("/api/memory/feelings")).body).toEqual([]);
    expect((await agent.get("/api/memory/wins")).body).toEqual([]);
    expect((await agent.get("/api/memory/signals")).body).toEqual([]);
    expect((await agent.get("/api/journey/mood")).body).toEqual([]);
  });

  it("someone else's row is not found, and bad ids are refused", async () => {
    const owner = await makeUser("owner");
    const other = await makeUser("other");
    const [feeling] = await db.insert(memoryFeelingsTable).values({ userId: other.userId, feeling: "Theirs, not yours.", category: "other" }).returning({ id: memoryFeelingsTable.id });
    const [win] = await db.insert(winsTable).values({ userId: other.userId, content: "Their win" }).returning({ id: winsTable.id });
    await db.insert(moodScoresTable).values({ userId: other.userId, score: 4, date: "2026-09-11" });
    const [signal] = await db.insert(personalitySignalsTable).values({ userId: other.userId, signal: "Their signal", observedCount: 1 }).returning({ id: personalitySignalsTable.id });

    expect((await owner.agent.delete(`/api/memory/feelings/${feeling!.id}`)).status).toBe(404);
    expect((await owner.agent.delete(`/api/memory/wins/${win!.id}`)).status).toBe(404);
    expect((await owner.agent.delete(`/api/memory/moods/2026-09-11`)).status).toBe(404);
    expect((await owner.agent.delete(`/api/memory/signals/${signal!.id}`)).status).toBe(404);
    expect((await owner.agent.delete(`/api/memory/feelings/abc`)).status).toBe(400);
    expect((await owner.agent.delete(`/api/memory/moods/yesterday`)).status).toBe(400);

    expect((await other.agent.get("/api/memory/feelings")).body).toHaveLength(1);
    expect((await other.agent.get("/api/memory/wins")).body).toHaveLength(1);
    expect((await other.agent.get("/api/memory/signals")).body).toHaveLength(1);
    expect((await other.agent.get("/api/journey/mood")).body).toHaveLength(1);
  });
});
