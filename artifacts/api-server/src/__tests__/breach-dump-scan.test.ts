/**
 * A6 — breach simulation: a database dump without the key yields NO plaintext.
 *
 * Seeds a canary sentinel through the ORM layer (the same choke point
 * production writes use) into every kind of sensitive surface — chat
 * messages, memory facts, memory feelings, crisis pattern names, the
 * personalization phrase array, and the profile name — then reads the rows
 * back RAW (pg, no ORM, exactly what an attacker with the database gets) and
 * asserts:
 *   • the sentinel appears nowhere in any raw row (stringified, all columns)
 *   • every sensitive column is enc:v1: ciphertext
 *   • with the key, each value decrypts back to the sentinel (no data loss)
 *
 * Complements data-encryption.test.ts (app-path behavior) and
 * key-custody.test.ts (KMS fail-closed, wrong-key refusal).
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import {
  db,
  messagesTable,
  memoryFactsTable,
  memoryFeelingsTable,
  crisisEventsTable,
  personalizationStateTable,
  profileTable,
  isEncrypted,
  decryptText,
} from "@workspace/db";
import { eq } from "drizzle-orm";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const SENTINEL = `BREACH-CANARY-${Date.now()}`;
let email: string;

afterAll(async () => {
  if (email) {
    const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
    if (r.rowCount) {
      const uid = r.rows[0]!.id;
      await pool.query(`
        BEGIN;
        DELETE FROM user_sessions             WHERE sess::jsonb->>'userId' = '${uid}';
        DELETE FROM email_verification_tokens WHERE user_id = ${uid};
        DELETE FROM crisis_events             WHERE user_id = ${uid};
        DELETE FROM personalization_state     WHERE user_id = ${uid};
        DELETE FROM memory_feelings           WHERE user_id = ${uid};
        DELETE FROM memory_facts              WHERE user_id = ${uid};
        DELETE FROM messages                  WHERE user_id = ${uid};
        DELETE FROM profile                   WHERE user_id = ${uid};
        DELETE FROM users                     WHERE id      = ${uid};
        COMMIT;
      `);
    }
  }
  await pool.end();
});

describe("database dump without the key", () => {
  it("contains zero plaintext canaries; everything sensitive is ciphertext that round-trips", async () => {
    // ── Seed through the app/ORM layer ────────────────────────────────────
    email = `breach-scan-${Date.now()}@example.invalid`;
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(signup.status).toBe(201);
    const userId: number = signup.body.user.id;
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
    // The profile row is created lazily on first read.
    const prof0 = await agent.get("/api/profile");
    expect(prof0.status).toBe(200);

    await db.update(profileTable).set({ userName: SENTINEL }).where(eq(profileTable.userId, userId));
    await db.insert(messagesTable).values({ userId, role: "user", content: `today I told Eos: ${SENTINEL}` });
    await db.insert(memoryFactsTable).values({ userId, fact: `remembers ${SENTINEL}` });
    await db.insert(memoryFeelingsTable).values({ userId, feeling: `felt ${SENTINEL}` });
    await db.insert(crisisEventsTable).values({
      userId,
      patternMatched: SENTINEL,
      countryServed: "US",
      source: "chat",
    });
    await db
      .insert(personalizationStateTable)
      .values({ userId, recentPhrases: [`phrase ${SENTINEL}`] })
      .onConflictDoUpdate({
        target: personalizationStateTable.userId,
        set: { recentPhrases: [`phrase ${SENTINEL}`] },
      });

    // ── The "dump": raw SQL, all columns, no ORM ──────────────────────────
    const tables = [
      "profile",
      "messages",
      "memory_facts",
      "memory_feelings",
      "crisis_events",
      "personalization_state",
    ];
    const dump: Record<string, unknown[]> = {};
    for (const t of tables) {
      const { rows } = await pool.query(`SELECT * FROM "${t}" WHERE user_id = $1`, [userId]);
      expect(rows.length).toBeGreaterThan(0);
      dump[t] = rows;
    }

    // The attacker's view: nowhere in any row of any table does the
    // sentinel appear in the clear.
    expect(JSON.stringify(dump)).not.toContain(SENTINEL);

    // Every sensitive column is versioned ciphertext…
    const prof = dump.profile![0] as Record<string, unknown>;
    const msg = dump.messages![0] as Record<string, unknown>;
    const fact = dump.memory_facts![0] as Record<string, unknown>;
    const feel = dump.memory_feelings![0] as Record<string, unknown>;
    const crisis = dump.crisis_events![0] as Record<string, unknown>;
    const pers = dump.personalization_state![0] as Record<string, unknown>;
    expect(isEncrypted(prof.user_name)).toBe(true);
    expect(isEncrypted(msg.content)).toBe(true);
    expect(isEncrypted(fact.fact)).toBe(true);
    expect(isEncrypted(feel.feeling)).toBe(true);
    expect(isEncrypted(crisis.pattern_matched)).toBe(true);
    expect(isEncrypted((pers.recent_phrases as string[])[0])).toBe(true);

    // …and with the key, nothing was lost.
    expect(decryptText(prof.user_name as string, "profile.user_name")).toBe(SENTINEL);
    expect(decryptText(msg.content as string, "messages.content")).toBe(`today I told Eos: ${SENTINEL}`);
    expect(decryptText(fact.fact as string, "memory_facts.fact")).toBe(`remembers ${SENTINEL}`);
    expect(decryptText(feel.feeling as string, "memory_feelings.feeling")).toBe(`felt ${SENTINEL}`);
    expect(decryptText(crisis.pattern_matched as string, "crisis_events.pattern_matched")).toBe(SENTINEL);
    expect(
      decryptText((pers.recent_phrases as string[])[0]!, "personalization_state.recent_phrases"),
    ).toBe(`phrase ${SENTINEL}`);
  });
});
