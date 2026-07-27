/**
 * Field-level encryption for the conversation-derived planning tables
 * (review finding): commitments, goals, goal_tasks, habits — and the
 * sealed-note crisis flag, which sat queryable in plaintext beside its
 * encrypted note text.
 *
 * Mirrors data-encryption.test.ts for the new columns:
 *  1. rows written through the app are ciphertext at rest, plaintext via API;
 *  2. pre-existing plaintext rows still read correctly (passthrough), the
 *     boot migration encrypts them in place, idempotently, altering nothing
 *     about what the app returns;
 *  3. the account export contains the decrypted values (and no ciphertext).
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { eq } from "drizzle-orm";
import app from "../app.js";
import {
  db,
  commitmentsTable,
  sealedNotesTable,
  decryptText,
} from "@workspace/db";
import { runDataEncryptionMigration } from "../services/dataEncryptionMigration.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const TS = Date.now();
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `derivedenc-${tag}-${TS}-${emails.length}@example.invalid`;
  emails.push(e);
  return e;
}

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions             WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM email_verification_tokens WHERE user_id = ${uid};
    DELETE FROM sealed_notes              WHERE user_id = ${uid};
    DELETE FROM weekly_chapters           WHERE user_id = ${uid};
    DELETE FROM goal_tasks                WHERE goal_id IN (SELECT id FROM goals WHERE user_id = ${uid});
    DELETE FROM goals                     WHERE user_id = ${uid};
    DELETE FROM habit_completions         WHERE user_id = ${uid};
    DELETE FROM habits                    WHERE user_id = ${uid};
    DELETE FROM commitments               WHERE user_id = ${uid};
    DELETE FROM messages                  WHERE user_id = ${uid};
    DELETE FROM profile                   WHERE user_id = ${uid};
    DELETE FROM users                     WHERE id      = ${uid};
    COMMIT;
  `);
}

async function signupUser(tag: string) {
  const email = nextEmail(tag);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(res.status).toBe(201);
  const userId: number = res.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  await agent.get("/api/profile");
  return { agent, userId };
}

async function runMigrationWithRetry() {
  for (let i = 0; i < 3; i++) {
    const counts = await runDataEncryptionMigration();
    if (counts) return counts;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("could not acquire migration lock after 3 attempts");
}

afterAll(async () => {
  for (const email of emails) await cleanupUser(email);
  await pool.end();
});

// ─── 1. App writes → ciphertext at rest, plaintext via API ───────────────────

describe("derived tables: app writes are ciphertext at rest, plaintext via API", () => {
  it("habits via route, goals via route, commitments + crisis flag via ORM", async () => {
    const { agent, userId } = await signupUser("atrest");

    // habit through the real route
    const habitRes = await agent.post("/api/memory/habits").send({
      name: "evening walk to the harbour",
      whenThen: "after dinner, I will walk to the harbour",
      reason: "it is where I feel most like myself",
    });
    expect(habitRes.status).toBe(201);
    const rawHabit = await pool.query<{ name: string; when_then: string; reason: string }>(
      "SELECT name, when_then, reason FROM habits WHERE user_id = $1",
      [userId],
    );
    for (const v of Object.values(rawHabit.rows[0]!)) expect(v).toMatch(/^enc:v1:/);
    const apiHabits = await agent.get("/api/memory/habits");
    expect(JSON.stringify(apiHabits.body)).toContain("harbour");

    // goal through the real route (mock mode breaks tasks into canned steps)
    const goalRes = await agent.post("/api/goals").send({
      title: "pack up his things by Sunday",
      description: "one box at a time, music on",
    });
    expect(goalRes.status).toBe(201);
    const rawGoal = await pool.query<{ title: string; description: string }>(
      "SELECT title, description FROM goals WHERE user_id = $1",
      [userId],
    );
    expect(rawGoal.rows[0]!.title).toMatch(/^enc:v1:/);
    expect(rawGoal.rows[0]!.description).toMatch(/^enc:v1:/);
    const rawTasks = await pool.query<{ content: string }>(
      "SELECT gt.content FROM goal_tasks gt JOIN goals g ON g.id = gt.goal_id WHERE g.user_id = $1",
      [userId],
    );
    expect(rawTasks.rows.length).toBeGreaterThan(0);
    for (const r of rawTasks.rows) expect(r.content).toMatch(/^enc:v1:/);
    const apiGoals = await agent.get("/api/goals");
    expect(JSON.stringify(apiGoals.body)).toContain("pack up his things");

    // commitment through the ORM (same write path the extraction pipeline uses)
    await db.insert(commitmentsTable).values({
      userId,
      content: "text Sam tomorrow after coffee",
      cue: "after morning coffee",
      qualityNote: "said it felt easier than expected",
      state: "open",
    });
    const rawCommit = await pool.query<{ content: string; cue: string; quality_note: string; state: string }>(
      "SELECT content, cue, quality_note, state FROM commitments WHERE user_id = $1",
      [userId],
    );
    expect(rawCommit.rows[0]!.content).toMatch(/^enc:v1:/);
    expect(rawCommit.rows[0]!.cue).toMatch(/^enc:v1:/);
    expect(rawCommit.rows[0]!.quality_note).toMatch(/^enc:v1:/);
    expect(rawCommit.rows[0]!.state).toBe("open"); // enum stays queryable
    const apiCommits = await agent.get("/api/commitments");
    expect(JSON.stringify(apiCommits.body)).toContain("text Sam tomorrow");

    // crisis flag: encrypted at rest, boolean through the ORM
    const [note] = await db
      .insert(sealedNotesTable)
      .values({
        userId,
        chapterId: 900000 + userId, // no FK on chapter_id; unique per chapter
        weekStart: "2026-07-20",
        kind: "free",
        text: "I do not want to be here anymore.",
        crisisFlagged: true,
      })
      .returning();
    const rawNote = await pool.query<{ crisis_flagged: string }>(
      "SELECT crisis_flagged FROM sealed_notes WHERE id = $1",
      [note!.id],
    );
    expect(rawNote.rows[0]!.crisis_flagged).toMatch(/^enc:v1:/);
    // The one query that must be IMPOSSIBLE now: listing crisis users in SQL.
    const sqlHunt = await pool.query(
      "SELECT 1 FROM sealed_notes WHERE user_id = $1 AND crisis_flagged = 'true'",
      [userId],
    );
    expect(sqlHunt.rowCount).toBe(0);
    const [viaOrm] = await db.select().from(sealedNotesTable).where(eq(sealedNotesTable.id, note!.id));
    expect(viaOrm!.crisisFlagged).toBe(true);
  });
});

// ─── 2. Plaintext passthrough + in-place migration ────────────────────────────

describe("derived tables: pre-existing plaintext rows migrate in place", () => {
  const ORIG = {
    commitment: "call mum on Sunday afternoon",
    cue: "after lunch",
    goalTitle: "apply to three jobs this week",
    goalDesc: "start with the one Priya mentioned",
    task: "update the CV tonight",
    habitName: "morning pages",
    whenThen: "after coffee, I will write one page",
    reason: "keeps the spiral out of my head",
  };

  it("reads plaintext via the app, encrypts on migration, stays identical after", async () => {
    const { agent, userId } = await signupUser("migrate");

    const goalId = (
      await pool.query<{ id: number }>(
        "INSERT INTO goals (user_id, title, description) VALUES ($1, $2, $3) RETURNING id",
        [userId, ORIG.goalTitle, ORIG.goalDesc],
      )
    ).rows[0]!.id;
    await pool.query(`INSERT INTO goal_tasks (goal_id, content, "order") VALUES ($1, $2, 0)`, [
      goalId,
      ORIG.task,
    ]);
    const commitmentId = (
      await pool.query<{ id: number }>(
        "INSERT INTO commitments (user_id, content, cue, state) VALUES ($1, $2, $3, 'open') RETURNING id",
        [userId, ORIG.commitment, ORIG.cue],
      )
    ).rows[0]!.id;
    await pool.query(
      "INSERT INTO habits (user_id, name, when_then, reason, is_active) VALUES ($1, $2, $3, $4, true)",
      [userId, ORIG.habitName, ORIG.whenThen, ORIG.reason],
    );
    const noteId = (
      await pool.query<{ id: number }>(
        `INSERT INTO sealed_notes (user_id, chapter_id, week_start, kind, text, crisis_flagged)
         VALUES ($1, $2, '2026-07-20', 'free', 'an ordinary note', 'true') RETURNING id`,
        [userId, 910000 + userId],
      )
    ).rows[0]!.id;

    // BEFORE migration: plaintext passthrough — the app reads them correctly.
    expect(JSON.stringify((await agent.get("/api/goals")).body)).toContain(ORIG.goalTitle);
    expect(JSON.stringify((await agent.get("/api/commitments")).body)).toContain(ORIG.commitment);
    expect(JSON.stringify((await agent.get("/api/memory/habits")).body)).toContain(ORIG.habitName);
    const [noteBefore] = await db.select().from(sealedNotesTable).where(eq(sealedNotesTable.id, noteId));
    expect(noteBefore!.crisisFlagged).toBe(true);

    // Migrate.
    const counts = await runMigrationWithRetry();
    expect(counts.commitments!.migrated).toBeGreaterThanOrEqual(1);
    expect(counts.goals!.migrated).toBeGreaterThanOrEqual(1);
    expect(counts.goal_tasks!.migrated).toBeGreaterThanOrEqual(1);
    expect(counts.habits!.migrated).toBeGreaterThanOrEqual(1);

    // AFTER: ciphertext at rest, decrypts to the original words…
    const rawGoal = await pool.query<{ title: string }>("SELECT title FROM goals WHERE id = $1", [goalId]);
    expect(rawGoal.rows[0]!.title).toMatch(/^enc:v1:/);
    expect(decryptText(rawGoal.rows[0]!.title, "goals.title")).toBe(ORIG.goalTitle);
    const rawCommit = await pool.query<{ content: string }>(
      "SELECT content FROM commitments WHERE id = $1",
      [commitmentId],
    );
    expect(decryptText(rawCommit.rows[0]!.content, "commitments.content")).toBe(ORIG.commitment);
    const rawFlag = await pool.query<{ crisis_flagged: string }>(
      "SELECT crisis_flagged FROM sealed_notes WHERE id = $1",
      [noteId],
    );
    expect(rawFlag.rows[0]!.crisis_flagged).toMatch(/^enc:v1:/);
    expect(decryptText(rawFlag.rows[0]!.crisis_flagged, "sealed_notes.crisis_flagged")).toBe("true");

    // …and the app returns exactly what it returned before the migration.
    expect(JSON.stringify((await agent.get("/api/goals")).body)).toContain(ORIG.goalTitle);
    expect(JSON.stringify((await agent.get("/api/commitments")).body)).toContain(ORIG.commitment);
    expect(JSON.stringify((await agent.get("/api/memory/habits")).body)).toContain(ORIG.habitName);
    const [noteAfter] = await db.select().from(sealedNotesTable).where(eq(sealedNotesTable.id, noteId));
    expect(noteAfter!.crisisFlagged).toBe(true);

    // Idempotency: a second run leaves the ciphertext byte-identical.
    const before = rawGoal.rows[0]!.title;
    await runMigrationWithRetry();
    const again = await pool.query<{ title: string }>("SELECT title FROM goals WHERE id = $1", [goalId]);
    expect(again.rows[0]!.title).toBe(before);
  });

  it("export contains the decrypted values and no ciphertext", async () => {
    // Reuses the migrated user from the previous test via a fresh login-less
    // export? No — exports are per-agent; create a fresh user with app-written
    // (encrypted) rows and assert the export shows words, not enc:v1.
    const { agent, userId } = await signupUser("export");
    await agent.post("/api/goals").send({ title: "learn to cook dal properly", description: "" });
    await db.insert(commitmentsTable).values({
      userId,
      content: "book the dentist on Monday",
      cue: "first thing",
      state: "open",
    });
    await agent.post("/api/memory/habits").send({
      name: "stretch before bed",
      whenThen: "after brushing teeth, I will stretch",
      reason: "sleep",
    });

    const res = await agent.get("/api/account/export");
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("enc:v1:");
    expect(body).toContain("learn to cook dal properly");
    expect(body).toContain("book the dentist on Monday");
    expect(body).toContain("stretch before bed");

    // The styled HTML report decrypts too.
    const html = await agent.get("/api/account/export?format=html");
    expect(html.status).toBe(200);
    expect(html.text).not.toContain("enc:v1:");
    expect(html.text).toContain("learn to cook dal properly");
    expect(html.text).toContain("stretch before bed");
  });
});
