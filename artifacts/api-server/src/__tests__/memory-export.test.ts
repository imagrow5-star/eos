/**
 * Integration tests: GET /api/memory/export (Sprint E).
 *
 * DATABASE_URL-gated (skips where no DB is present, like the rest of the DB
 * suite). Covers:
 *  - JSON export: every user-owned category represented, encrypted columns
 *    decrypted to the caller's own plaintext, Sprint 2A columns on facts;
 *  - Markdown export: right content-type/filename, memoir sections + content;
 *  - auth isolation: an unauthenticated caller gets 401; user A never sees B;
 *  - empty account: a brand-new user exports a valid (empty) structure, not 500;
 *  - large account: 5k facts + 10k messages still export in one response.
 *
 * The 1/hour rate limit (429 on the second export) is exercised in its own file
 * (memory-export-rate-limit.test.ts), which must set the limit BEFORE importing
 * the app; keeping it separate lets this file use the high test default and
 * export many times.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import pg from "pg";

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("GET /api/memory/export", () => {
  let app: Express;
  let pool: pg.Pool;
  const emails: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    app = (await import("../app.js")).default;
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    for (const email of emails.splice(0)) {
      const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
      if (!r.rowCount) continue;
      const uid = r.rows[0]!.id;
      await pool.query(`
        BEGIN;
        DELETE FROM user_sessions        WHERE sess::jsonb->>'userId' = '${uid}';
        DELETE FROM email_verification_tokens WHERE user_id = ${uid};
        DELETE FROM crisis_events        WHERE user_id = ${uid};
        DELETE FROM messages             WHERE user_id = ${uid};
        DELETE FROM memory_facts         WHERE user_id = ${uid};
        DELETE FROM memory_feelings      WHERE user_id = ${uid};
        DELETE FROM personality_signals  WHERE user_id = ${uid};
        DELETE FROM wins                 WHERE user_id = ${uid};
        DELETE FROM mood_scores          WHERE user_id = ${uid};
        DELETE FROM reminders            WHERE user_id = ${uid};
        DELETE FROM commitments          WHERE user_id = ${uid};
        DELETE FROM habit_completions    WHERE habit_id IN (SELECT id FROM habits WHERE user_id = ${uid});
        DELETE FROM habits               WHERE user_id = ${uid};
        DELETE FROM goals                WHERE user_id = ${uid};
        DELETE FROM sealed_notes         WHERE user_id = ${uid};
        DELETE FROM weekly_chapters      WHERE user_id = ${uid};
        DELETE FROM story_threads        WHERE user_id = ${uid};
        DELETE FROM subscriptions        WHERE user_id = ${uid};
        DELETE FROM profile              WHERE user_id = ${uid};
        DELETE FROM users                WHERE id      = ${uid};
        COMMIT;
      `);
    }
    await pool.end();
  });

  function nextEmail(tag: string): string {
    const email = `memexport-${tag}-${Date.now()}-${seq++}@example.invalid`;
    emails.push(email);
    return email;
  }

  async function signup(tag: string) {
    const email = nextEmail(tag);
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(res.status).toBe(201);
    const userId: number = res.body.user.id;
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
    return { agent, userId, email };
  }

  interface Populated {
    userId: number;
    email: string;
    agent: ReturnType<typeof request.agent>;
    messageContent: string;
    memoryFact: string;
    memoryFeeling: string;
    habitName: string;
    goalTitle: string;
    sealedText: string;
  }

  async function signupAndPopulate(tag: string): Promise<Populated> {
    const { agent, userId, email } = await signup(tag);

    await pool.query(
      `INSERT INTO profile (user_id, user_name, companion_name, user_path, preferred_language)
       VALUES ($1, $2, 'Aria', 'breakup', 'en')`,
      [userId, `User ${tag}`],
    );

    const messageContent = `secret message from ${tag}`;
    await pool.query(
      `INSERT INTO messages (user_id, role, content) VALUES ($1, 'user', $2), ($1, 'assistant', $3)`,
      [userId, messageContent, `Eos reply to ${tag}`],
    );

    const memoryFact = `secret fact from ${tag}`;
    await pool.query(
      `INSERT INTO memory_facts (user_id, fact, category, times_referenced, emotional_weight, user_marked_important)
       VALUES ($1, $2, 'life', 5, 0.7, true)`,
      [userId, memoryFact],
    );

    const memoryFeeling = `secret feeling from ${tag} — felt small at dinner`;
    await pool.query(
      `INSERT INTO memory_feelings (user_id, feeling, category, times_referenced, emotional_weight)
       VALUES ($1, $2, 'shame', 2, 0.8)`,
      [userId, memoryFeeling],
    );

    await pool.query(`INSERT INTO wins (user_id, content) VALUES ($1, $2)`, [userId, `win-${tag}`]);
    await pool.query(`INSERT INTO personality_signals (user_id, signal) VALUES ($1, $2)`, [userId, `signal-${tag}`]);
    await pool.query(`INSERT INTO mood_scores (user_id, score, date) VALUES ($1, 7, '2026-07-14')`, [userId]);
    await pool.query(`INSERT INTO reminders (user_id, content) VALUES ($1, $2)`, [userId, `reminder-${tag}`]);
    await pool.query(`INSERT INTO commitments (user_id, content, cue) VALUES ($1, $2, 'morning')`, [userId, `commit-${tag}`]);

    const habitName = `Habit-${tag}`;
    const habitRow = await pool.query<{ id: number }>(
      `INSERT INTO habits (user_id, name, when_then, reason) VALUES ($1, $2, 'After coffee', 'Health') RETURNING id`,
      [userId, habitName],
    );
    await pool.query(
      `INSERT INTO habit_completions (user_id, habit_id, completed_date) VALUES ($1, $2, '2026-07-14')`,
      [userId, habitRow.rows[0]!.id],
    );

    const goalTitle = `Goal-${tag}`;
    await pool.query(
      `INSERT INTO goals (user_id, title, description) VALUES ($1, $2, 'desc')`,
      [userId, goalTitle],
    );

    // Weekly chapter + a sealed note (both carry encrypted columns).
    const chapterRow = await pool.query<{ id: number }>(
      `INSERT INTO weekly_chapters (user_id, week_start, week_end, thread_opening, threshold_question, themes)
       VALUES ($1, '2026-07-06', '2026-07-12', $2, 'What shifted?', $3) RETURNING id`,
      [userId, `chapter-opening-${tag}`, JSON.stringify([{ title: `theme-${tag}` }])],
    );
    const sealedText = `sealed-secret-${tag}`;
    await pool.query(
      `INSERT INTO sealed_notes (user_id, chapter_id, week_start, kind, text)
       VALUES ($1, $2, '2026-07-06', 'free', $3)`,
      [userId, chapterRow.rows[0]!.id, sealedText],
    );

    // Crisis event (metadata only) + subscription.
    await pool.query(
      `INSERT INTO crisis_events (user_id, pattern_matched, country_served, source)
       VALUES ($1, 'explicit_ideation', 'US', 'chat')`,
      [userId],
    );
    await pool.query(
      `INSERT INTO subscriptions (user_id, tier, status) VALUES ($1, 'closer', 'active')`,
      [userId],
    );

    return { userId, email, agent, messageContent, memoryFact, memoryFeeling, habitName, goalTitle, sealedText };
  }

  // ── JSON export ────────────────────────────────────────────────────────────

  it("returns a decrypted, structured JSON export covering every category", async () => {
    const a = await signupAndPopulate("json");

    const res = await a.agent.get("/api/memory/export?format=json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    expect(res.headers["content-disposition"]).toMatch(/eos-memory-export-\d{8}\.json/);

    const body = res.body;

    // Metadata
    expect(body.export_metadata.format_version).toBe("1.0");
    expect(typeof body.export_metadata.generated_at).toBe("string");
    expect(body.export_metadata.user_note).toContain("Your data is yours");

    // Profile — email present, companion name decrypted-adjacent
    expect(body.profile.email).toBe(a.email);
    expect(body.profile.companion_name).toBe("Aria");
    expect(body.profile.preferred_language).toBe("en");

    // Encrypted content decrypted to the caller's own plaintext
    expect(body.memory.facts.some((f: any) => f.fact === a.memoryFact)).toBe(true);
    expect(body.memory.feelings.some((f: any) => f.feeling === a.memoryFeeling)).toBe(true);
    expect(body.messages.some((m: any) => m.content === a.messageContent)).toBe(true);
    expect(body.habits.some((h: any) => h.name === a.habitName)).toBe(true);
    expect(body.goals.some((g: any) => g.title === a.goalTitle)).toBe(true);
    expect(body.sealed_notes.some((n: any) => n.text === a.sealedText)).toBe(true);
    expect(body.chapters.length).toBeGreaterThanOrEqual(1);

    // Sprint 2A importance columns on facts
    const fact = body.memory.facts.find((f: any) => f.fact === a.memoryFact);
    expect(fact).toMatchObject({ times_referenced: 5, user_marked_important: true });
    expect(fact.emotional_weight).toBeCloseTo(0.7, 5);

    // Crisis events: metadata only — no pattern name, no content
    expect(body.crisis_events.length).toBeGreaterThanOrEqual(1);
    expect(body.crisis_events[0]).not.toHaveProperty("pattern_matched");
    expect(body.crisis_events[0].country_served).toBe("US");

    // Subscription metadata only
    expect(body.subscription).toMatchObject({ tier: "closer", status: "active" });
    expect(JSON.stringify(body.subscription)).not.toContain("paddle");
  });

  // ── Markdown export ──────────────────────────────────────────────────────────

  it("returns a Markdown memoir with the right headers and content", async () => {
    const a = await signupAndPopulate("md");

    const res = await a.agent.get("/api/memory/export?format=markdown");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/markdown/);
    expect(res.headers["content-disposition"]).toMatch(/eos-memory-export-\d{8}\.md/);

    const md = res.text;
    expect(md.startsWith("# Everything Aria remembers about you")).toBe(true);
    expect(md).toContain("## What Aria remembers");
    expect(md).toContain("## Your conversations");
    expect(md).toContain(a.memoryFact);
    expect(md).toContain(a.messageContent);
    expect(md).toContain("**You said**");
    expect(md).toContain("**Aria said**");
  });

  // ── Auth isolation ───────────────────────────────────────────────────────────

  it("rejects an unauthenticated caller with 401", async () => {
    const res = await request(app).get("/api/memory/export");
    expect(res.status).toBe(401);
  });

  it("never exposes another user's data (A cannot see B)", async () => {
    const [a, b] = await Promise.all([signupAndPopulate("iso-a"), signupAndPopulate("iso-b")]);

    const res = await a.agent.get("/api/memory/export?format=json");
    expect(res.status).toBe(200);
    const json = JSON.stringify(res.body);

    // A's own secrets present, B's absent.
    expect(json).toContain(a.memoryFact);
    expect(json).toContain(a.messageContent);
    expect(json).not.toContain(b.memoryFact);
    expect(json).not.toContain(b.messageContent);
    expect(json).not.toContain(b.sealedText);
  });

  // ── Empty account ────────────────────────────────────────────────────────────

  it("exports a valid empty structure for a brand-new user (not a 500)", async () => {
    const { agent } = await signup("empty");

    const res = await agent.get("/api/memory/export?format=json");
    expect(res.status).toBe(200);
    expect(res.body.export_metadata.format_version).toBe("1.0");
    expect(res.body.memory.facts).toEqual([]);
    expect(res.body.messages).toEqual([]);
    expect(res.body.subscription).toBeNull();

    const mdRes = await agent.get("/api/memory/export?format=markdown");
    expect(mdRes.status).toBe(200);
    expect(mdRes.text).toContain("# Everything Eos remembers about you");
  });

  // ── Large account ────────────────────────────────────────────────────────────

  it("exports a large account (5k facts + 10k messages) in one response", async () => {
    const { agent, userId } = await signup("large");
    await pool.query(
      `INSERT INTO profile (user_id, user_name, companion_name, user_path) VALUES ($1, 'Big', 'Eos', 'lonely')`,
      [userId],
    );

    // Bulk-insert via generate_series so the fixture is fast. The encrypted
    // columns go through the DB as plaintext here (pre-encryption legacy shape),
    // which the export's decrypt path passes through unchanged — exactly the
    // legacy-row behaviour we want to prove still exports.
    await pool.query(
      `INSERT INTO memory_facts (user_id, fact, category)
       SELECT $1, 'fact ' || g, 'life' FROM generate_series(1, 5000) g`,
      [userId],
    );
    await pool.query(
      `INSERT INTO messages (user_id, role, content)
       SELECT $1, CASE WHEN g % 2 = 0 THEN 'user' ELSE 'assistant' END, 'message ' || g
       FROM generate_series(1, 10000) g`,
      [userId],
    );

    const res = await agent.get("/api/memory/export?format=json");
    expect(res.status).toBe(200);
    expect(res.body.memory.facts.length).toBe(5000);
    expect(res.body.messages.length).toBe(10000);

    // Markdown must also render the whole thing without falling over.
    const mdRes = await agent.get("/api/memory/export?format=markdown");
    expect(mdRes.status).toBe(200);
    expect(mdRes.text).toContain("message 10000");
  }, 60_000);
});
