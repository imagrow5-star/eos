/**
 * Phase B — field-level encryption at rest.
 *
 * Proves the founder's non-negotiable: every feature behaves byte-for-byte
 * identically, while nothing readable sits in the database:
 *   • crypto primitives (roundtrip, tamper/wrong-AAD refusal, passthrough)
 *   • rows written through the app are ciphertext at rest, plaintext via API
 *   • the chapters verbatim-quote gate validates against DECRYPTED content
 *   • the forget-this cascade works end-to-end on encrypted rows
 *   • the boot migration encrypts pre-existing plaintext with
 *     verify-before-commit semantics, idempotently
 *   • the account export decrypts everything back to readable plaintext
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { eq } from "drizzle-orm";
import app from "../app.js";
import {
  db,
  messagesTable,
  memoryFactsTable,
  personalizationStateTable,
  storyThreadsTable,
  encryptText,
  decryptText,
  encryptJson,
  decryptJson,
  encryptTextArray,
  decryptTextArray,
  isEncrypted,
  DataEncryptionError,
} from "@workspace/db";
import { runDataEncryptionMigration } from "../services/dataEncryptionMigration.js";
import { validateExcerpt, type QuoteSource } from "../services/chapters/quotes.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Helpers (self-contained per-file, same pattern as privacy-phase-a) ──────

const TS = Date.now();
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `dataenc-${tag}-${TS}-${emails.length}@example.invalid`;
  emails.push(e);
  return e;
}

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions              WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM email_verification_tokens  WHERE user_id = ${uid};
    DELETE FROM chapter_quote_dismissals   WHERE user_id = ${uid};
    DELETE FROM chapter_offer_events       WHERE user_id = ${uid};
    DELETE FROM sealed_notes               WHERE user_id = ${uid};
    DELETE FROM weekly_chapters            WHERE user_id = ${uid};
    DELETE FROM story_threads              WHERE user_id = ${uid};
    DELETE FROM personalization_state      WHERE user_id = ${uid};
    DELETE FROM personality_signals        WHERE user_id = ${uid};
    DELETE FROM memory_facts               WHERE user_id = ${uid};
    DELETE FROM wins                       WHERE user_id = ${uid};
    DELETE FROM mood_scores                WHERE user_id = ${uid};
    DELETE FROM messages                   WHERE user_id = ${uid};
    DELETE FROM profile                    WHERE user_id = ${uid};
    DELETE FROM users                      WHERE id      = ${uid};
    COMMIT;
  `);
}

async function signupUser(tag: string) {
  const email = nextEmail(tag);
  const agent = request.agent(app);
  const signupRes = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signupRes.status).toBe(201);
  const userId: number = signupRes.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  const prof = await agent.get("/api/profile");
  expect(prof.status).toBe(200);
  return { agent, userId, email };
}

afterAll(async () => {
  for (const email of emails) await cleanupUser(email);
  await pool.end();
});

// ─── 1. Crypto primitives ─────────────────────────────────────────────────────

describe("crypto primitives", () => {
  const AAD = "test.column";

  it("round-trips text, unicode, and the empty string", () => {
    for (const pt of ["hello", "Ich vermisse dich so sehr — 💔 数据加密", ""]) {
      const ct = encryptText(pt, AAD);
      expect(ct.startsWith("enc:v1:")).toBe(true);
      expect(ct).not.toContain(pt.length > 0 ? pt : "\u0000");
      expect(decryptText(ct, AAD)).toBe(pt);
    }
  });

  it("produces a different ciphertext every time (random IV)", () => {
    expect(encryptText("same words", AAD)).not.toBe(encryptText("same words", AAD));
  });

  it("passes plaintext through decrypt unchanged (migration window)", () => {
    expect(decryptText("just some old plaintext", AAD)).toBe("just some old plaintext");
    expect(decryptJson<{ a: number }>({ a: 1 }, AAD)).toEqual({ a: 1 });
    expect(decryptTextArray(["plain", "old"], AAD)).toEqual(["plain", "old"]);
  });

  it("refuses tampered ciphertext loudly (never returns garbage)", () => {
    const ct = encryptText("the truth", AAD);
    const raw = Buffer.from(ct.slice("enc:v1:".length), "base64");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    const tampered = "enc:v1:" + raw.toString("base64");
    expect(() => decryptText(tampered, AAD)).toThrow(DataEncryptionError);
  });

  it("binds ciphertext to its column via AAD", () => {
    const ct = encryptText("secret", "messages.content");
    expect(() => decryptText(ct, "memory_facts.fact")).toThrow(DataEncryptionError);
  });

  it("round-trips JSON and string arrays", () => {
    const obj = { quotes: [{ messageId: 7, text: "I said this, verbatim." }], n: 3 };
    expect(decryptJson(encryptJson(obj, AAD), AAD)).toEqual(obj);
    const arr = ["that sounds heavy", "I hear you"];
    const enc = encryptTextArray(arr, AAD);
    expect(enc.every((e) => isEncrypted(e))).toBe(true);
    expect(decryptTextArray(enc, AAD)).toEqual(arr);
  });
});

// ─── 2. Encrypted at rest, plaintext through the app ─────────────────────────

describe("app writes are ciphertext at rest, plaintext via API", () => {
  it("messages, facts, wins, profile name, recent phrases", async () => {
    const { agent, userId } = await signupUser("atrest");

    // message through the ORM (same path chat/voice/onboarding use)
    const MSG = "I keep replaying the last conversation we had.";
    await db.insert(messagesTable).values({ userId, role: "user", content: MSG, isMorningNote: false });
    const rawMsg = await pool.query<{ content: string }>(
      "SELECT content FROM messages WHERE user_id = $1",
      [userId],
    );
    expect(rawMsg.rows[0]!.content).toMatch(/^enc:v1:/);
    expect(rawMsg.rows[0]!.content).not.toContain("replaying");
    const apiMsgs = await agent.get("/api/chat/messages");
    expect(apiMsgs.status).toBe(200);
    expect(JSON.stringify(apiMsgs.body)).toContain(MSG);

    // memory fact
    const FACT = "has a sister named Mia who calls every Sunday";
    await db.insert(memoryFactsTable).values({ userId, fact: FACT, category: "person" });
    const rawFact = await pool.query<{ fact: string }>(
      "SELECT fact FROM memory_facts WHERE user_id = $1",
      [userId],
    );
    expect(rawFact.rows[0]!.fact).toMatch(/^enc:v1:/);
    const apiFacts = await agent.get("/api/memory/facts");
    expect(JSON.stringify(apiFacts.body)).toContain("sister named Mia");

    // win through the real route (full write path)
    const winRes = await agent.post("/api/memory/wins").send({ content: "went outside for a walk today" });
    expect(winRes.status).toBe(201);
    const rawWin = await pool.query<{ content: string }>("SELECT content FROM wins WHERE user_id = $1", [userId]);
    expect(rawWin.rows[0]!.content).toMatch(/^enc:v1:/);
    const apiWins = await agent.get("/api/memory/wins");
    expect(JSON.stringify(apiWins.body)).toContain("went outside for a walk");

    // profile name through the real route
    const putRes = await agent.put("/api/profile").send({ userName: "Cipher Test Name" });
    expect(putRes.status).toBe(200);
    const rawName = await pool.query<{ user_name: string }>(
      "SELECT user_name FROM profile WHERE user_id = $1",
      [userId],
    );
    expect(rawName.rows[0]!.user_name).toMatch(/^enc:v1:/);
    const apiProf = await agent.get("/api/profile");
    expect(JSON.stringify(apiProf.body)).toContain("Cipher Test Name");

    // anti-repetition phrase log (text[] element-wise)
    await db.insert(personalizationStateTable).values({
      userId,
      recentPhrases: ["you are not broken", "that sounds heavy"],
    });
    const rawPhrases = await pool.query<{ recent_phrases: string[] }>(
      "SELECT recent_phrases FROM personalization_state WHERE user_id = $1",
      [userId],
    );
    expect(rawPhrases.rows[0]!.recent_phrases.every((p) => p.startsWith("enc:v1:"))).toBe(true);
    const viaOrm = await db
      .select()
      .from(personalizationStateTable)
      .where(eq(personalizationStateTable.userId, userId));
    expect(viaOrm[0]!.recentPhrases).toEqual(["you are not broken", "that sounds heavy"]);
  });
});

// ─── 3. Chapters verbatim-quote gate on encrypted storage ────────────────────

describe("verbatim-quote gate validates against decrypted content", () => {
  it("accepts exact substrings and rejects paraphrases of an encrypted message", async () => {
    const { userId } = await signupUser("quotegate");
    const MSG = "Some mornings I wake up and forget, and then it all comes back at once.";
    const [inserted] = await db
      .insert(messagesTable)
      .values({ userId, role: "user", content: MSG, isMorningNote: false })
      .returning();

    // at rest: ciphertext
    const raw = await pool.query<{ content: string }>("SELECT content FROM messages WHERE id = $1", [
      inserted!.id,
    ]);
    expect(raw.rows[0]!.content).toMatch(/^enc:v1:/);

    // engine-style load (drizzle → decrypted), then the hard gate
    const [fetched] = await db.select().from(messagesTable).where(eq(messagesTable.id, inserted!.id));
    const sources = new Map<number, QuoteSource>([
      [
        inserted!.id,
        { id: inserted!.id, content: fetched!.content, createdAt: fetched!.createdAt, localDate: "2026-07-22" },
      ],
    ]);

    const verbatim = validateExcerpt(inserted!.id, "then it all comes back at once", sources);
    expect(verbatim).not.toBeNull();
    expect(verbatim!.text).toBe("then it all comes back at once");

    // paraphrase / fabrication must still be rejected — gate semantics unchanged
    expect(validateExcerpt(inserted!.id, "then everything comes back at once", sources)).toBeNull();
  });
});

// ─── 4. Forget-this cascade on encrypted rows ─────────────────────────────────

describe("forget-this works end-to-end on encrypted rows", () => {
  it("deletes the message, its dismissal, and scrubs the retelling quote", async () => {
    const { agent, userId } = await signupUser("forget");
    const [m1] = await db
      .insert(messagesTable)
      .values({ userId, role: "user", content: "Why did it end at the airport?", isMorningNote: false })
      .returning();
    await pool.query("INSERT INTO chapter_quote_dismissals (user_id, message_id) VALUES ($1, $2)", [
      userId,
      m1!.id,
    ]);
    const retellings = [
      {
        week: "2026-07-13",
        summary: "told the airport story",
        question: "Why did it end at the airport?",
        questionMessageId: m1!.id,
        framing: "past tense",
        sameAsPrior: false,
        confidence: 0.9,
      },
      {
        week: "2026-07-20",
        summary: "same story, new angle",
        question: null,
        questionMessageId: null,
        framing: "present tense",
        sameAsPrior: false,
        confidence: 0.7,
      },
    ];
    const [thread] = await db
      .insert(storyThreadsTable)
      .values({
        userId,
        slug: "airport-goodbye",
        label: "the airport goodbye",
        retellings,
        firstSeenWeek: "2026-07-13",
        lastSeenWeek: "2026-07-20",
      })
      .returning();

    // stored encrypted (jsonb string scalar)
    const rawThread = await pool.query<{ t: string }>(
      "SELECT retellings #>> '{}' AS t FROM story_threads WHERE id = $1",
      [thread!.id],
    );
    expect(rawThread.rows[0]!.t).toMatch(/^enc:v1:/);

    const del = await agent.delete(`/api/chat/messages/${m1!.id}`);
    expect(del.status).toBe(200);

    const msgGone = await pool.query("SELECT 1 FROM messages WHERE id = $1", [m1!.id]);
    expect(msgGone.rowCount).toBe(0);
    const dismGone = await pool.query(
      "SELECT 1 FROM chapter_quote_dismissals WHERE user_id = $1 AND message_id = $2",
      [userId, m1!.id],
    );
    expect(dismGone.rowCount).toBe(0);

    const [after] = await db.select().from(storyThreadsTable).where(eq(storyThreadsTable.id, thread!.id));
    const scrubbed = after!.retellings as typeof retellings;
    expect(scrubbed).toHaveLength(2);
    expect(scrubbed[0]!.question).toBeNull();
    expect(scrubbed[0]!.questionMessageId).toBeNull();
    expect(scrubbed[0]!.summary).toBe("told the airport story");
    expect(scrubbed[1]).toEqual(retellings[1]);
  });
});

// ─── 5 + 6. Migration + export ────────────────────────────────────────────────

describe("boot migration + export", () => {
  const ORIG = {
    message: "Plaintext row from before the encryption rollout.",
    fact: "grew up near the coast",
    signal: "tends to deflect with humor",
    win: "cooked a real dinner again",
    notePrompt: "What do you predict next Sunday-you will say?",
    noteText: "I think I will be okay.",
    threadOpening: "It was a heavy week, and you carried it.",
    thresholdQuestion: "What felt heaviest this week?",
    themes: [
      {
        title: "Carrying it alone",
        quotes: [{ messageId: 1, text: "I did not tell anyone how bad it got.", date: "2026-07-15" }],
      },
    ],
    retellings: [
      {
        week: "2026-07-13",
        summary: "the leaving story",
        question: "Did I make them leave?",
        questionMessageId: null,
        framing: "past",
        sameAsPrior: false,
        confidence: 0.8,
      },
    ],
    phrases: ["that sounds heavy", "I hear you"],
    userName: "Pre Rollout Name",
  };

  let userId = 0;
  let agent: ReturnType<typeof request.agent>;
  let ids: Record<string, number> = {};

  async function seedPlaintext() {
    const s = await signupUser("migrate");
    userId = s.userId;
    agent = s.agent;
    ids.msg = (
      await pool.query<{ id: number }>(
        "INSERT INTO messages (user_id, role, content, is_morning_note) VALUES ($1, 'user', $2, false) RETURNING id",
        [userId, ORIG.message],
      )
    ).rows[0]!.id;
    ids.fact = (
      await pool.query<{ id: number }>(
        "INSERT INTO memory_facts (user_id, fact, category) VALUES ($1, $2, 'life') RETURNING id",
        [userId, ORIG.fact],
      )
    ).rows[0]!.id;
    ids.signal = (
      await pool.query<{ id: number }>(
        "INSERT INTO personality_signals (user_id, signal) VALUES ($1, $2) RETURNING id",
        [userId, ORIG.signal],
      )
    ).rows[0]!.id;
    ids.win = (
      await pool.query<{ id: number }>(
        "INSERT INTO wins (user_id, content) VALUES ($1, $2) RETURNING id",
        [userId, ORIG.win],
      )
    ).rows[0]!.id;
    ids.chapter = (
      await pool.query<{ id: number }>(
        `INSERT INTO weekly_chapters (user_id, week_start, week_end, status, thread_opening, threshold_question, themes)
         VALUES ($1, '2026-07-13', '2026-07-19', 'revealed', $2, $3, $4::jsonb) RETURNING id`,
        [userId, ORIG.threadOpening, ORIG.thresholdQuestion, JSON.stringify(ORIG.themes)],
      )
    ).rows[0]!.id;
    ids.note = (
      await pool.query<{ id: number }>(
        `INSERT INTO sealed_notes (user_id, chapter_id, week_start, kind, prompt, text)
         VALUES ($1, $2, '2026-07-13', 'prediction', $3, $4) RETURNING id`,
        [userId, ids.chapter, ORIG.notePrompt, ORIG.noteText],
      )
    ).rows[0]!.id;
    ids.thread = (
      await pool.query<{ id: number }>(
        `INSERT INTO story_threads (user_id, slug, label, first_seen_week, last_seen_week, retellings)
         VALUES ($1, 'leaving-story', 'the leaving story', '2026-07-13', '2026-07-20', $2::jsonb) RETURNING id`,
        [userId, JSON.stringify(ORIG.retellings)],
      )
    ).rows[0]!.id;
    await pool.query(
      "INSERT INTO personalization_state (user_id, recent_phrases) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET recent_phrases = $2",
      [userId, ORIG.phrases],
    );
    await pool.query("UPDATE profile SET user_name = $1 WHERE user_id = $2", [ORIG.userName, userId]);
  }

  async function runMigrationWithRetry() {
    for (let i = 0; i < 3; i++) {
      const counts = await runDataEncryptionMigration();
      if (counts) return counts;
      await new Promise((r) => setTimeout(r, 2000)); // advisory lock contention (boot migration)
    }
    throw new Error("could not acquire migration lock after 3 attempts");
  }

  it("encrypts pre-existing plaintext in place, verifiably and idempotently", async () => {
    await seedPlaintext();
    const counts = await runMigrationWithRetry();
    // at least our seeded rows were migrated (other suites may add more)
    expect(counts.messages!.migrated).toBeGreaterThanOrEqual(1);
    expect(counts.weekly_chapters!.migrated).toBeGreaterThanOrEqual(1);

    const msg = await pool.query<{ content: string }>("SELECT content FROM messages WHERE id = $1", [ids.msg]);
    expect(msg.rows[0]!.content).toMatch(/^enc:v1:/);
    expect(decryptText(msg.rows[0]!.content, "messages.content")).toBe(ORIG.message);

    const fact = await pool.query<{ fact: string }>("SELECT fact FROM memory_facts WHERE id = $1", [ids.fact]);
    expect(decryptText(fact.rows[0]!.fact, "memory_facts.fact")).toBe(ORIG.fact);

    const signal = await pool.query<{ signal: string }>(
      "SELECT signal FROM personality_signals WHERE id = $1",
      [ids.signal],
    );
    expect(decryptText(signal.rows[0]!.signal, "personality_signals.signal")).toBe(ORIG.signal);

    const win = await pool.query<{ content: string }>("SELECT content FROM wins WHERE id = $1", [ids.win]);
    expect(decryptText(win.rows[0]!.content, "wins.content")).toBe(ORIG.win);

    const note = await pool.query<{ prompt: string; text: string }>(
      "SELECT prompt, text FROM sealed_notes WHERE id = $1",
      [ids.note],
    );
    expect(decryptText(note.rows[0]!.prompt, "sealed_notes.prompt")).toBe(ORIG.notePrompt);
    expect(decryptText(note.rows[0]!.text, "sealed_notes.text")).toBe(ORIG.noteText);

    const ch = await pool.query<{ thread_opening: string; threshold_question: string; themes: unknown }>(
      "SELECT thread_opening, threshold_question, themes FROM weekly_chapters WHERE id = $1",
      [ids.chapter],
    );
    expect(ch.rows[0]!.thread_opening).toMatch(/^enc:v1:/);
    expect(decryptText(ch.rows[0]!.thread_opening, "weekly_chapters.thread_opening")).toBe(ORIG.threadOpening);
    expect(decryptText(ch.rows[0]!.threshold_question, "weekly_chapters.threshold_question")).toBe(
      ORIG.thresholdQuestion,
    );
    expect(typeof ch.rows[0]!.themes).toBe("string");
    expect(decryptJson(ch.rows[0]!.themes, "weekly_chapters.themes")).toEqual(ORIG.themes);

    const thread = await pool.query<{ retellings: unknown }>(
      "SELECT retellings FROM story_threads WHERE id = $1",
      [ids.thread],
    );
    expect(decryptJson(thread.rows[0]!.retellings, "story_threads.retellings")).toEqual(ORIG.retellings);

    const phrases = await pool.query<{ recent_phrases: string[] }>(
      "SELECT recent_phrases FROM personalization_state WHERE user_id = $1",
      [userId],
    );
    expect(phrases.rows[0]!.recent_phrases.every((p) => p.startsWith("enc:v1:"))).toBe(true);
    expect(decryptTextArray(phrases.rows[0]!.recent_phrases, "personalization_state.recent_phrases")).toEqual(
      ORIG.phrases,
    );

    const name = await pool.query<{ user_name: string }>("SELECT user_name FROM profile WHERE user_id = $1", [
      userId,
    ]);
    expect(decryptText(name.rows[0]!.user_name, "profile.user_name")).toBe(ORIG.userName);

    // idempotency: a second run must not touch already-encrypted rows —
    // identical ciphertext proves the detector skipped them.
    const before = msg.rows[0]!.content;
    await runMigrationWithRetry();
    const again = await pool.query<{ content: string }>("SELECT content FROM messages WHERE id = $1", [ids.msg]);
    expect(again.rows[0]!.content).toBe(before);
  });

  it("app reads migrated rows as plaintext (memory recall unchanged)", async () => {
    const apiFacts = await agent.get("/api/memory/facts");
    expect(JSON.stringify(apiFacts.body)).toContain(ORIG.fact);
    const apiMsgs = await agent.get("/api/chat/messages");
    expect(JSON.stringify(apiMsgs.body)).toContain(ORIG.message);
  });

  it("export decrypts everything to readable plaintext", async () => {
    const res = await agent.get("/api/account/export");
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("enc:v1:"); // nothing leaks encrypted
    expect(body).toContain(ORIG.message);
    expect(body).toContain(ORIG.fact);
    expect(body).toContain(ORIG.signal);
    expect(body).toContain(ORIG.win);
    expect(body).toContain(ORIG.noteText);
    expect(body).toContain("I did not tell anyone how bad it got."); // chapter theme quote
    expect(body).toContain("Did I make them leave?"); // retelling
    expect(body).toContain("that sounds heavy"); // recent phrases
  });
});
