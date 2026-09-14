/**
 * Memory audit, item 1 — a fact that changes is replaced, not appended, and
 * a fact that is no longer true is retired, not kept.
 *
 *  • extraction now SEES the person's existing facts (ids included); a
 *    returned fact with `supersedes` replaces that row in place — same id,
 *    same creation date, reference count +1, old wording kept in
 *    previous_fact, updated_at stamped — and nothing is appended;
 *  • `retired` ids are stamped retired_at and vanish from the prompt, the
 *    facts endpoint, the reference matcher and the export — but the row is
 *    still there for a hand undo;
 *  • the dedup pass is the second net: a "same thing, changed content"
 *    verdict replaces in place even when the model forgot `supersedes`;
 *  • ids the person doesn't own, or that are already retired, are ignored —
 *    the candidate is then treated as new, and no other row is touched.
 *
 * The Haiku extraction call is stubbed; the dedup verdict is injected.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY ||= "test-key-unused-create-is-stubbed";
});

import pg from "pg";
import { createRequire } from "node:module";
import { db, memoryFactsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { extractMemory } from "../services/ai.js";
import { buildSystemPrompt } from "../services/systemPrompt.js";
import { recordMemoryReferences } from "../services/memory/references.js";
import type { DedupFinder } from "../services/memory/dedup.js";

const DB = !!process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const TS = Date.now();
const emails: string[] = [];

async function signupUser(tag: string): Promise<number> {
  const email = `supersede-${tag}-${TS}-${emails.length}@example.invalid`;
  emails.push(email);
  const r = await pool.query<{ id: number }>(
    `INSERT INTO users (email, hashed_password, email_verified_at) VALUES ($1, 'x', NOW()) RETURNING id`,
    [email],
  );
  return r.rows[0]!.id;
}

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`BEGIN; DELETE FROM memory_facts WHERE user_id = ${uid}; DELETE FROM profile WHERE user_id = ${uid}; DELETE FROM users WHERE id = ${uid}; COMMIT;`);
}

let createSpy: ReturnType<typeof vi.spyOn>;
let lastPrompt = "";
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

function stubOnce(payload: Record<string, unknown>) {
  createSpy.mockImplementationOnce(async (req: unknown) => {
    lastPrompt = String((req as { messages: Array<{ content: string }> }).messages[0]!.content);
    return {
      content: [{ type: "text", text: JSON.stringify({ signals: [], wins: [], ...payload }) }],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as never;
  });
}

function profileFor(userId: number) {
  return { userId, userName: "Sam", companionName: "Eos", timezone: "UTC", preferredLanguage: "en", userPath: "support", energy: "calm", relationshipType: "friend", createdAt: new Date(), visitDates: [], companionGender: "woman", country: "" } as never;
}

const never: DedupFinder = async () => ({ isDuplicate: false, relation: "different", matchingId: null, reasoning: "test" });

async function seed(userId: number, fact: string, category = "life"): Promise<number> {
  const [row] = await db.insert(memoryFactsTable).values({ userId, fact, category, timesReferenced: 3 }).returning({ id: memoryFactsTable.id });
  return row!.id;
}

async function rows(userId: number) {
  return db.select().from(memoryFactsTable).where(eq(memoryFactsTable.userId, userId)).orderBy(asc(memoryFactsTable.id));
}

describe.skipIf(!DB)("supersede and retire", () => {
  it("extraction sees the existing facts, and a superseding fact replaces its row in place", async () => {
    const userId = await signupUser("replace");
    const londonId = await seed(userId, "Lives in London", "life");
    await seed(userId, "Plays chess on Thursdays", "interest");

    stubOnce({ facts: [{ fact: "Lives in Berlin now", category: "life", supersedes: londonId }] });
    await extractMemory(profileFor(userId), [{ role: "user", content: "we moved to Berlin last week" }], { dedupFinder: never });

    expect(lastPrompt).toContain(`  ${londonId}: Lives in London`);
    const all = await rows(userId);
    expect(all).toHaveLength(2);
    const berlin = all.find((r) => r.id === londonId)!;
    expect(berlin.fact).toBe("Lives in Berlin now");
    expect(berlin.previousFact).toBe("Lives in London");
    expect(berlin.updatedAt).not.toBeNull();
    expect(berlin.timesReferenced).toBe(4);
    expect(berlin.retiredAt).toBeNull();
  });

  it("the dedup verdict 'update' replaces in place even when the model forgot supersedes", async () => {
    const userId = await signupUser("dedup-update");
    const goalId = await seed(userId, "Target is 100 crores this year", "goal");
    const finder: DedupFinder = async (candidate, existing) =>
      existing.some((e) => e.id === goalId) && candidate.includes("200")
        ? { isDuplicate: false, relation: "update", matchingId: goalId, reasoning: "new number" }
        : { isDuplicate: false, relation: "different", matchingId: null, reasoning: "no" };

    stubOnce({ facts: [{ fact: "Target is 200 crores this year", category: "goal", supersedes: null }] });
    await extractMemory(profileFor(userId), [{ role: "user", content: "the target is 200 now" }], { dedupFinder: finder });

    const all = await rows(userId);
    expect(all).toHaveLength(1);
    expect(all[0]!.fact).toBe("Target is 200 crores this year");
    expect(all[0]!.previousFact).toBe("Target is 100 crores this year");
  });

  it("a retired fact stays in the table but vanishes from the prompt, the matcher and the export", async () => {
    const userId = await signupUser("retire");
    const togetherId = await seed(userId, "Is in a happy relationship with Priya", "person");
    const keepId = await seed(userId, "Runs on Saturday mornings", "routine");

    stubOnce({ facts: [], retired: [togetherId] });
    await extractMemory(profileFor(userId), [{ role: "user", content: "Priya and I broke up" }], { dedupFinder: never });

    const all = await rows(userId);
    expect(all.find((r) => r.id === togetherId)!.retiredAt).not.toBeNull();
    expect(all.find((r) => r.id === keepId)!.retiredAt).toBeNull();

    const prompt = await buildSystemPrompt(profileFor(userId), 1);
    expect(prompt.context).toContain("Runs on Saturday mornings");
    expect(prompt.context).not.toContain("happy relationship with Priya");

    // The reference matcher never bumps a retired row.
    await recordMemoryReferences(userId, ["Priya called about the relationship"]);
    const after = await rows(userId);
    expect(after.find((r) => r.id === togetherId)!.timesReferenced).toBe(3);

    const count = await pool.query<{ n: string }>("SELECT count(*) AS n FROM memory_facts WHERE user_id = $1 AND retired_at IS NULL", [userId]);
    expect(Number(count.rows[0]!.n)).toBe(1);

    // Retired rows don't come back into the next extraction's context either.
    stubOnce({ facts: [] });
    await extractMemory(profileFor(userId), [{ role: "user", content: "anything" }], { dedupFinder: never });
    expect(lastPrompt).not.toContain("happy relationship with Priya");
  });

  it("ignores ids the person doesn't own or that are already retired, and inserts the candidate instead", async () => {
    const owner = await signupUser("owner");
    const other = await signupUser("other");
    const othersId = await seed(other, "Lives in Oslo", "life");
    const retiredId = await seed(owner, "Old and gone", "life");
    await db.update(memoryFactsTable).set({ retiredAt: new Date() }).where(eq(memoryFactsTable.id, retiredId));

    stubOnce({
      facts: [
        { fact: "Lives in Lisbon", category: "life", supersedes: othersId },
        { fact: "Started pottery classes", category: "interest", supersedes: retiredId },
      ],
      retired: [othersId],
    });
    await extractMemory(profileFor(owner), [{ role: "user", content: "moved to Lisbon and started pottery" }], { dedupFinder: never });

    const theirs = await rows(other);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.fact).toBe("Lives in Oslo");
    expect(theirs[0]!.retiredAt).toBeNull();

    const mine = await rows(owner);
    expect(mine.map((r) => r.fact).sort()).toEqual(["Lives in Lisbon", "Old and gone", "Started pottery classes"]);
    expect(mine.find((r) => r.fact === "Old and gone")!.previousFact).toBeNull();
  });
});
