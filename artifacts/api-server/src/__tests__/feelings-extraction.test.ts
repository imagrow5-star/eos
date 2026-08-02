/**
 * DB-gated integration tests for Sprint 2C feelings-in-context extraction.
 *
 * The model's semantic judgement can't run in CI (no ANTHROPIC_API_KEY), so the
 * Haiku extraction call is stubbed (canned feelings) and the dedup decision is
 * injected as a deterministic lexical stand-in over the real rows — the same
 * pattern the dedup sprint used. This proves the insert / emotion→category /
 * intensity→weight / dedup-bump mechanics against a real database.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY ||= "test-key-unused-create-is-stubbed";
});

import pg from "pg";
import { createRequire } from "node:module";
import { db, memoryFeelingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { extractFeelings } from "../services/ai.js";
import { lexicalOverlap, type DedupFinder, type DedupEntry } from "../services/memory/dedup.js";

const DB = !!process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const TS = Date.now();
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `feelings-${tag}-${TS}-${emails.length}@example.invalid`;
  emails.push(e);
  return e;
}

async function signupUser(tag: string): Promise<number> {
  const email = nextEmail(tag);
  const r = await pool.query<{ id: number }>(
    `INSERT INTO users (email, hashed_password, email_verified_at) VALUES ($1, 'x', NOW()) RETURNING id`,
    [email],
  );
  return r.rows[0]!.id;
}

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`BEGIN; DELETE FROM memory_feelings WHERE user_id = ${uid}; DELETE FROM users WHERE id = ${uid}; COMMIT;`);
}

let createSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  const require = createRequire(import.meta.url);
  const mod = require("@anthropic-ai/sdk");
  const Anthropic = mod.default || mod.Anthropic;
  const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: "x" }).messages);
  createSpy = vi.spyOn(messagesProto, "create");
});

afterAll(async () => {
  createSpy?.mockRestore();
  await Promise.all(emails.splice(0).map(cleanupUser));
  await pool.end();
});

function stubFeelingsOnce(feelings: Array<{ feeling: string; emotion?: string; intensity?: number }>) {
  createSpy.mockResolvedValueOnce({
    content: [{ type: "text", text: JSON.stringify({ feelings }) }],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as never);
}

function profileFor(userId: number) {
  return { userId, userName: "Test", companionName: "Eos", timezone: "UTC" } as never;
}

// Deterministic dedup stand-in over the real rows.
const lexFinder: DedupFinder = async (candidate, existing) => {
  let best: DedupEntry | null = null;
  let bestScore = 0;
  for (const e of existing) {
    const s = lexicalOverlap(candidate, e.content);
    if (s > bestScore) { bestScore = s; best = e; }
  }
  if (best && bestScore >= 0.3) return { isDuplicate: true, matchingId: best.id, reasoning: "lex" };
  return { isDuplicate: false, matchingId: null, reasoning: "no" };
};

describe.skipIf(!DB)("feelings extraction", () => {
  it("inserts a feeling with emotion→category and intensity→emotional_weight", async () => {
    const userId = await signupUser("insert");
    stubFeelingsOnce([
      { feeling: "The Sunday family dinner made them feel small, the way it always does.", emotion: "shame", intensity: 0.8 },
    ]);
    await extractFeelings(profileFor(userId), [{ role: "user", content: "sunday dinner again" }], { dedupFinder: lexFinder });

    const rows = await db.select().from(memoryFeelingsTable).where(eq(memoryFeelingsTable.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.category).toBe("shame");
    expect(rows[0]!.emotionalWeight).toBeCloseTo(0.8, 5);
    expect(rows[0]!.feeling).toContain("feel small");
  });

  it("maps an unknown emotion to 'other' and a missing intensity to the 0.5 default", async () => {
    const userId = await signupUser("defaults");
    stubFeelingsOnce([{ feeling: "Something shifted after the walk and it felt unfamiliar." }]);
    await extractFeelings(profileFor(userId), [{ role: "user", content: "the walk" }], { dedupFinder: lexFinder });

    const rows = await db.select().from(memoryFeelingsTable).where(eq(memoryFeelingsTable.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.category).toBe("other");
    expect(rows[0]!.emotionalWeight).toBeCloseTo(0.5, 5);
  });

  it("dedups a re-stated feeling — bumps times_referenced instead of inserting", async () => {
    const userId = await signupUser("dedup");
    const phrasings = [
      "The Sunday family dinner made them feel small, the way it always does.",
      "Sunday dinner with the family left them feeling small again.",
      "That family dinner on Sunday made them feel small once more.",
    ];
    for (const p of phrasings) {
      stubFeelingsOnce([{ feeling: p, emotion: "shame", intensity: 0.7 }]);
      await extractFeelings(profileFor(userId), [{ role: "user", content: p }], { dedupFinder: lexFinder });
    }
    const rows = await db.select().from(memoryFeelingsTable).where(eq(memoryFeelingsTable.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.timesReferenced).toBe(3);
  });

  it("keeps genuinely distinct feelings as separate rows", async () => {
    const userId = await signupUser("distinct");
    stubFeelingsOnce([{ feeling: "Finishing the run left them quietly proud.", emotion: "pride", intensity: 0.6 }]);
    await extractFeelings(profileFor(userId), [{ role: "user", content: "the run" }], { dedupFinder: lexFinder });
    stubFeelingsOnce([{ feeling: "The empty apartment felt unbearably lonely tonight.", emotion: "loneliness", intensity: 0.9 }]);
    await extractFeelings(profileFor(userId), [{ role: "user", content: "empty apartment" }], { dedupFinder: lexFinder });

    const rows = await db.select().from(memoryFeelingsTable).where(eq(memoryFeelingsTable.userId, userId));
    expect(rows).toHaveLength(2);
  });
});
