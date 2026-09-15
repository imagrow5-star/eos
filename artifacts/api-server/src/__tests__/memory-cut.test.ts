/**
 * Memory cut measurement (memory research, PR 8) — instrumentation only.
 *
 *   • memoryCutReport counts, above and below the top-40 cut, the facts a
 *     message and a reply reference (same lexical check as the importance
 *     scorer); no memory accounting ⇒ null;
 *   • buildSystemPrompt hands the included/excluded fact text to the caller
 *     and a person with more than 40 facts gets a real cut;
 *   • the chat route and the voice route each log one "memory cut" line per
 *     turn with the hashed id and numbers only — never a fact — and the
 *     person mentioning a below-cut fact shows up as userHitsBelowCut.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { logger } from "../lib/logger.js";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { memoryCutReport } from "../services/memory/cutReport.js";
import { buildSystemPrompt } from "../services/systemPrompt.js";
import { getOrCreateProfileForUser } from "../routes/profile.js";
import { db, memoryFactsTable } from "@workspace/db";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

const priorSalt = process.env.LOG_HASH_SALT;
beforeAll(() => {
  process.env.LOG_HASH_SALT = "memory-cut-test-salt";
});
afterAll(async () => {
  if (priorSalt === undefined) delete process.env.LOG_HASH_SALT;
  else process.env.LOG_HASH_SALT = priorSalt;
  for (const email of emails) {
    const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
    if (!r.rowCount) continue;
    const uid = r.rows[0]!.id;
    await pool.query(`
      BEGIN;
      DELETE FROM memory_facts              WHERE user_id = ${uid};
      DELETE FROM user_sessions             WHERE sess::jsonb->>'userId' = '${uid}';
      DELETE FROM email_verification_tokens WHERE user_id = ${uid};
      DELETE FROM messages                  WHERE user_id = ${uid};
      DELETE FROM profile                   WHERE user_id = ${uid};
      DELETE FROM users                     WHERE id      = ${uid};
      COMMIT;
    `);
  }
  await pool.end();
});

/** 40 fresh, well-referenced facts (they make the cut) + 3 old, never
 *  referenced ones with distinctive words (they don't). */
async function seedFacts(userId: number) {
  const now = Date.now();
  const kept = Array.from({ length: 40 }, (_, i) => ({
    userId,
    fact: `enjoys the weekly pottery class number ${i + 1} on Thursdays`,
    category: "life",
    createdAt: new Date(now - i * 60_000),
    timesReferenced: 6,
    lastReferencedAt: new Date(now - i * 60_000),
    emotionalWeight: 0.6,
  }));
  const dropped = ["went kayaking in Lisbon last spring", "bakes sourdough on Sundays", "cousin Ferdinand keeps bees"].map((fact, i) => ({
    userId,
    fact,
    category: "life",
    createdAt: new Date(now - (400 + i) * 86_400_000),
    timesReferenced: 1,
    lastReferencedAt: new Date(now - (400 + i) * 86_400_000),
    emotionalWeight: 0,
  }));
  await db.insert(memoryFactsTable).values([...kept, ...dropped]);
}

async function makeUser(tag: string) {
  const email = `memory-cut-${tag}-${Date.now()}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  expect((await agent.get("/api/profile")).status).toBe(200);
  await seedFacts(userId);
  return { userId, agent };
}

type LogCall = [Record<string, unknown>, string];
function cutLines(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return (spy.mock.calls as unknown as LogCall[]).filter((c) => c[1] === "memory cut").map((c) => c[0]);
}

describe("memoryCutReport", () => {
  const parts = {
    stable: "",
    context: "",
    memory: {
      eligible: 3,
      included: ["her sister Maya lives in Leeds"],
      excluded: ["the allotment flooded in March", "prefers oat milk in coffee"],
    },
  };

  it("counts references above and below the cut for the message and the reply", () => {
    expect(memoryCutReport(parts, "the allotment is finally dry again", "Maya would love that, and the allotment too")).toEqual({
      eligible: 3,
      included: 1,
      excluded: 2,
      userHitsAboveCut: 0,
      userHitsBelowCut: 1,
      replyHitsAboveCut: 1,
      replyHitsBelowCut: 1,
    });
  });

  it("is zero on no overlap, and null without memory accounting", () => {
    expect(memoryCutReport(parts, "hello there", "hi")).toMatchObject({ userHitsAboveCut: 0, userHitsBelowCut: 0, replyHitsAboveCut: 0, replyHitsBelowCut: 0 });
    expect(memoryCutReport({ stable: "", context: "" }, "the allotment", "the allotment")).toBeNull();
  });
});

describe("buildSystemPrompt memory accounting", () => {
  it("keeps 40 of 43 and names the three old facts as excluded", async () => {
    const { userId } = await makeUser("prompt");
    const profile = await getOrCreateProfileForUser(userId);
    const parts = await buildSystemPrompt(profile, 1);
    expect(parts.memory).toBeDefined();
    expect(parts.memory!.eligible).toBe(43);
    expect(parts.memory!.included).toHaveLength(40);
    expect(parts.memory!.excluded.sort()).toEqual(["bakes sourdough on Sundays", "cousin Ferdinand keeps bees", "went kayaking in Lisbon last spring"]);
    // The prompt itself carries only the included ones.
    expect(parts.context).toContain("pottery class number 1 ");
    expect(parts.context).not.toContain("kayaking");
  });
});

describe("one 'memory cut' line per turn", () => {
  it("chat: numbers and hashed id only; the person mentioning a dropped fact is a below-cut hit", async () => {
    const { userId, agent } = await makeUser("chat");
    const spy = vi.spyOn(logger, "info");
    try {
      const res = await agent.post("/api/chat/send").send({ content: "I keep thinking about that kayaking trip" });
      expect(res.status).toBe(200);
      const lines = cutLines(spy);
      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      expect(line).toMatchObject({
        callType: "chat",
        eligible: 43,
        included: 40,
        excluded: 3,
        userHitsAboveCut: 0,
        userHitsBelowCut: 1,
      });
      expect(typeof line.uh).toBe("string");
      expect(line.uh).not.toBe(String(userId));
      for (const k of ["replyHitsAboveCut", "replyHitsBelowCut"]) expect(typeof line[k], k).toBe("number");
      const serialized = JSON.stringify(line);
      expect(serialized).not.toMatch(/kayaking|pottery|sourdough|Ferdinand/i);
      expect(Object.keys(line).sort()).toEqual(
        ["uh", "callType", "eligible", "included", "excluded", "userHitsAboveCut", "userHitsBelowCut", "replyHitsAboveCut", "replyHitsBelowCut"].sort(),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("voice: the same line from the live call route, through the frozen prompt", async () => {
    const { userId } = await makeUser("voice");
    const token = mintVoiceToken(userId);
    const spy = vi.spyOn(logger, "info");
    try {
      const res = await request(app)
        .post("/api/voice-llm/v1/chat/completions")
        .send({
          model: "gpt-4o",
          stream: false,
          messages: [{ role: "user", content: "my cousin Ferdinand rang about the bees" }],
          elevenlabs_extra_body: { user_token: token },
        });
      expect(res.status).toBe(200);
      const lines = cutLines(spy);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ callType: "voice", eligible: 43, included: 40, excluded: 3, userHitsBelowCut: 1 });
      expect(JSON.stringify(lines[0])).not.toMatch(/Ferdinand|bees|pottery/i);
    } finally {
      spy.mockRestore();
    }
    // The turn persists after replying; wait so cleanup never races it.
    for (let i = 0; i < 40; i++) {
      const n = Number((await pool.query("SELECT count(*) AS n FROM messages WHERE user_id = $1", [userId])).rows[0].n);
      if (n >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});
