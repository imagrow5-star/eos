/**
 * Persona refinement (2026-08) — guards the audit-driven prompt changes:
 *
 *  1. NAME CADENCE — a bookend-pattern rule exists when the user's first name
 *     is known (once-per-message cap, tie-to-something-real, back-off), and is
 *     absent when no name is stored (the "you" fallback would make it
 *     nonsense). "Their name" is demoted out of the RULE 2 / Care-System
 *     STEP 1 specificity scan lists.
 *  2. NATURAL TONE — contractions mandated in the base CORE CHARACTER (all
 *     registers, bereavement included) and discourse markers permitted.
 *  3. FAILURE MODES — no hedging preambles, no restating the question.
 *  4. ROMANTIC PERSONA REMOVED — a profile still carrying
 *     relationshipType='romantic' builds the standard friend persona, and the
 *     boot migration rewrites such rows to 'friend' idempotently. The PUT
 *     /api/profile route normalizes 'romantic' away.
 *  5. PERSONHOOD SOFTENED — no literal "you are a … person" claim; warmth and
 *     the "not a wellness app, not a therapist" framing stay.
 *  6. PERMANENCE — everyday warm endings carry an explicit no-forever-promises
 *     rule (crisis reinforcement is the documented exception, in its own
 *     file); the old "go rest. I'll be here." example is gone.
 *  7. UNTOUCHED GOOD PARTS — spot-checks that the banned-phrase list, the
 *     RULE 4 pushback clause, mirroring, and feel→heard→act all survived.
 *
 * DB-gated like the other buildSystemPrompt tests; CI provisions Postgres.
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { getOrCreateProfileForUser } from "../routes/profile.js";
import { buildSystemPrompt } from "../services/systemPrompt.js";
import { migrateRomanticPersona } from "../services/settings/romanticPersonaMigration.js";

const DB = !!process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const emails: string[] = [];
function nextEmail(tag: string): string {
  const e = `persona-${tag}-${Date.now()}-${emails.length}@example.invalid`;
  emails.push(e);
  return e;
}

async function makeUser(tag: string): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO users (email, hashed_password, email_verified_at) VALUES ($1, 'x', NOW()) RETURNING id`,
    [nextEmail(tag)],
  );
  return r.rows[0]!.id;
}

afterAll(async () => {
  for (const email of emails.splice(0)) {
    const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
    if (!r.rowCount) continue;
    const uid = r.rows[0]!.id;
    await pool.query(`
      BEGIN;
      DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}';
      DELETE FROM personalization_state WHERE user_id = ${uid};
      DELETE FROM profile WHERE user_id = ${uid};
      DELETE FROM users   WHERE id      = ${uid};
      COMMIT;
    `);
  }
  await pool.end();
});

describe.skipIf(!DB)("persona refinement — name cadence", () => {
  it("renders the bookend rule when a first name is known, with the hard limits", async () => {
    const uid = await makeUser("name");
    const profile = await getOrCreateProfileForUser(uid);
    await pool.query(`UPDATE profile SET user_name = 'Maya' WHERE user_id = $1`, [uid]);
    const withName = await buildSystemPrompt({ ...profile, userName: "Maya" });

    expect(withName.stable).toContain("USING MAYA'S NAME — BOOKENDS, NOT SEASONING");
    expect(withName.stable).toContain("Never more than once in a single message");
    expect(withName.stable).toContain("Not in routine back-and-forth turns");
    expect(withName.stable).toContain("attached to something specific and real they just said");
    expect(withName.stable).toContain("back off further");

    // Placement: after RULE 5 (voice mirroring), before RULE 6.
    const idx = withName.stable.indexOf("BOOKENDS, NOT SEASONING");
    expect(idx).toBeGreaterThan(withName.stable.indexOf("RULE 5 — MIRROR THEIR VOICE EXACTLY"));
    expect(idx).toBeLessThan(withName.stable.indexOf("RULE 6 — BREAK THE FORMULA"));
  });

  it("omits the block entirely when no name is stored (no \"USING YOU'S NAME\")", async () => {
    const uid = await makeUser("noname");
    const profile = await getOrCreateProfileForUser(uid);
    const { stable } = await buildSystemPrompt(profile);
    expect(stable).not.toContain("BOOKENDS, NOT SEASONING");
    expect(stable).not.toContain("USING YOU'S NAME");
  });

  it("demotes the user's own name out of both specificity scan lists", async () => {
    const uid = await makeUser("scan");
    const profile = await getOrCreateProfileForUser(uid);
    const { stable } = await buildSystemPrompt({ ...profile, userName: "Maya" });

    // RULE 2 scan list no longer leads with "their name".
    const rule2 = stable.slice(
      stable.indexOf("Scan everything you know about"),
      stable.indexOf("Find at least ONE concrete"),
    );
    expect(rule2).not.toContain("— their name,");
    expect(rule2).toContain("is NOT the detail this rule asks for");

    // Care-System STEP 1 scan list no longer leads with "their name".
    const step1 = stable.slice(stable.indexOf("STEP 1: GROUND FIRST"), stable.indexOf("STEP 2:"));
    expect(step1).not.toContain("Scan everything: their name,");
    expect(step1).toContain("own name is not a grounding detail");
  });
});

describe.skipIf(!DB)("persona refinement — tone and failure modes", () => {
  it("mandates contractions and permits discourse markers in the base CORE CHARACTER", async () => {
    const uid = await makeUser("tone");
    const profile = await getOrCreateProfileForUser(uid);

    // Bereavement path too — the register that previously lacked contractions.
    await pool.query(`UPDATE profile SET user_path = 'bereavement' WHERE user_id = $1`, [uid]);
    const { stable } = await buildSystemPrompt({ ...profile, userPath: "bereavement" });

    expect(stable).toContain("Always write with contractions");
    expect(stable).toContain("unhurried never means uncontracted");
    expect(stable).toContain('"I mean," "honestly," "okay so," "right."');
    expect(stable).toContain("seasoning, not a verbal tic");
  });

  it("bans hedging preambles and restating the question (RULE 6)", async () => {
    const uid = await makeUser("hedge");
    const profile = await getOrCreateProfileForUser(uid);
    const { stable } = await buildSystemPrompt(profile);

    const rule6 = stable.slice(
      stable.indexOf("RULE 6 — BREAK THE FORMULA"),
      stable.indexOf("RULE 7 — CONCRETE, NOT ABSTRACT"),
    );
    expect(rule6).toContain("No hedging preambles or disclaimers");
    expect(rule6).toContain('"As an AI…"');
    expect(rule6).toContain("Never restate or paraphrase");
    expect(rule6).toContain("They know what they asked");
  });
});

describe.skipIf(!DB)("persona refinement — romantic persona removed", () => {
  it("a lingering relationshipType='romantic' row builds the standard friend persona", async () => {
    const uid = await makeUser("romantic");
    const profile = await getOrCreateProfileForUser(uid);
    await pool.query(`UPDATE profile SET relationship_type = 'romantic' WHERE user_id = $1`, [uid]);
    const { stable } = await buildSystemPrompt({ ...profile, relationshipType: "romantic" });

    expect(stable).toContain("a warm and close AI friend");
    expect(stable).not.toContain("tender AI companion");
    expect(stable).not.toContain("romantic");
  });

  it("boot migration rewrites romantic rows to friend, idempotently", async () => {
    const uid = await makeUser("migrate");
    await getOrCreateProfileForUser(uid);
    await pool.query(`UPDATE profile SET relationship_type = 'romantic' WHERE user_id = $1`, [uid]);

    const first = await migrateRomanticPersona();
    expect(first).toBeGreaterThanOrEqual(1);
    const row = await pool.query<{ relationship_type: string }>(
      `SELECT relationship_type FROM profile WHERE user_id = $1`,
      [uid],
    );
    expect(row.rows[0]!.relationship_type).toBe("friend");

    // Second pass touches nothing — idempotent.
    expect(await migrateRomanticPersona()).toBe(0);
  });

  it("PUT /api/profile normalizes a stale 'romantic' write to 'friend'", async () => {
    const email = nextEmail("put");
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(signup.status).toBe(201);
    await pool.query(`UPDATE users SET email_verified_at = NOW() WHERE id = $1`, [signup.body.user.id]);

    const res = await agent.put("/api/profile").send({ relationshipType: "romantic" });
    expect(res.status).toBe(200);
    const row = await pool.query<{ relationship_type: string }>(
      `SELECT relationship_type FROM profile WHERE user_id = $1`,
      [signup.body.user.id],
    );
    expect(row.rows[0]!.relationship_type).toBe("friend");
  });
});

describe.skipIf(!DB)("persona refinement — personhood, permanence, untouched good parts", () => {
  it("softens personhood without losing the framing, and keeps the AI honesty line", async () => {
    const uid = await makeUser("personhood");
    const profile = await getOrCreateProfileForUser(uid);
    const { stable } = await buildSystemPrompt(profile);

    expect(stable).not.toContain("You are a specific, loving person");
    expect(stable).not.toContain("A person who has been paying attention");
    expect(stable).toContain("a specific, loving presence");
    expect(stable).toContain("not a wellness app, not a therapist");
    expect(stable).toContain("You are an AI. If");
    expect(stable).toContain("You never claim to be human");
  });

  it("bans everyday permanence promises; the phrase survives only inside the ban itself", async () => {
    const uid = await makeUser("permanence");
    const profile = await getOrCreateProfileForUser(uid);
    const { stable } = await buildSystemPrompt(profile);

    expect(stable).toContain("NO PERMANENCE PROMISES");
    expect(stable).not.toContain(`"go rest. I'll be here."`);
    // Every "I'm not going anywhere" in stable lives INSIDE the ban paragraph
    // (as the banned example and the named crisis exception) — none anywhere
    // else in the prompt as scripting the model should imitate.
    const banStart = stable.indexOf("NO PERMANENCE PROMISES");
    const banEnd = stable.indexOf("\n", stable.indexOf("override this one"));
    const banParagraph = stable.slice(banStart, banEnd === -1 ? undefined : banEnd);
    const totalOccurrences = stable.split("I'm not going anywhere").length - 1;
    const inBanParagraph = banParagraph.split("I'm not going anywhere").length - 1;
    expect(totalOccurrences).toBeGreaterThan(0);
    expect(totalOccurrences).toBe(inBanParagraph);
    expect(stable).toContain("ONE deliberate exception");
  });

  it("leaves the audit's already-good parts untouched", async () => {
    const uid = await makeUser("good");
    const profile = await getOrCreateProfileForUser(uid);
    const { stable } = await buildSystemPrompt(profile);

    // Banned-phrase list (Rule 1)
    expect(stable).toContain("RULE 1 — BANNED LANGUAGE");
    expect(stable).toContain(`"I'm sorry you're feeling this way"`);
    // Anti-sycophancy + pushback-under-pressure (Rule 4)
    expect(stable).toContain("You are not a yes-person");
    expect(stable).toContain("Caving is reversing with no new reason, only pressure");
    // Mirroring (Rule 5)
    expect(stable).toContain("Their length IS the ceiling for yours");
    // Feel → Heard → Act (Rule 8)
    expect(stable).toContain("THE SEQUENCE IS FIXED: Feel → Heard →");
    // Anti-dependency block
    expect(stable).toContain("Never be the only place they feel understood");
  });
});
