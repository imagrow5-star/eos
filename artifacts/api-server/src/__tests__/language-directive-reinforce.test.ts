/**
 * Language-directive recency reinforcement (placement fix).
 *
 * The strict directive at the TOP of the stable prompt was being drowned by
 * ~500 lines of English craft rules that follow it, so the last thing the
 * model read before the user's message was the stage rules, not the language
 * mandate. This suite proves the reinforcement is now the LAST content in the
 * prompt for active non-English users, absent for English users, and that
 * RULE 5 carries the anti-language-switch clause.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import pg from "pg";
import { db, profileTable } from "@workspace/db";
import { getOrCreateProfileForUser } from "../routes/profile.js";
import { buildSystemPrompt } from "../services/systemPrompt.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const createdIds: number[] = [];

afterAll(async () => {
  for (const id of createdIds) {
    await pool.query("DELETE FROM profile WHERE user_id=$1", [id]);
    await pool.query("DELETE FROM users WHERE id=$1", [id]);
  }
  await pool.end();
});

/** Create a bare user + profile with a given preferred language. */
async function makeUser(language: string) {
  const email = `lang-reinforce-${language}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.invalid`;
  const u = await pool.query<{ id: number }>(
    "INSERT INTO users (email, hashed_password, email_verified_at) VALUES ($1,'x',NOW()) RETURNING id",
    [email],
  );
  const userId = u.rows[0]!.id;
  createdIds.push(userId);
  await getOrCreateProfileForUser(userId);
  await db
    .update(profileTable)
    .set({ preferredLanguage: language, userName: "Naveen", isOnboardingComplete: true })
    .where(eq(profileTable.userId, userId));
  const [profile] = await db.select().from(profileTable).where(eq(profileTable.userId, userId));
  return profile!;
}

// The exact terminal reinforcement text, per language — golden strings.
const reinforcement = (langName: string) =>
  `REPLY LANGUAGE (overrides every English example above): Respond ONLY in ${langName}. ` +
  `Every example in this prompt is written in English for your reference — they are NOT a signal to reply in English. ` +
  `The user chose ${langName}; write your entire reply in ${langName}.`;

describe("terminal reply-language reinforcement", () => {
  it("es: reinforcement is the LAST line of the prompt (≥95% of total length)", async () => {
    const profile = await makeUser("es");
    const { stable, context } = await buildSystemPrompt(profile);
    const full = `${stable}\n\n${context}`;

    const line = reinforcement("Español");
    const idx = full.indexOf(line);
    expect(idx, "reinforcement present").toBeGreaterThan(-1);
    // It must sit in the recency-strongest position: at/after 95% of the prompt.
    expect(idx / full.length).toBeGreaterThanOrEqual(0.95);
    // And nothing of substance follows it — it is the final block of context.
    expect(context.trimEnd().endsWith(line)).toBe(true);
  });

  it("en: NO reinforcement is appended (regression — English prompt unchanged at the tail)", async () => {
    const profile = await makeUser("en");
    const { context } = await buildSystemPrompt(profile);
    expect(context).not.toContain("REPLY LANGUAGE (overrides every English example above)");
    // English users still end on the SAFETY block, exactly as before.
    expect(context.trimEnd().endsWith("Honest about being an AI if sincerely asked.")).toBe(true);
  });

  it("inactive language (fi): no reinforcement — Eos still speaks English", async () => {
    const profile = await makeUser("fi");
    const { context } = await buildSystemPrompt(profile);
    expect(context).not.toContain("REPLY LANGUAGE (overrides every English example above)");
  });

  it("golden terminal line — byte-for-byte for es (the one non-English language left)", async () => {
    const cases: Array<[string, string]> = [
      ["es", "Español"],
    ];
    for (const [code, native] of cases) {
      const profile = await makeUser(code);
      const { context } = await buildSystemPrompt(profile);
      const parts = context.split("\n\n");
      expect(parts[parts.length - 1], code).toBe(reinforcement(native));
    }
  });
});

describe("RULE 5 anti-language-switch clause", () => {
  it("es: RULE 5 pins mirroring to Español", async () => {
    const profile = await makeUser("es");
    const { stable } = await buildSystemPrompt(profile);
    expect(stable).toContain("but always in Español — mirroring never means switching languages");
    expect(stable).toContain(
      "If they type in English while your reply-language is Español, still reply in Español; do not echo English back.",
    );
  });

  it("en: RULE 5 clause degrades to a harmless 'always in English' no-op", async () => {
    const profile = await makeUser("en");
    const { stable } = await buildSystemPrompt(profile);
    expect(stable).toContain("but always in English — mirroring never means switching languages");
  });
});
