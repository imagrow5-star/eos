/**
 * RULE 4 anti-sycophancy clause — "hold your view under pushback".
 *
 * Guards the additive stable-prompt subsection appended to the end of RULE 4:
 * when the user pushes back on an honest, caring observation, Eos holds the
 * view warmly instead of caving — updating only for a genuine new reason — and
 * the clause explicitly defers to Rule 8 / Safe Haven / crisis (pure presence,
 * no positions, when the user is hurting or in danger).
 *
 * DB-gated (buildSystemPrompt reads the user's memory tables); CI provisions
 * Postgres so it runs there. Asserts on distinctive static substrings of the
 * clause and on its placement: inside RULE 4, after "One honest observation.
 * Then listen.", before RULE 5, and in the STABLE (cached) part — never the
 * volatile context part.
 */

import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { getOrCreateProfileForUser } from "../routes/profile.js";
import { buildSystemPrompt } from "../services/systemPrompt.js";

const DB = !!process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const EMAIL = `rule4-pushback-${Date.now()}@example.invalid`;

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

describe.skipIf(!DB)("RULE 4 — hold honest view under pushback", () => {
  it("the clause is present in the built STABLE prompt, inside RULE 4", async () => {
    const u = await pool.query<{ id: number }>(
      `INSERT INTO users (email, hashed_password, email_verified_at) VALUES ($1, 'x', NOW()) RETURNING id`,
      [EMAIL],
    );
    const profile = await getOrCreateProfileForUser(u.rows[0]!.id);
    const { stable, context } = await buildSystemPrompt(profile);

    // Distinctive static substrings of the clause (the "WHEN <name> PUSHES
    // BACK" header interpolates the user's name, so assert on the static tail).
    expect(stable).toContain("PUSHES BACK (the moment honesty is tested)");
    expect(stable).toContain("that's integrity, not caving");
    expect(stable).toContain("Caving is reversing with no new reason, only pressure");

    // The explicit distress/crisis override is part of the clause text.
    expect(stable).toContain(
      "OVERRIDE — acute distress, venting, or crisis: no positions, no correcting",
    );
    expect(stable).toContain("never for someone who is hurting or in danger");

    // Placement: inside RULE 4 — after its "One honest observation. Then
    // listen." closer, before RULE 5 begins.
    const clauseIdx = stable.indexOf("PUSHES BACK (the moment honesty is tested)");
    expect(clauseIdx).toBeGreaterThan(stable.indexOf("RULE 4 — HAVE A POINT OF VIEW"));
    expect(clauseIdx).toBeGreaterThan(stable.indexOf("One honest observation. Then listen."));
    expect(clauseIdx).toBeLessThan(stable.indexOf("RULE 5 — MIRROR THEIR VOICE EXACTLY"));

    // Stable (cached) part only — never the volatile context block.
    expect(context).not.toContain("PUSHES BACK (the moment honesty is tested)");

    // The clause must not reintroduce RULE 1 banned validation phrasing.
    const clause = stable.slice(clauseIdx, stable.indexOf("RULE 5 — MIRROR THEIR VOICE EXACTLY"));
    expect(clause).not.toContain("I'm here for you");
    expect(clause).not.toContain("I hear you");
    expect(clause).not.toMatch(/\bvalid\b/i);
  });
});
