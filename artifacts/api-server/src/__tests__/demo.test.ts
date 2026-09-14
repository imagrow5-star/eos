/**
 * The landing-page text demo (routes/demo.ts): the real prompt, three
 * exchanges, nothing stored.
 *
 *  • a turn streams delta events and a done event with the exchange count;
 *  • a crisis message gets the same helpline block as in the app, and still
 *    no crisis_events row (there is no account to attach one to);
 *  • the history must be whole user/assistant exchanges, and a fourth
 *    exchange is refused with demoOver;
 *  • the per-IP limiter answers 429 (small limit set before the app loads);
 *  • across all of it, no row anywhere carries the demo's stand-in user id,
 *    and the tables the chat path writes (messages, crisis_events) have no
 *    row without a real user either — "Nothing here is saved" is literal.
 *    (Other test files share this database in parallel, so global counts
 *    can't be compared; the stand-in id is the only id the demo could use.)
 *
 * Runs in keyless mock mode (no ANTHROPIC_API_KEY in the suite), which
 * exercises the whole route except the model call itself.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import pg from "pg";

process.env.DEMO_TEXT_LIMIT_PER_HOUR = "5";

// The route reads DEMO_TEXT_LIMIT_PER_HOUR when its module loads, and static
// imports are hoisted above the env assignment, so the route is imported
// dynamically (with the app) rather than at the top of this file.
let DEMO_USER_ID = 0;

const DB = Boolean(process.env.DATABASE_URL);

function lastEvent(text: string, name: string): Record<string, unknown> | null {
  const re = new RegExp(`event: ${name}\\ndata: (.*)\\n`, "g");
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(text))) last = m[1]!;
  return last ? (JSON.parse(last) as Record<string, unknown>) : null;
}

describe.skipIf(!DB)("POST /api/demo/message", () => {
  let app: Express;
  let pool: pg.Pool;

  /** Rows under the demo's stand-in id, in every table that has a user_id column. */
  async function demoRows(): Promise<Record<string, number>> {
    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'user_id'",
    );
    const out: Record<string, number> = {};
    for (const { table_name } of tables.rows) {
      const r = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM "${table_name}" WHERE user_id = $1`, [DEMO_USER_ID]);
      out[table_name] = Number(r.rows[0]!.n);
    }
    return out;
  }

  beforeAll(async () => {
    app = (await import("../app.js")).default;
    ({ DEMO_USER_ID } = await import("../routes/demo.js"));
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(() => pool.end());

  const post = (body: unknown) => request(app).post("/api/demo/message").send(body as object);

  it("streams a reply and reports the exchange count", async () => {
    const res = await post({ message: "I've been putting off calling my mother for three weeks.", history: [] });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.text).toContain("event: delta");
    const done = lastEvent(res.text, "done");
    expect(done).not.toBeNull();
    expect(typeof done!.content).toBe("string");
    expect((done!.content as string).length).toBeGreaterThan(0);
    expect(done!.exchange).toBe(1);
    expect(done!.remaining).toBe(2);
    expect("crisisHelplineBlock" in done!).toBe(false);
  });

  it("a crisis message gets the helpline block, with no crisis event recorded", async () => {
    const res = await post({ message: "I want to kill myself", history: [] });
    expect(res.status).toBe(200);
    const done = lastEvent(res.text, "done");
    expect(done).not.toBeNull();
    const block = done!.crisisHelplineBlock as string;
    expect(block).toMatch(/^—\nSomeone who can be with you right now/);
    expect(done!.content as string).toContain(block);
  });

  it("refuses a malformed history", async () => {
    const res = await post({ message: "hi", history: [{ role: "assistant", content: "I speak first" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/malformed/);
  });

  it("refuses a fourth exchange", async () => {
    const history = [
      { role: "user", content: "one" }, { role: "assistant", content: "a" },
      { role: "user", content: "two" }, { role: "assistant", content: "b" },
      { role: "user", content: "three" }, { role: "assistant", content: "c" },
    ];
    const res = await post({ message: "four", history });
    expect(res.status).toBe(400);
    expect(res.body.demoOver).toBe(true);
  });

  it("refuses an empty message", async () => {
    const res = await post({ message: "   ", history: [] });
    expect(res.status).toBe(400);
  });

  it("the per-IP limiter answers 429 after the limit", async () => {
    const res = await post({ message: "again", history: [] });
    expect(res.status, `ratelimit-remaining=${res.headers["ratelimit-remaining"]} limit=${res.headers["ratelimit-limit"]}`).toBe(429);
    expect(res.body.error).toMatch(/demo/);
  });

  it("wrote nothing: no table holds a row for the demo's stand-in user", async () => {
    const rows = await demoRows();
    expect(Object.keys(rows).length).toBeGreaterThan(10); // the sweep found the user-owned tables
    expect(Object.values(rows).every((n) => n === 0)).toBe(true);
    // The two tables the chat path writes on every turn also hold nothing ownerless.
    for (const t of ["messages", "crisis_events"]) {
      const r = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${t} WHERE user_id IS NULL`);
      expect(Number(r.rows[0]!.n), t).toBe(0);
    }
  });
});
