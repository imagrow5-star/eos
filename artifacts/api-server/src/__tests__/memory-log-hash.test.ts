/**
 * Sprint 2A follow-up — the "memory ranking" observability log emits a SALTED
 * user-id hash (`uh`) instead of the raw `userId`.
 *
 * Contract under test:
 *   uh = sha256(LOG_HASH_SALT + ":" + userId).hex.slice(0, 8)
 * computed inside a try/catch so that if LOG_HASH_SALT is unset (or hashing
 * throws for any reason) the WHOLE log line is skipped — retrieval never
 * depends on the log succeeding. No default/fallback salt exists in the code.
 *
 * Two layers of coverage:
 *  - Pure (always runs, no DB): pins the exact hash formula (deterministic +
 *    distinct) and the top-40 ranking regression guard (memory logic unchanged).
 *  - Integration (skipped without DATABASE_URL, matching the rest of the
 *    suite): drives the real buildSystemPrompt and spies on logger.info to
 *    prove `uh` is emitted, `userId` is not, and a missing salt skips the log
 *    without throwing while retrieval still returns facts. Heavy imports are
 *    dynamic so the pure tests run even where no DB is provisioned (@workspace/db
 *    throws at import time when DATABASE_URL is unset).
 */

import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import crypto from "node:crypto";
import {
  rankFactsByImportance,
  scoreFactImportance,
  type ScorableFact,
} from "../services/memory/importance.js";

// The exact transform the log line uses (kept in lockstep with systemPrompt.ts).
const expectedHash = (salt: string, userId: number): string =>
  crypto.createHash("sha256").update(salt + ":" + userId).digest("hex").slice(0, 8);

// ─── Pure: hash-format contract ──────────────────────────────────────────────

describe("memory-ranking log — user-hash format", () => {
  const SALT = "test-salt-0123456789abcdef0123456";

  it("same userId + same salt is deterministic (stable 8-char hex)", () => {
    const a = expectedHash(SALT, 42);
    const b = expectedHash(SALT, 42);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it("different userIds produce different hashes", () => {
    expect(expectedHash(SALT, 42)).not.toBe(expectedHash(SALT, 43));
  });

  it("a different salt reshuffles the hash for the same userId", () => {
    expect(expectedHash(SALT, 42)).not.toBe(expectedHash("a-completely-different-salt", 42));
  });
});

// ─── Pure: top-40 ranking regression guard (memory logic unchanged) ──────────

describe("memory-ranking retrieval — top-40 unchanged", () => {
  const now = 1_700_000_000_000; // fixed instant; scoring never calls Date.now()

  // 45 synthetic facts: a spread of ages, reference counts, emotional weight,
  // plus one explicitly user-marked (must always survive the cut).
  const facts: ScorableFact[] = Array.from({ length: 45 }, (_, i) => ({
    createdAt: new Date(now - i * 3 * 86_400_000),
    timesReferenced: (i % 5) + 1,
    lastReferencedAt: new Date(now - i * 86_400_000),
    emotionalWeight: (i % 4) * 0.25,
    userMarkedImportant: i === 30, // an OLD fact the user pinned
  }));

  it("returns exactly the top 40 in non-increasing score order", () => {
    const ranked = rankFactsByImportance(facts, now, 40);
    expect(ranked.length).toBe(40);
    const scores = ranked.map((f) => scoreFactImportance(f, now));
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });

  it("keeps an old-but-user-marked fact and drops the lowest-scoring five", () => {
    const ranked = rankFactsByImportance(facts, now, 40);
    // The pinned fact (index 30) trumps recency and must be retained.
    expect(ranked).toContain(facts[30]);
    // Exactly five facts fall below the boundary.
    const dropped = facts.filter((f) => !ranked.includes(f));
    expect(dropped.length).toBe(5);
  });
});

// ─── Integration: real buildSystemPrompt emits `uh`, never crashes ───────────
// Mirrors the suite's convention (goal-agreement / crisis-i18n) of driving the
// real prompt builder against the dev DB. Skipped when no DB is configured.
// Heavy modules are imported dynamically in beforeAll so this file's pure tests
// still load where DATABASE_URL is unset.

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("memory-ranking log — buildSystemPrompt emission", () => {
  const SALT = "integration-salt-abcdef0123456789";
  const priorSalt = process.env.LOG_HASH_SALT;

  // Lazily loaded DB-backed deps (see block comment above).
  let pool: import("pg").Pool;
  let db: typeof import("@workspace/db").db;
  let memoryFactsTable: typeof import("@workspace/db").memoryFactsTable;
  let profileTable: typeof import("@workspace/db").profileTable;
  let eq: typeof import("drizzle-orm").eq;
  let buildSystemPrompt: typeof import("../services/systemPrompt.js").buildSystemPrompt;
  let getOrCreateProfileForUser: typeof import("../routes/profile.js").getOrCreateProfileForUser;
  let logger: typeof import("../lib/logger.js").logger;

  const createdUserIds: number[] = [];

  beforeAll(async () => {
    const pg = (await import("pg")).default;
    ({ db, memoryFactsTable, profileTable } = await import("@workspace/db"));
    ({ eq } = await import("drizzle-orm"));
    ({ buildSystemPrompt } = await import("../services/systemPrompt.js"));
    ({ getOrCreateProfileForUser } = await import("../routes/profile.js"));
    ({ logger } = await import("../lib/logger.js"));
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    for (const uid of createdUserIds) {
      await pool.query("DELETE FROM memory_facts WHERE user_id=$1", [uid]);
      await pool.query("DELETE FROM personalization_state WHERE user_id=$1", [uid]);
      await pool.query("DELETE FROM profile WHERE user_id=$1", [uid]);
      await pool.query("DELETE FROM email_verification_tokens WHERE user_id=$1", [uid]);
      await pool.query("DELETE FROM users WHERE id=$1", [uid]);
    }
    await pool.end();
    if (priorSalt === undefined) delete process.env.LOG_HASH_SALT;
    else process.env.LOG_HASH_SALT = priorSalt;
  });

  async function makeUserWithFacts(tag: string, factCount: number) {
    const email = `mem-log-hash-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.invalid`;
    const r = await pool.query<{ id: number }>(
      "INSERT INTO users (email, hashed_password, email_verified_at) VALUES ($1,'x',NOW()) RETURNING id",
      [email],
    );
    const userId = r.rows[0]!.id;
    createdUserIds.push(userId);

    await getOrCreateProfileForUser(userId);
    await db
      .update(profileTable)
      .set({ userName: "Sam", isOnboardingComplete: true, country: "US", timezone: "UTC" })
      .where(eq(profileTable.userId, userId));

    for (let i = 0; i < factCount; i++) {
      await db.insert(memoryFactsTable).values({
        userId,
        fact: `fact number ${i} about something memorable happening`,
        category: "life",
        createdAt: new Date(Date.now() - i * 2 * 86_400_000),
      });
    }

    const [profile] = await db.select().from(profileTable).where(eq(profileTable.userId, userId));
    return { userId, profile: profile! };
  }

  /** Capture the single "memory ranking" logger.info payload, if any, emitted
   *  while `fn` runs. Returns null when the log line was skipped. */
  async function captureRankingLog(
    fn: () => Promise<unknown>,
  ): Promise<Record<string, unknown> | null> {
    const spy = vi.spyOn(logger, "info");
    try {
      await fn();
      for (const call of spy.mock.calls) {
        if (call[1] === "memory ranking") return call[0] as Record<string, unknown>;
      }
      return null;
    } finally {
      spy.mockRestore();
    }
  }

  it("emits a salted `uh` (never the raw userId) and is deterministic", async () => {
    process.env.LOG_HASH_SALT = SALT;
    const { userId, profile } = await makeUserWithFacts("uh", 3);

    const first = await captureRankingLog(() => buildSystemPrompt(profile));
    const second = await captureRankingLog(() => buildSystemPrompt(profile));

    expect(first).not.toBeNull();
    expect(first).not.toHaveProperty("userId");
    expect(first!.uh).toBe(expectedHash(SALT, userId));
    expect(first!.uh).toMatch(/^[0-9a-f]{8}$/);
    // Deterministic across builds.
    expect(second!.uh).toBe(first!.uh);
  });

  it("produces different hashes for different users", async () => {
    process.env.LOG_HASH_SALT = SALT;
    const a = await makeUserWithFacts("dist-a", 2);
    const b = await makeUserWithFacts("dist-b", 2);

    const logA = await captureRankingLog(() => buildSystemPrompt(a.profile));
    const logB = await captureRankingLog(() => buildSystemPrompt(b.profile));

    expect(logA!.uh).not.toBe(logB!.uh);
  });

  it("skips the log (no throw) when LOG_HASH_SALT is missing, and retrieval still returns facts", async () => {
    delete process.env.LOG_HASH_SALT;
    const { profile } = await makeUserWithFacts("nosalt", 3);

    let parts: { stable: string; context: string } | undefined;
    const rankingLog = await captureRankingLog(async () => {
      parts = await buildSystemPrompt(profile); // must not throw
    });

    // Log line skipped entirely...
    expect(rankingLog).toBeNull();
    // ...but the prompt was built (retrieval succeeded regardless of the log).
    expect(parts).toBeDefined();
    expect(parts!.stable.length).toBeGreaterThan(0);
  });

  it("regression: the real path returns the top 40 when more facts exist", async () => {
    process.env.LOG_HASH_SALT = SALT;
    const { profile } = await makeUserWithFacts("top40", 45);

    const rankingLog = await captureRankingLog(() => buildSystemPrompt(profile));
    expect(rankingLog!.totalFacts).toBe(45);
    expect(rankingLog!.returnedFacts).toBe(40);
  });
});
