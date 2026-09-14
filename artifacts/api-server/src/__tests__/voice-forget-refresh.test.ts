/**
 * Memory audit, item 3 — a forgotten memory leaves a live voice call on the
 * next turn.
 *
 * A call freezes its system prompt (services/voicePromptCache.ts). Forgetting
 * a fact, starring one, the founder reset, and an in-conversation update or
 * retire all drop that person's frozen prompts, so the very next spoken turn
 * rebuilds from the database. Both pages promise exactly this wording.
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { db, memoryFactsTable } from "@workspace/db";
import app from "../app.js";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { peekFrozenSystem, invalidateFrozenSystem, setFrozenSystem, getFrozenSystem } from "../services/voicePromptCache.js";
import { supersedeFact, retireFacts } from "../services/ai.js";

const DB = Boolean(process.env.DATABASE_URL);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

afterAll(async () => {
  for (const email of emails) {
    const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
    if (!r.rowCount) continue;
    const uid = r.rows[0]!.id;
    await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1`, [String(uid)]);
    for (const t of ["messages", "memory_facts", "email_verification_tokens", "profile"]) {
      await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [uid]);
    }
    await pool.query("DELETE FROM users WHERE id = $1", [uid]);
  }
  await pool.end();
});

async function makeUser(tag: string) {
  const email = `voice-forget-${tag}-${Date.now()}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  await agent.get("/api/profile");
  await pool.query("UPDATE profile SET is_onboarding_complete = TRUE WHERE user_id = $1", [userId]);
  return { agent, userId };
}

const turn = (token: string, content: string) =>
  request(app)
    .post("/api/voice-llm/v1/chat/completions")
    .send({ stream: false, messages: [{ role: "user", content }], elevenlabs_extra_body: { user_token: token } });

describe("voicePromptCache", () => {
  it("drops only that person's frozen prompts", () => {
    const parts = { stable: "s", context: "c" };
    setFrozenSystem(1, 100, { parts, toneExtra: "" });
    setFrozenSystem(1, 200, { parts, toneExtra: "" });
    setFrozenSystem(2, 100, { parts, toneExtra: "" });
    expect(invalidateFrozenSystem(1)).toBe(2);
    expect(peekFrozenSystem(1, 100)).toBeNull();
    expect(peekFrozenSystem(2, 100)).not.toBeNull();
    expect(getFrozenSystem(2, 100)).not.toBeNull();
    invalidateFrozenSystem(2);
  });
});

describe.skipIf(!DB)("a forget during a voice call", () => {
  it("leaves the frozen prompt and the next turn's prompt", async () => {
    const { agent, userId } = await makeUser("forget");
    const [row] = await db.insert(memoryFactsTable).values({ userId, fact: "Keeps bees on the roof", category: "interest" }).returning({ id: memoryFactsTable.id });
    const token = mintVoiceToken(userId);
    const issuedAt = Number(token.split(".")[1]);

    expect((await turn(token, "hello there")).status).toBe(200);
    const frozen = peekFrozenSystem(userId, issuedAt);
    expect(frozen).not.toBeNull();
    expect(frozen!.parts.context).toContain("Keeps bees on the roof");

    const del = await agent.delete(`/api/memory/facts/${row!.id}`);
    expect(del.status).toBe(200);
    expect(peekFrozenSystem(userId, issuedAt)).toBeNull();

    expect((await turn(token, "are you still there")).status).toBe(200);
    const rebuilt = peekFrozenSystem(userId, issuedAt);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt!.parts.context).not.toContain("Keeps bees on the roof");
  }, 30_000);

  it("the star, an update and a retire drop it too", async () => {
    const { agent, userId } = await makeUser("writes");
    const [row] = await db.insert(memoryFactsTable).values({ userId, fact: "Lives in London", category: "life" }).returning({ id: memoryFactsTable.id });
    const token = mintVoiceToken(userId);
    const issuedAt = Number(token.split(".")[1]);

    await turn(token, "hello");
    expect(peekFrozenSystem(userId, issuedAt)).not.toBeNull();
    expect((await agent.patch(`/api/memory/facts/${row!.id}`).send({ userMarkedImportant: true })).status).toBe(200);
    expect(peekFrozenSystem(userId, issuedAt)).toBeNull();

    await turn(token, "hello again");
    expect(peekFrozenSystem(userId, issuedAt)!.parts.context).toContain("Lives in London");
    expect(await supersedeFact(userId, row!.id, { fact: "Lives in Berlin now", category: "life" })).toBe(true);
    expect(peekFrozenSystem(userId, issuedAt)).toBeNull();

    await turn(token, "and again");
    expect(peekFrozenSystem(userId, issuedAt)!.parts.context).toContain("Lives in Berlin now");
    expect(await retireFacts(userId, [row!.id])).toBe(1);
    expect(peekFrozenSystem(userId, issuedAt)).toBeNull();
  }, 30_000);
});

describe("the pages say exactly what the code does", () => {
  const CLAUSE = "It's gone from every conversation immediately, and within one turn during a live voice call.";
  const NOTE = "replaces the old one; a memory that's no longer";
  it("security page and in-app privacy page carry both sentences", () => {
    const security = readFileSync(fileURLToPath(new URL("../../../aanya/public/security.html", import.meta.url)), "utf8");
    const privacy = readFileSync(fileURLToPath(new URL("../../../aanya/src/pages/Privacy.tsx", import.meta.url)), "utf8").replace(/\s+/g, " ");
    expect(security).toContain(CLAUSE);
    expect(security).toContain(NOTE);
    expect(privacy).toContain(CLAUSE);
    expect(privacy).toContain(NOTE);
  });
});
