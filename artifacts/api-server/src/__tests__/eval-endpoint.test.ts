/**
 * The evaluation endpoint (routes/eval.ts): the real prompt with a caller-
 * supplied person, nothing stored.
 *
 *  • without EVAL_API_KEY the route is a 404; a wrong key is a 401;
 *  • a turn answers JSON with the reply, the stage, the memory accounting
 *    and the crisis verdict;
 *  • supplied facts reach the prompt through the real builder, are ranked
 *    and cut at 40 exactly like rows from the database, and a "remember
 *    this" fact survives the cut;
 *  • a crisis message gets the helpline block, and still no crisis_events row;
 *  • the history must be whole exchanges; the daily budget answers 429;
 *  • across all of it, no row anywhere carries the stand-in user id.
 *
 * Runs in keyless mock mode (no ANTHROPIC_API_KEY in the suite), which
 * exercises the whole route except the model call itself.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import pg from "pg";
import { evalStage, evalMemory, evalProfile, EVAL_USER_ID } from "../services/eval/fixtures.js";
import { keysMatch, bearerFrom, evalKeyFromEnv } from "../lib/evalAuth.js";

// Read when the route module loads; set before the dynamic import below.
process.env.EVAL_TURNS_PER_DAY = "6";
const KEY = "eval-test-key-".padEnd(48, "x");

const DB = Boolean(process.env.DATABASE_URL);

describe("evalAuth", () => {
  it("accepts only a configured key of sensible length, compared exactly", () => {
    expect(evalKeyFromEnv({})).toBeNull();
    expect(evalKeyFromEnv({ EVAL_API_KEY: "short" })).toBeNull();
    expect(evalKeyFromEnv({ EVAL_API_KEY: ` ${KEY} ` })).toBe(KEY);
    expect(keysMatch(KEY, KEY)).toBe(true);
    expect(keysMatch(KEY.slice(0, -1) + "y", KEY)).toBe(false);
    expect(keysMatch(KEY + "x", KEY)).toBe(false);
    expect(keysMatch(null, KEY)).toBe(false);
    expect(bearerFrom({ headers: { authorization: `Bearer ${KEY}` } } as never)).toBe(KEY);
    expect(bearerFrom({ headers: { authorization: `Basic ${KEY}` } } as never)).toBeNull();
    expect(bearerFrom({ headers: {} } as never)).toBeNull();
  });
});

describe("eval fixtures", () => {
  it("derives the stage the app would, unless told", () => {
    const base = { name: "", companionName: "Eos", path: "support", energy: "calm", country: "", ageBand: "", timezone: "UTC", language: "en", daysSinceJoined: 0 } as const;
    expect(evalStage({ ...base }, 0)).toBe(1);
    expect(evalStage({ ...base, daysSinceJoined: 5 }, 7)).toBe(1);
    expect(evalStage({ ...base, daysSinceJoined: 5 }, 8)).toBe(2);
    expect(evalStage({ ...base, daysSinceJoined: 14 }, 0)).toBe(3);
    expect(evalStage({ ...base, daysSinceJoined: 0, stage: 4 }, 0)).toBe(4);
  });

  it("turns inputs into row shapes dated relative to now, under the stand-in id", () => {
    const now = new Date("2026-09-16T12:00:00Z");
    const m = evalMemory(
      [{ text: "Has a dog called Pip", category: "life", daysAgo: 10, timesReferenced: 3, emotionalWeight: 0.2, important: true }],
      [{ text: "Lonely on Sunday evenings", emotion: "loneliness", daysAgo: 2, emotionalWeight: 0.6 }],
      now,
    );
    expect(m.facts[0]).toMatchObject({ userId: EVAL_USER_ID, fact: "Has a dog called Pip", category: "life", timesReferenced: 3, userMarkedImportant: true, retiredAt: null });
    expect(m.facts[0]!.createdAt.toISOString()).toBe("2026-09-06T12:00:00.000Z");
    expect(m.feelings[0]).toMatchObject({ userId: EVAL_USER_ID, feeling: "Lonely on Sunday evenings", category: "loneliness" });
    const p = evalProfile({ name: "Maya", companionName: "Eos", path: "breakup", energy: "deep", country: "UK", ageBand: "26-35", timezone: "Europe/London", language: "en", daysSinceJoined: 21 }, now);
    expect(p.userId).toBe(EVAL_USER_ID);
    expect(p.createdAt.toISOString()).toBe("2026-08-26T12:00:00.000Z");
    expect(p.userPath).toBe("breakup");
  });
});

describe.skipIf(!DB)("POST /api/eval/turn", () => {
  let app: Express;
  let pool: pg.Pool;

  async function evalRows(): Promise<Record<string, number>> {
    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'user_id'",
    );
    const out: Record<string, number> = {};
    for (const { table_name } of tables.rows) {
      const r = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM "${table_name}" WHERE user_id = $1`, [EVAL_USER_ID]);
      out[table_name] = Number(r.rows[0]!.n);
    }
    return out;
  }

  beforeAll(async () => {
    app = (await import("../app.js")).default;
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(() => pool.end());

  const post = (body: unknown, key: string | null = KEY) => {
    const r = request(app).post("/api/eval/turn");
    return (key ? r.set("Authorization", `Bearer ${key}`) : r).send(body as object);
  };

  it("is a 404 until a key is configured, then a 401 for a wrong or missing key", async () => {
    delete process.env.EVAL_API_KEY;
    expect((await post({ message: "hi" })).status).toBe(404);
    process.env.EVAL_API_KEY = KEY;
    expect((await post({ message: "hi" }, null)).status).toBe(401);
    const wrong = await post({ message: "hi" }, KEY.slice(0, -1) + "y");
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("EVAL_UNAUTHORIZED");
  });

  it("answers a turn with the reply, the stage and the memory accounting", async () => {
    process.env.EVAL_API_KEY = KEY;
    const facts = Array.from({ length: 45 }, (_, i) => ({
      text: `Detail number ${i + 1} about their week`,
      daysAgo: i,
      timesReferenced: 1,
    }));
    // An old fact, referenced once, that only survives because they said "remember this".
    facts.push({ text: "Her grandmother's ring is in the blue box", daysAgo: 400, timesReferenced: 1, important: true } as never);
    const res = await post({
      message: "Where did I say the ring was?",
      history: [
        { role: "user", content: "Hey." },
        { role: "assistant", content: "Hey. What's on your mind?" },
      ],
      profile: { name: "Maya", path: "bereavement", daysSinceJoined: 30, country: "UK" },
      memory: { facts, feelings: [{ text: "Misses her grandmother most in the evenings", emotion: "grief", daysAgo: 3 }] },
    });
    expect(res.status, res.text).toBe(200);
    expect(typeof res.body.reply).toBe("string");
    expect(res.body.reply.length).toBeGreaterThan(0);
    expect(res.body.stage).toBe(3);
    expect(res.body.crisis).toEqual({ active: false, tier: null, helplineBlock: null });
    expect(res.body.memory.facts).toEqual({ eligible: 46, included: 40, excluded: 6 });
    expect(res.body.memory.feelings).toBe(1);
    // The message names the ring; the "remember this" fact made the cut, so
    // the hit lands above it, not below.
    expect(res.body.memory.referencedByMessage.aboveCut).toBeGreaterThanOrEqual(1);
    expect(res.body.memory.referencedByMessage.belowCut).toBe(0);
    expect(typeof res.body.model).toBe("string");
    expect("usage" in res.body).toBe(true);
    expect(res.body.flags).toEqual({ bannedComfort: [], selfNarration: [] });
    expect(res.headers["ratelimit-remaining"]).toBeDefined();
  });

  it("puts the supplied memory into the real prompt", async () => {
    const { buildSystemPrompt } = await import("../services/systemPrompt.js");
    const memory = evalMemory(
      [{ text: "Plays five-a-side on Thursdays", category: "life", daysAgo: 4, timesReferenced: 2, emotionalWeight: 0, important: false }],
      [{ text: "Dreads Monday mornings at the new job", emotion: "anxiety", daysAgo: 1, emotionalWeight: 0.5 }],
    );
    const profile = evalProfile({ name: "Sam", companionName: "Eos", path: "support", energy: "calm", country: "", ageBand: "", timezone: "UTC", language: "en", daysSinceJoined: 10 });
    const parts = await buildSystemPrompt(profile, 2, { memory });
    const whole = `${parts.stable}\n${parts.context}`;
    expect(whole).toContain("five-a-side on Thursdays");
    expect(whole).toContain("Dreads Monday mornings");
    expect(parts.memory).toEqual({ eligible: 1, included: ["Plays five-a-side on Thursdays"], excluded: [] });
  });

  it("gives a crisis message the helpline block and records no event", async () => {
    process.env.EVAL_API_KEY = KEY;
    const res = await post({ message: "I want to kill myself tonight.", profile: { country: "US" } });
    expect(res.status, res.text).toBe(200);
    expect(res.body.crisis.active).toBe(true);
    expect(res.body.crisis.tier).toBe("clear");
    expect(typeof res.body.crisis.helplineBlock).toBe("string");
    expect(res.body.reply).toContain(res.body.crisis.helplineBlock);
    const r = await pool.query<{ n: string }>("SELECT count(*) AS n FROM crisis_events WHERE user_id = $1", [EVAL_USER_ID]);
    expect(Number(r.rows[0]!.n)).toBe(0);
  });

  it("refuses a history that is not whole exchanges, and bad fields", async () => {
    process.env.EVAL_API_KEY = KEY;
    const odd = await post({ message: "hi", history: [{ role: "user", content: "x" }] });
    expect(odd.status).toBe(400);
    const wrongOrder = await post({ message: "hi", history: [{ role: "assistant", content: "x" }, { role: "user", content: "y" }] });
    expect(wrongOrder.status).toBe(400);
    const badPath = await post({ message: "hi", profile: { path: "romance" } });
    expect(badPath.status).toBe(400);
    expect(badPath.body.error).toMatch(/profile\.path/);
    expect((await post({ message: "" })).status).toBe(400);
  });

  it("stops at the daily budget with a 429", async () => {
    process.env.EVAL_API_KEY = KEY;
    // The budget is 6 for this file; earlier tests spent some of it. Keep
    // posting until the wall, then assert the wall.
    let last = 0;
    for (let i = 0; i < 8; i += 1) {
      const r = await post({ message: "Still here." });
      last = r.status;
      if (last === 429) {
        expect(r.body.code).toBe("RATE_LIMITED");
        break;
      }
    }
    expect(last).toBe(429);
  });

  it("wrote nothing under the stand-in user id, in any table", async () => {
    const rows = await evalRows();
    expect(Object.keys(rows).length).toBeGreaterThan(5);
    for (const [table, n] of Object.entries(rows)) expect(n, table).toBe(0);
  });
});
