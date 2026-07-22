/**
 * Sealed notes — the end-of-chapter ritual.
 *
 * Write path: one note per chapter (UNIQUE), only on revealed chapters,
 * 3–280 chars, crisis language answered IMMEDIATELY with a caring message
 * (never sealed away silently — though the note still saves, flagged).
 *
 * Defer path: "keep it sealed another week" atomically clears the chapter's
 * sealResolution and returns the note to 'sealed' with deferrals+1; a second
 * defer on the same chapter collapses to 409.
 */

import { describe, it, expect, afterEach, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const TS = Date.now();
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `sealed-${tag}-${TS}-${emails.length}@example.invalid`;
  emails.push(e);
  return e;
}

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions     WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM email_verification_tokens WHERE user_id = ${uid};
    DELETE FROM sealed_notes      WHERE user_id = ${uid};
    DELETE FROM weekly_chapters   WHERE user_id = ${uid};
    DELETE FROM messages          WHERE user_id = ${uid};
    DELETE FROM profile           WHERE user_id = ${uid};
    DELETE FROM users             WHERE id      = ${uid};
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
  await agent.get("/api/profile"); // materialize profile row
  return { agent, userId };
}

async function insertChapter(
  userId: number,
  opts: { status?: string; weekStart?: string; noteInvite?: object | null; sealResolution?: object | null } = {},
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO weekly_chapters
       (user_id, week_start, week_end, status, thread_opening, threshold_question, themes, note_invite, seal_resolution)
     VALUES ($1, $2, $3, $4, 'An opening.', 'How did the week land?', '[]'::jsonb, $5, $6)
     RETURNING id`,
    [
      userId,
      opts.weekStart ?? "2026-07-13",
      "2026-07-19",
      opts.status ?? "revealed",
      opts.noteInvite === undefined
        ? JSON.stringify({ prompt: "Where do you think your head will be next Sunday?" })
        : opts.noteInvite === null
          ? null
          : JSON.stringify(opts.noteInvite),
      opts.sealResolution ? JSON.stringify(opts.sealResolution) : null,
    ],
  );
  return r.rows[0]!.id;
}

afterEach(async () => {
  await Promise.all(emails.splice(0).map(cleanupUser));
});

afterAll(async () => {
  await pool.end();
});

// ─── Writing a note ──────────────────────────────────────────────────────────

describe("POST /api/chapters/:id/note", () => {
  it("seals a prediction note and copies the chapter's invite prompt", async () => {
    const { agent, userId } = await signupUser("write");
    const chapterId = await insertChapter(userId);

    const res = await agent
      .post(`/api/chapters/${chapterId}/note`)
      .send({ kind: "prediction", text: "I think I'll feel lighter than I expect." });
    expect(res.status).toBe(200);
    expect(res.body.care).toBeNull();
    expect(res.body.note.status).toBe("sealed");

    const row = await pool.query<{ kind: string; prompt: string | null; crisis_flagged: boolean }>(
      "SELECT kind, prompt, crisis_flagged FROM sealed_notes WHERE user_id = $1",
      [userId],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.kind).toBe("prediction");
    expect(row.rows[0]!.prompt).toContain("next Sunday");
    expect(row.rows[0]!.crisis_flagged).toBe(false);
  });

  it("allows only one note per chapter (409 on the second)", async () => {
    const { agent, userId } = await signupUser("dupe");
    const chapterId = await insertChapter(userId);

    const first = await agent.post(`/api/chapters/${chapterId}/note`).send({ kind: "free", text: "hold on" });
    expect(first.status).toBe(200);
    const second = await agent.post(`/api/chapters/${chapterId}/note`).send({ kind: "free", text: "again" });
    expect(second.status).toBe(409);
  });

  it("validates kind and length", async () => {
    const { agent, userId } = await signupUser("valid");
    const chapterId = await insertChapter(userId);

    expect((await agent.post(`/api/chapters/${chapterId}/note`).send({ kind: "diary", text: "hello there" })).status).toBe(400);
    expect((await agent.post(`/api/chapters/${chapterId}/note`).send({ kind: "free", text: "ab" })).status).toBe(400);
    expect(
      (await agent.post(`/api/chapters/${chapterId}/note`).send({ kind: "free", text: "x".repeat(281) })).status,
    ).toBe(400);
  });

  it("refuses to seal a note on an unrevealed chapter", async () => {
    const { agent, userId } = await signupUser("unrevealed");
    const chapterId = await insertChapter(userId, { status: "ready" });
    const res = await agent.post(`/api/chapters/${chapterId}/note`).send({ kind: "free", text: "too soon" });
    expect(res.status).toBe(409);
  });

  it("answers crisis language immediately with care — never a seven-day timer", async () => {
    const { agent, userId } = await signupUser("crisis");
    const chapterId = await insertChapter(userId);

    const res = await agent
      .post(`/api/chapters/${chapterId}/note`)
      .send({ kind: "free", text: "honestly some nights I just want to die" });
    expect(res.status).toBe(200);
    expect(res.body.care).not.toBeNull();
    expect(res.body.care.message).toContain("not sealing that one away");
    expect(typeof res.body.care.crisisLine).toBe("string");
    expect(res.body.care.crisisLine.length).toBeGreaterThan(0);

    const row = await pool.query<{ crisis_flagged: boolean; status: string }>(
      "SELECT crisis_flagged, status FROM sealed_notes WHERE user_id = $1",
      [userId],
    );
    expect(row.rows[0]!.crisis_flagged).toBe(true);
    expect(row.rows[0]!.status).toBe("sealed");
  });

  it("is scoped to the owner (404 for another user's chapter) and requires auth", async () => {
    const { userId } = await signupUser("owner");
    const chapterId = await insertChapter(userId);

    const { agent: stranger } = await signupUser("stranger");
    const res = await stranger.post(`/api/chapters/${chapterId}/note`).send({ kind: "free", text: "not mine" });
    expect(res.status).toBe(404);

    const unauth = await request(app).post(`/api/chapters/${chapterId}/note`).send({ kind: "free", text: "hello" });
    expect(unauth.status).toBe(401);
  });

  it("marks the chapter as noteSealed in the chapters payload afterwards", async () => {
    const { agent, userId } = await signupUser("flag");
    const chapterId = await insertChapter(userId, { weekStart: "2026-07-20" });

    const before = await agent.get("/api/chapters");
    expect(before.status).toBe(200);
    expect(before.body.current?.id).toBe(chapterId);
    expect(before.body.current?.noteSealed).toBe(false);

    await agent.post(`/api/chapters/${chapterId}/note`).send({ kind: "free", text: "see you next week" });

    const after = await agent.get("/api/chapters");
    expect(after.body.current?.noteSealed).toBe(true);
  });
});

// ─── Deferring a resolution ──────────────────────────────────────────────────

describe("POST /api/chapters/:id/seal/defer", () => {
  async function chapterWithResolution(userId: number) {
    // The note was written at the end of an earlier chapter…
    const earlier = await insertChapter(userId, { weekStart: "2026-07-06" });
    const noteRow = await pool.query<{ id: number }>(
      `INSERT INTO sealed_notes (user_id, chapter_id, week_start, kind, prompt, text, status, resolved_at)
       VALUES ($1, $2, '2026-07-06', 'free', NULL, 'i hope this week is lighter', 'resolved', NOW())
       RETURNING id`,
      [userId, earlier],
    );
    const noteId = noteRow.rows[0]!.id;
    // …and THIS chapter resolved it.
    const resolver = await insertChapter(userId, {
      weekStart: "2026-07-13",
      sealResolution: {
        noteId,
        noteKind: "free",
        notePrompt: null,
        noteText: "i hope this week is lighter",
        crisisFlagged: false,
        text: "Those words held up gently this week.",
      },
    });
    await pool.query("UPDATE sealed_notes SET resolved_chapter_id = $1 WHERE id = $2", [resolver, noteId]);
    return { noteId, resolver };
  }

  it("returns the note to sealed, bumps deferrals, and clears the chapter block", async () => {
    const { agent, userId } = await signupUser("defer");
    const { noteId, resolver } = await chapterWithResolution(userId);

    const res = await agent.post(`/api/chapters/${resolver}/seal/defer`).send({});
    expect(res.status).toBe(200);

    const chapter = await pool.query<{ seal_resolution: unknown }>(
      "SELECT seal_resolution FROM weekly_chapters WHERE id = $1",
      [resolver],
    );
    expect(chapter.rows[0]!.seal_resolution).toBeNull();

    const note = await pool.query<{ status: string; deferrals: number; resolved_chapter_id: number | null }>(
      "SELECT status, deferrals, resolved_chapter_id FROM sealed_notes WHERE id = $1",
      [noteId],
    );
    expect(note.rows[0]!.status).toBe("sealed");
    expect(note.rows[0]!.deferrals).toBe(1);
    expect(note.rows[0]!.resolved_chapter_id).toBeNull();
  });

  it("collapses double-defers: the second call gets 409", async () => {
    const { agent, userId } = await signupUser("double");
    const { resolver } = await chapterWithResolution(userId);

    expect((await agent.post(`/api/chapters/${resolver}/seal/defer`).send({})).status).toBe(200);
    expect((await agent.post(`/api/chapters/${resolver}/seal/defer`).send({})).status).toBe(409);
  });

  it("409s when the chapter has no resolution to defer", async () => {
    const { agent, userId } = await signupUser("nores");
    const plain = await insertChapter(userId);
    expect((await agent.post(`/api/chapters/${plain}/seal/defer`).send({})).status).toBe(409);
  });
});
