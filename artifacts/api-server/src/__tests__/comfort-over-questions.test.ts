/**
 * Comfort-over-questions guidance — stop Eos ending every reply with a question.
 *
 * User feedback: after sharing something painful ("I'm feeling alone"), every
 * subsequent reply ended with a question — Eos felt like it was interrogating
 * rather than listening and comforting. Two additive edits to the STABLE prompt
 * address it: RULE 6 gains "not every reply should end with a question", and the
 * GO-DEEPER CURIOSITY block gains a "COMFORT OUTRANKS CURIOSITY" caveat that
 * makes a follow-up question optional during pain and teaches reflections
 * (warm, specific statements that invite without demanding an answer) as the
 * alternative.
 *
 * DB-gated (buildSystemPrompt reads the user's memory tables); CI provisions
 * Postgres so it runs there. Asserts on distinctive static substrings and on
 * placement (RULE 6 clause inside RULE 6; the caveat inside GO-DEEPER
 * CURIOSITY), and that both live in the STABLE (cached) part, never context.
 */

import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { getOrCreateProfileForUser } from "../routes/profile.js";
import { buildSystemPrompt } from "../services/systemPrompt.js";

const DB = !!process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const EMAIL = `comfort-over-q-${Date.now()}@example.invalid`;

afterAll(async () => {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [EMAIL]);
  if (r.rowCount) {
    const uid = r.rows[0]!.id;
    await pool.query(`
      BEGIN;
      DELETE FROM personalization_state WHERE user_id = ${uid};
      DELETE FROM profile WHERE user_id = ${uid};
      DELETE FROM users   WHERE id      = ${uid};
      COMMIT;
    `);
  }
  await pool.end();
});

describe.skipIf(!DB)("comfort-over-questions guidance", () => {
  it("both edits are present in the STABLE prompt, correctly placed", async () => {
    const u = await pool.query<{ id: number }>(
      `INSERT INTO users (email, hashed_password, email_verified_at) VALUES ($1, 'x', NOW()) RETURNING id`,
      [EMAIL],
    );
    const profile = await getOrCreateProfileForUser(u.rows[0]!.id);
    const { stable, context } = await buildSystemPrompt(profile);

    // ── EDIT A — RULE 6 "don't end every reply with a question" ──
    expect(stable).toContain("Not every reply should end with a question.");
    expect(stable).toContain("Question after question turns care into an interview.");

    // Placement: inside RULE 6, before RULE 7.
    const editAIdx = stable.indexOf("Question after question turns care into an interview.");
    expect(editAIdx).toBeGreaterThan(stable.indexOf("RULE 6 — BREAK THE FORMULA"));
    expect(editAIdx).toBeLessThan(stable.indexOf("RULE 7 — CONCRETE, NOT ABSTRACT"));

    // ── EDIT B — GO-DEEPER CURIOSITY "comfort outranks curiosity" caveat ──
    expect(stable).toContain(
      "COMFORT OUTRANKS CURIOSITY — a follow-up question is optional, never required.",
    );
    expect(stable).toContain("Instead of a question, offer a reflection:");
    expect(stable).toContain("it is how they feel understood and close to you, not interviewed");

    // Placement: inside the GO-DEEPER CURIOSITY block.
    const caveatIdx = stable.indexOf("COMFORT OUTRANKS CURIOSITY");
    expect(caveatIdx).toBeGreaterThan(stable.indexOf("GO-DEEPER CURIOSITY"));

    // Both edits live in the STABLE (cached) part only — never the volatile context.
    expect(context).not.toContain("Question after question turns care into an interview.");
    expect(context).not.toContain("COMFORT OUTRANKS CURIOSITY");

    // The caveat must not reintroduce RULE 1 banned validation phrasing.
    const caveat = stable.slice(caveatIdx, caveatIdx + 900);
    expect(caveat).not.toContain("I'm here for you");
    expect(caveat).not.toContain("I hear you");
    expect(caveat).not.toContain("your feelings are valid");
  });
});
