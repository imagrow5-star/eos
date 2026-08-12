/**
 * DB-gated tests for the shared morning-note thread selection
 * (services/morning/threadSelection.ts) — the fix for re-asking a stale
 * one-time event every morning.
 *
 * Covers:
 *  - a due, fresh, un-surfaced commitment IS selected;
 *  - a STALE follow-up (older than the window) is NOT;
 *  - a commitment surfaced within the cooldown is NOT (asked-not-answered);
 *  - one-time EVENT facts age out; GOAL-category facts do not;
 *  - active (incomplete) goals are selected, completed ones are not;
 *  - the stamp helpers set last_surfaced_at (and thereby suppress re-selection).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  selectFollowUpCommitments,
  selectReferenceFacts,
  selectActiveGoals,
  stampCommitmentsSurfaced,
  stampFactsSurfaced,
} from "../services/morning/threadSelection.js";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const today = () => new Date().toISOString().slice(0, 10);

describe.skipIf(!HAS_DB)("morning thread selection", () => {
  let pool: pg.Pool;
  let userId: number;
  const email = `morning-sel-${Date.now()}@example.invalid`;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const u = await pool.query<{ id: number }>(
      `INSERT INTO users (email, hashed_password, email_verified_at) VALUES ($1,'x',NOW()) RETURNING id`,
      [email],
    );
    userId = u.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query(`
      BEGIN;
      DELETE FROM commitments   WHERE user_id = ${userId};
      DELETE FROM memory_facts  WHERE user_id = ${userId};
      DELETE FROM goals         WHERE user_id = ${userId};
      DELETE FROM users         WHERE id      = ${userId};
      COMMIT;
    `);
    await pool.end();
  });

  it("selects a due, fresh, un-surfaced commitment — not a stale or already-asked one", async () => {
    const fresh = await pool.query<{ id: number }>(
      `INSERT INTO commitments (user_id, content, cue, state, scheduled_followup_date)
       VALUES ($1, 'call mom', '', 'open', to_char(CURRENT_DATE - 1, 'YYYY-MM-DD')) RETURNING id`,
      [userId],
    );
    const freshId = fresh.rows[0]!.id;
    // Stale: follow-up 20 days ago (older than the 10-day window).
    await pool.query(
      `INSERT INTO commitments (user_id, content, cue, state, scheduled_followup_date)
       VALUES ($1, 'the meeting at 10am', '', 'open', to_char(CURRENT_DATE - 20, 'YYYY-MM-DD'))`,
      [userId],
    );
    // Due but surfaced just now → inside the cooldown, must be skipped.
    await pool.query(
      `INSERT INTO commitments (user_id, content, cue, state, scheduled_followup_date, last_surfaced_at)
       VALUES ($1, 'text sam', '', 'open', to_char(CURRENT_DATE - 1, 'YYYY-MM-DD'), NOW())`,
      [userId],
    );

    const picked = await selectFollowUpCommitments(userId, today());
    expect(picked.map((c) => c.id)).toEqual([freshId]);
    expect(picked[0]!.content).toBe("call mom");
  });

  it("ages out one-time EVENT facts but keeps ongoing GOAL facts", async () => {
    await pool.query(
      `INSERT INTO memory_facts (user_id, fact, category) VALUES ($1, 'had a big meeting yesterday', 'event')`,
      [userId],
    );
    await pool.query(
      `INSERT INTO memory_facts (user_id, fact, category, created_at)
       VALUES ($1, 'the old meeting three weeks ago', 'event', NOW() - interval '30 days')`,
      [userId],
    );
    await pool.query(
      `INSERT INTO memory_facts (user_id, fact, category, created_at)
       VALUES ($1, 'wants to read every day', 'goal', NOW() - interval '30 days')`,
      [userId],
    );

    const facts = await selectReferenceFacts(userId);
    const texts = facts.map((f) => f.fact);
    expect(texts).toContain("had a big meeting yesterday"); // fresh event kept
    expect(texts).toContain("wants to read every day"); // old goal kept (recurs)
    expect(texts).not.toContain("the old meeting three weeks ago"); // stale event aged out
  });

  it("selects only active (incomplete) goals", async () => {
    await pool.query(`INSERT INTO goals (user_id, title, description, is_complete) VALUES ($1,'read daily','',false)`, [userId]);
    await pool.query(`INSERT INTO goals (user_id, title, description, is_complete) VALUES ($1,'finished goal','',true)`, [userId]);
    const goals = await selectActiveGoals(userId);
    expect(goals.map((g) => g.title)).toContain("read daily");
    expect(goals.map((g) => g.title)).not.toContain("finished goal");
  });

  it("stamping a commitment surfaced suppresses it on the next selection", async () => {
    const picked = await selectFollowUpCommitments(userId, today());
    expect(picked.length).toBe(1);
    await stampCommitmentsSurfaced([picked[0]!.id]);
    const again = await selectFollowUpCommitments(userId, today());
    expect(again.length).toBe(0); // now inside the cooldown
  });

  it("stampFactsSurfaced sets last_surfaced_at on the given facts", async () => {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO memory_facts (user_id, fact, category) VALUES ($1, 'stamp me', 'event') RETURNING id`,
      [userId],
    );
    const id = r.rows[0]!.id;
    await stampFactsSurfaced([id]);
    const check = await pool.query<{ last_surfaced_at: Date | null }>(
      `SELECT last_surfaced_at FROM memory_facts WHERE id = $1`,
      [id],
    );
    expect(check.rows[0]!.last_surfaced_at).not.toBeNull();
  });
});
