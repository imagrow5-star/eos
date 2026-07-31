/**
 * Sprint 2B — "remember this", end-to-end (DB-gated).
 *
 * Deterministic detection + ranking live in remember-triggers.test.ts. This
 * suite covers the parts that need the database and the (stubbed) extractor:
 *   • extractMemory({ userMarkedImportant }) writes the flag onto the facts it
 *     pulls from THAT message — true when asked, false/omitted otherwise.
 *   • PATCH /api/memory/facts/:factId toggles the star, is ownership-checked
 *     (404 for a stranger, 400 on a non-boolean body), and GET echoes the field.
 *   • buildSystemPrompt injects the acknowledgment guidance ONLY when the
 *     rememberIntent flag is set — and the guidance holds warmly without
 *     performing the save.
 *
 * These skip automatically when DATABASE_URL is unset (same guard as the other
 * integration suites); CI provisions Postgres, so they run there.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// Must be set before ai.ts / db are imported. getAnthropic() returns null
// without a key, so give it a dummy — messages.create is stubbed below and
// never reaches the network.
vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY ||= "test-key-unused-create-is-stubbed";
});

import request from "supertest";
import pg from "pg";
import { createRequire } from "node:module";
import app from "../app.js";
import { db, profileTable, memoryFactsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getOrCreateProfileForUser } from "../routes/profile.js";
import { extractMemory } from "../services/ai.js";
import { buildSystemPrompt, REMEMBER_ACK_GUIDANCE } from "../services/systemPrompt.js";

const DB = !!process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const TS = Date.now();
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `remember2b-${tag}-${TS}-${emails.length}@example.invalid`;
  emails.push(e);
  return e;
}

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM memory_facts  WHERE user_id = ${uid};
    DELETE FROM profile       WHERE user_id = ${uid};
    DELETE FROM users         WHERE id      = ${uid};
    COMMIT;
  `);
}

/** Bare verified user + materialized profile. Returns { agent, userId }. */
async function signupUser(tag: string) {
  const email = nextEmail(tag);
  const agent = request.agent(app);
  const signupRes = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signupRes.status).toBe(201);
  const userId: number = signupRes.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  await agent.get("/api/profile"); // materialize the profile row
  return { agent, userId, email };
}

// getAnthropic() loads the SDK via require() (CJS), a different instance than an
// ESM import — resolve the same CJS module and stub create() on its Messages
// prototype, shared by any client getAnthropic() builds. Each test sets the
// return value it wants.
let createSpy: ReturnType<typeof vi.spyOn>;
function stubExtractedFacts(facts: Array<{ fact: string; category: string }>) {
  createSpy.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify({ facts, signals: [], wins: [] }) }],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as never);
}

beforeAll(() => {
  const require = createRequire(import.meta.url);
  const mod = require("@anthropic-ai/sdk");
  const Anthropic = mod.default || mod.Anthropic;
  const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: "x" }).messages);
  createSpy = vi.spyOn(messagesProto, "create");
});

afterAll(async () => {
  createSpy?.mockRestore();
  await Promise.all(emails.splice(0).map(cleanupUser));
  await pool.end();
});

// A profile object shaped the way extractMemory reads it (userName, companionName,
// userId). We use a real user id so the memory_facts FK holds.
function profileFor(userId: number) {
  return { userId, userName: "Test", companionName: "Eos" } as never;
}

// memory_facts.fact is encrypted at rest — read through drizzle so it decrypts
// (a raw SQL read would hand back ciphertext).
async function factsFor(userId: number) {
  return db.select().from(memoryFactsTable).where(eq(memoryFactsTable.userId, userId));
}

describe.skipIf(!DB)("extractMemory — marking flows onto the facts from THIS message", () => {
  it("marks every fact important when the caller asked to remember", async () => {
    const { userId } = await signupUser("extract-marked");
    stubExtractedFacts([{ fact: "my sister's wedding is in June", category: "event" }]);

    await extractMemory(profileFor(userId), [{ role: "user", content: "remember this: my sister's wedding is in June" }], {
      userMarkedImportant: true,
    });

    const rows = await factsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userMarkedImportant).toBe(true);
  });

  it("leaves facts unmarked for ordinary (non-remember) extraction", async () => {
    const { userId } = await signupUser("extract-plain");
    stubExtractedFacts([{ fact: "usually drinks coffee in the morning", category: "routine" }]);

    // No opts — the default path.
    await extractMemory(profileFor(userId), [{ role: "user", content: "I usually have coffee in the morning" }]);

    const rows = await factsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userMarkedImportant).toBe(false);
  });

  it("does NOT retroactively mark facts already stored", async () => {
    const { userId } = await signupUser("extract-noretro");
    // Pre-existing unmarked fact.
    await pool.query(
      "INSERT INTO memory_facts (user_id, fact, category, user_marked_important) VALUES ($1, 'loves quiet mornings', 'life', false)",
      [userId],
    );
    // A later remember-marked extraction of a DIFFERENT fact.
    stubExtractedFacts([{ fact: "starting therapy on Wednesdays", category: "event" }]);
    await extractMemory(profileFor(userId), [{ role: "user", content: "remember this, therapy is Wednesdays" }], {
      userMarkedImportant: true,
    });

    const rows = await factsFor(userId);
    const byFact = new Map(rows.map((r) => [r.fact, r.userMarkedImportant]));
    expect(byFact.get("loves quiet mornings")).toBe(false); // untouched
    expect(byFact.get("starting therapy on Wednesdays")).toBe(true); // newly marked
  });
});

describe.skipIf(!DB)("PATCH /api/memory/facts/:factId — star toggle", () => {
  it("requires authentication", async () => {
    const res = await request(app).patch("/api/memory/facts/1").send({ userMarkedImportant: true });
    expect(res.status).toBe(401);
  });

  it("toggles own fact both ways; GET echoes the field", async () => {
    const { agent, userId } = await signupUser("patch-own");
    const ins = await pool.query<{ id: number }>(
      "INSERT INTO memory_facts (user_id, fact, category) VALUES ($1, 'walks by the river', 'routine') RETURNING id",
      [userId],
    );
    const factId = ins.rows[0]!.id;

    // Fresh facts default to unmarked, and GET carries the field.
    const before = await agent.get("/api/memory/facts");
    expect(before.status).toBe(200);
    expect(before.body.find((f: { id: number }) => f.id === factId).userMarkedImportant).toBe(false);

    const on = await agent.patch(`/api/memory/facts/${factId}`).send({ userMarkedImportant: true });
    expect(on.status).toBe(200);
    expect(on.body.userMarkedImportant).toBe(true);
    expect(on.body.id).toBe(factId);

    const off = await agent.patch(`/api/memory/facts/${factId}`).send({ userMarkedImportant: false });
    expect(off.status).toBe(200);
    expect(off.body.userMarkedImportant).toBe(false);

    // Persisted, and only this field moved.
    const row = await pool.query<{ user_marked_important: boolean; fact: string }>(
      "SELECT user_marked_important, fact FROM memory_facts WHERE id = $1",
      [factId],
    );
    expect(row.rows[0]!.user_marked_important).toBe(false);
    expect(row.rows[0]!.fact).toBe("walks by the river");
  });

  it("404s on another user's fact and leaves it untouched", async () => {
    const { userId: userA } = await signupUser("patch-owner");
    const { agent: stranger } = await signupUser("patch-stranger");
    const ins = await pool.query<{ id: number }>(
      "INSERT INTO memory_facts (user_id, fact, category, user_marked_important) VALUES ($1, 'private thing', 'life', false) RETURNING id",
      [userA],
    );
    const factId = ins.rows[0]!.id;

    const res = await stranger.patch(`/api/memory/facts/${factId}`).send({ userMarkedImportant: true });
    expect(res.status).toBe(404);

    const row = await pool.query<{ user_marked_important: boolean }>(
      "SELECT user_marked_important FROM memory_facts WHERE id = $1",
      [factId],
    );
    expect(row.rows[0]!.user_marked_important).toBe(false); // stranger couldn't flip it
  });

  it("400s on a missing or non-boolean body, and on a bad id", async () => {
    const { agent } = await signupUser("patch-bad");
    expect((await agent.patch("/api/memory/facts/1").send({})).status).toBe(400);
    expect((await agent.patch("/api/memory/facts/1").send({ userMarkedImportant: "yes" })).status).toBe(400);
    expect((await agent.patch("/api/memory/facts/abc").send({ userMarkedImportant: true })).status).toBe(400);
  });
});

describe.skipIf(!DB)("buildSystemPrompt — acknowledgment guidance is flag-gated", () => {
  async function makeProfile(tag: string) {
    const { userId } = await signupUser(tag);
    await db
      .update(profileTable)
      .set({ userName: "Test", isOnboardingComplete: true })
      .where(eq(profileTable.userId, userId));
    const [profile] = await db.select().from(profileTable).where(eq(profileTable.userId, userId));
    return profile!;
  }

  it("injects the guidance into context ONLY when rememberIntent is true", async () => {
    const profile = await makeProfile("prompt");

    const withIntent = await buildSystemPrompt(profile, undefined, { rememberIntent: true });
    expect(withIntent.context).toContain(REMEMBER_ACK_GUIDANCE);
    // It lives in the volatile context, never the cached stable prefix.
    expect(withIntent.stable).not.toContain(REMEMBER_ACK_GUIDANCE);

    const withoutIntent = await buildSystemPrompt(profile, undefined, { rememberIntent: false });
    expect(withoutIntent.context).not.toContain(REMEMBER_ACK_GUIDANCE);

    const noOpts = await buildSystemPrompt(profile);
    expect(noOpts.context).not.toContain(REMEMBER_ACK_GUIDANCE);
  });

  it("guidance holds warmly and never performs the save", () => {
    expect(REMEMBER_ACK_GUIDANCE.toLowerCase()).toContain("hold");
    expect(REMEMBER_ACK_GUIDANCE).toContain("Do NOT perform-save");
  });
});
