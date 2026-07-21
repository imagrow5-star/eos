/**
 * Integration tests: voice-turn persistence dedup (the "echo" bug).
 *
 * ElevenLabs fires MULTIPLE completion requests per spoken turn — rolling ASR
 * finals revise the user's sentence (A→B→A), interruptions regenerate replies,
 * and hard double-fires land in the same second. persistVoiceTurn must:
 *   1. never write the same user turn twice within one call (since issuedAt),
 *   2. never write the same assistant reply twice within one call,
 *   3. survive CONCURRENT double-fires (per-user serialization),
 *   4. still save genuinely different regenerations (both were partly spoken),
 *   5. not confuse pre-call history with in-call turns (issuedAt boundary).
 *
 * Runs against the real dev DB. Fresh user turns feed the real extraction
 * pipeline (same as production) — contents are trivial so extractors no-op.
 */

import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import pg from "pg";
import { eq } from "drizzle-orm";
import { db, messagesTable, profileTable } from "@workspace/db";
import app from "../app.js";
import {
  persistVoiceTurn,
  openAiToolsToAnthropic,
  mergeTrailingUserTurns,
} from "../routes/voice-llm.js";
import { getOrCreateProfileForUser } from "../routes/profile.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Helpers ─────────────────────────────────────────────────────────────────

const createdEmails: string[] = [];

async function makeUser(tag: string) {
  const email = `voice-persist-${tag}-${Date.now()}@example.com`;
  createdEmails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "Password123!" });
  expect([200, 201]).toContain(res.status);

  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  const userId = r.rows[0]!.id;

  await getOrCreateProfileForUser(userId);
  await db
    .update(profileTable)
    .set({ userName: "Sam", isOnboardingComplete: true, country: "US", timezone: "UTC" })
    .where(eq(profileTable.userId, userId));
  const [profile] = await db.select().from(profileTable).where(eq(profileTable.userId, userId));
  return { userId, profile: profile! };
}

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (r.rowCount === 0) return;
  const uid = r.rows[0]!.id;
  await pool.query(`DELETE FROM messages WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM goal_tasks WHERE goal_id IN (SELECT id FROM goals WHERE user_id = ${uid})`);
  await pool.query(`DELETE FROM goals WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM habit_completions WHERE habit_id IN (SELECT id FROM habits WHERE user_id = ${uid})`);
  await pool.query(`DELETE FROM habits WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM commitments WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM personalization_state WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM email_verification_tokens WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM profile WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM users WHERE id = ${uid}`);
}

afterEach(async () => {
  while (createdEmails.length > 0) {
    await cleanupUser(createdEmails.pop()!);
  }
});

async function countRows(userId: number, role: string, content: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM messages WHERE user_id = $1 AND role = $2 AND content = $3",
    [userId, role, content],
  );
  return Number(r.rows[0]!.n);
}

// issuedAt slightly in the past so DB-vs-node clock skew can't hide in-call rows.
const callStart = () => Date.now() - 5_000;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("persistVoiceTurn — voice echo dedup", () => {
  it(
    "concurrent double-fire saves exactly one user and one assistant row",
    async () => {
      const { userId, profile } = await makeUser("concurrent");
      const issuedAt = callStart();
      const args = {
        userId,
        issuedAt,
        synthetic: false,
        userContent: "Okay.",
        fullText: "I'm right here with you.",
        profile,
      };

      const [r1, r2] = await Promise.all([persistVoiceTurn(args), persistVoiceTurn(args)]);

      expect(await countRows(userId, "user", "Okay.")).toBe(1);
      expect(await countRows(userId, "assistant", "I'm right here with you.")).toBe(1);
      // Exactly one of the two racers actually wrote each row.
      expect([r1.savedUser, r2.savedUser].filter(Boolean)).toHaveLength(1);
      expect([r1.savedAssistant, r2.savedAssistant].filter(Boolean)).toHaveLength(1);
    },
    60_000,
  );

  it(
    "ASR revisions A→B→A never re-save A (the old latest-row check missed this)",
    async () => {
      const { userId, profile } = await makeUser("revisions");
      const issuedAt = callStart();
      const base = { userId, issuedAt, synthetic: false, profile };

      await persistVoiceTurn({ ...base, userContent: "I feel tired.", fullText: "Reply one." });
      await persistVoiceTurn({ ...base, userContent: "I feel tired today.", fullText: "Reply two." });
      const r3 = await persistVoiceTurn({ ...base, userContent: "I feel tired.", fullText: "Reply three." });

      expect(r3.savedUser).toBe(false); // the A-revision resend was dropped
      expect(await countRows(userId, "user", "I feel tired.")).toBe(1);
      expect(await countRows(userId, "user", "I feel tired today.")).toBe(1);
      // All three replies were genuinely different — each was partly spoken.
      expect(await countRows(userId, "assistant", "Reply one.")).toBe(1);
      expect(await countRows(userId, "assistant", "Reply two.")).toBe(1);
      expect(await countRows(userId, "assistant", "Reply three.")).toBe(1);
    },
    60_000,
  );

  it(
    "regeneration after interruption: same user turn once, both distinct replies kept",
    async () => {
      const { userId, profile } = await makeUser("regen");
      const issuedAt = callStart();
      const base = { userId, issuedAt, synthetic: false, userContent: "Hm, alright.", profile };

      const r1 = await persistVoiceTurn({ ...base, fullText: "First take." });
      const r2 = await persistVoiceTurn({ ...base, fullText: "Second take." });

      expect(r1.savedUser).toBe(true);
      expect(r2.savedUser).toBe(false);
      expect(r2.savedAssistant).toBe(true);
      expect(await countRows(userId, "user", "Hm, alright.")).toBe(1);
      expect(await countRows(userId, "assistant", "First take.")).toBe(1);
      expect(await countRows(userId, "assistant", "Second take.")).toBe(1);
    },
    60_000,
  );

  it(
    "exact duplicate completion (same turn, same reply) is dropped entirely",
    async () => {
      const { userId, profile } = await makeUser("dupe");
      const issuedAt = callStart();
      const args = {
        userId,
        issuedAt,
        synthetic: false,
        userContent: "Yeah.",
        fullText: "Take your time.",
        profile,
      };

      await persistVoiceTurn(args);
      const r2 = await persistVoiceTurn(args);

      expect(r2.savedUser).toBe(false);
      expect(r2.savedAssistant).toBe(false);
      expect(await countRows(userId, "user", "Yeah.")).toBe(1);
      expect(await countRows(userId, "assistant", "Take your time.")).toBe(1);
    },
    60_000,
  );

  it(
    "synthetic greeting saves the assistant row only",
    async () => {
      const { userId, profile } = await makeUser("synthetic");
      const issuedAt = callStart();

      const r = await persistVoiceTurn({
        userId,
        issuedAt,
        synthetic: true,
        userContent: "(call connected)",
        fullText: "Hey, it's so good to hear you.",
        profile,
      });

      expect(r.savedUser).toBe(false);
      expect(r.savedAssistant).toBe(true);
      expect(await countRows(userId, "user", "(call connected)")).toBe(0);
      expect(await countRows(userId, "assistant", "Hey, it's so good to hear you.")).toBe(1);
    },
    60_000,
  );

  it(
    "identical text sent BEFORE the call does not block saving it during the call",
    async () => {
      const { userId, profile } = await makeUser("precall");
      // A text-chat message from an hour ago with the same content.
      await db.insert(messagesTable).values({
        userId,
        role: "user",
        content: "Good morning.",
        isMorningNote: false,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      });

      const r = await persistVoiceTurn({
        userId,
        issuedAt: callStart(),
        synthetic: false,
        userContent: "Good morning.",
        fullText: "Morning — how did you sleep?",
        profile,
      });

      expect(r.savedUser).toBe(true); // dedup is scoped to the call, not all history
      expect(await countRows(userId, "user", "Good morning.")).toBe(2);
    },
    60_000,
  );

  it(
    "skip_turn (intentionally silent reply) saves the user turn but never an empty assistant row",
    async () => {
      const { userId, profile } = await makeUser("skipturn");
      const issuedAt = callStart();

      const r1 = await persistVoiceTurn({
        userId,
        issuedAt,
        synthetic: false,
        userContent: "I just… um…",
        fullText: "", // Claude called skip_turn and wrote no text
        profile,
      });
      // ElevenLabs re-sends the turn; whitespace-only replies must also be skipped.
      const r2 = await persistVoiceTurn({
        userId,
        issuedAt,
        synthetic: false,
        userContent: "I just… um…",
        fullText: "  \n",
        profile,
      });

      expect(r1.savedUser).toBe(true);
      expect(r1.savedAssistant).toBe(false);
      expect(r2.savedUser).toBe(false);
      expect(r2.savedAssistant).toBe(false);
      expect(await countRows(userId, "user", "I just… um…")).toBe(1);
      const n = await pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM messages WHERE user_id = $1 AND role = 'assistant'",
        [userId],
      );
      expect(Number(n.rows[0]!.n)).toBe(0);
    },
    60_000,
  );
});

// ─── openAiToolsToAnthropic — pure mapping, no DB ────────────────────────────

describe("openAiToolsToAnthropic — ElevenLabs system-tool passthrough", () => {
  it("maps a function tool and defaults missing parameters to an empty object schema", () => {
    const out = openAiToolsToAnthropic([
      { type: "function", function: { name: "skip_turn", description: "Skip the turn." } },
    ]);
    expect(out).toEqual([
      {
        name: "skip_turn",
        description: "Skip the turn.",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  it("keeps provided JSON-schema parameters as input_schema", () => {
    const params = { type: "object", properties: { reason: { type: "string" } } };
    const out = openAiToolsToAnthropic([
      { type: "function", function: { name: "skip_turn", parameters: params } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.input_schema).toEqual(params);
  });

  it("drops malformed and non-function entries", () => {
    expect(openAiToolsToAnthropic(undefined)).toEqual([]);
    expect(openAiToolsToAnthropic("nope")).toEqual([]);
    expect(
      openAiToolsToAnthropic([
        { type: "retrieval" },
        { type: "function" },
        { type: "function", function: { name: "" } },
        null,
      ]),
    ).toEqual([]);
  });

  it("drops tools not on the system-tool allowlist (endpoint is internet-facing)", () => {
    expect(
      openAiToolsToAnthropic([
        { type: "function", function: { name: "delete_everything" } },
        { type: "function", function: { name: "end_call" } }, // not allowlisted until deliberately supported
        { type: "function", function: { name: "skip_turn" } },
      ]).map((t) => t.name),
    ).toEqual(["skip_turn"]);
  });
});

// ─── mergeTrailingUserTurns — model content vs persisted content ─────────────

describe("mergeTrailingUserTurns — consecutive user turns after skip_turn", () => {
  it("folds trailing user turns into the model-facing content only", () => {
    const { context, content } = mergeTrailingUserTurns(
      [
        { role: "assistant", content: "I'm here." },
        { role: "user", content: "I keep thinking about her and…" },
      ],
      "sorry. It's been a hard week.",
    );
    expect(content).toBe("I keep thinking about her and…\nsorry. It's been a hard week.");
    expect(context).toEqual([{ role: "assistant", content: "I'm here." }]);
  });

  it("handles multiple silent turns (A, B stacked before fresh C)", () => {
    const { context, content } = mergeTrailingUserTurns(
      [
        { role: "user", content: "A" },
        { role: "user", content: "B" },
      ],
      "C",
    );
    expect(content).toBe("A\nB\nC");
    expect(context).toEqual([]);
  });

  it("leaves content and context untouched when context ends with assistant", () => {
    const ctx = [
      { role: "user" as const, content: "Hi." },
      { role: "assistant" as const, content: "Hey you." },
    ];
    const { context, content } = mergeTrailingUserTurns(ctx, "How was your day?");
    expect(content).toBe("How was your day?");
    expect(context).toEqual(ctx);
    expect(ctx).toHaveLength(2); // input not mutated
  });
});
