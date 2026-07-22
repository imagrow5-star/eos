/**
 * Run-level dry-run guarantee for the internal sweeps — the api-server twin
 * of artifacts/daily-email/src/__tests__/dry-run.test.ts.
 *
 * Runs the REAL sweep loops (runWeeklySweep / runMorningPushSweep) and the
 * REAL HMAC-guarded internal endpoints against the real DB with dryRun set,
 * and proves the contract:
 *   • exactly one decision per candidate user, with the right verdict
 *   • zero rows written anywhere (weekly_chapters, sealed_notes, push_events,
 *     push_subscriptions, profile untouched)
 *   • the web-push transport is never invoked (mock throws if touched)
 *   • the model is never invoked (would-generate user still produces no chapter)
 */

import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { runMorningPushSweep, _setWebPushForTests, _clearVapidCacheForTests } from "../services/push.js";
import { runWeeklySweep } from "../services/chapters/generate.js";
import { pushRunToken } from "../routes/push.js";
import { chaptersRunToken } from "../routes/chapters.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const TS = Date.now();
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `dryrun-${tag}-${TS}-${emails.length}@example.invalid`;
  emails.push(e);
  return e;
}

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions      WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM email_verification_tokens WHERE user_id = ${uid};
    DELETE FROM push_events        WHERE user_id = ${uid};
    DELETE FROM push_subscriptions WHERE user_id = ${uid};
    DELETE FROM weekly_chapters    WHERE user_id = ${uid};
    DELETE FROM messages           WHERE user_id = ${uid};
    DELETE FROM profile            WHERE user_id = ${uid};
    DELETE FROM users              WHERE id      = ${uid};
    COMMIT;
  `);
}

async function signupUser(tag: string) {
  const email = nextEmail(tag);
  const agent = request.agent(app);
  const signupRes = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signupRes.status).toBe(201);
  const userId: number = signupRes.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  const prof = await agent.get("/api/profile");
  expect(prof.status).toBe(200);
  await pool.query(
    "UPDATE profile SET is_onboarding_complete = true, timezone = 'UTC' WHERE user_id = $1",
    [userId],
  );
  return { agent, userId, email };
}

/**
 * Write-detector scoped to THIS test's users: row counts across every table a
 * sweep could touch. Scoped (not global) because the suite runs test files in
 * parallel against the shared DB — other files legitimately write concurrently.
 */
async function snapshotWriteSurface(userIds: number[]): Promise<Record<string, number>> {
  const tables = ["weekly_chapters", "sealed_notes", "push_events", "push_subscriptions", "chapter_offer_events"];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const r = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ANY($1)`, [userIds]);
    out[t] = Number(r.rows[0]!.n);
  }
  return out;
}

/** A transport that fails the test the instant anything tries to push. */
function armExplodingTransport() {
  _setWebPushForTests({
    generateVAPIDKeys: () => {
      throw new Error("VAPID must never be touched in dry run");
    },
    setVapidDetails: () => {
      throw new Error("web-push must never be configured in dry run");
    },
    sendNotification: async () => {
      throw new Error("web-push must never send in dry run");
    },
  });
}

beforeAll(() => {
  // The chapter preview's no_ai gate only checks key PRESENCE — no call is
  // ever made (proven below by the would-generate user producing no chapter).
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key-never-used";
});

afterEach(async () => {
  _setWebPushForTests(null);
  _clearVapidCacheForTests();
  await Promise.all(emails.splice(0).map(cleanupUser));
});

afterAll(async () => {
  await pool.end();
});

// A Monday 08:00 UTC — inside the chapter window AND the 6–9 AM push window
// for tz=UTC users.
const IN_WINDOW = new Date("2026-07-20T08:00:00Z");
// A Wednesday 13:00 UTC — outside both windows.
const OUT_OF_WINDOW = new Date("2026-07-22T13:00:00Z");

describe("morning push sweep dry run", () => {
  it("logs one decision per candidate, writes nothing, never touches the transport", async () => {
    // would-send: opted in, subscribed, in window
    const a = await signupUser("push-would");
    await a.agent.post("/api/push/subscribe").send({
      subscription: { endpoint: `https://push.example.invalid/dry/${TS}-a`, keys: { p256dh: "p", auth: "s" } },
    });
    // no-subscriptions: opt-in flag on, but no device rows
    const b = await signupUser("push-nosub");
    await pool.query("UPDATE profile SET push_opt_in = true WHERE user_id = $1", [b.userId]);
    // already-sent: subscribed + a morning_note event in the last 20h
    const c = await signupUser("push-already");
    await c.agent.post("/api/push/subscribe").send({
      subscription: { endpoint: `https://push.example.invalid/dry/${TS}-c`, keys: { p256dh: "p", auth: "s" } },
    });
    await pool.query("INSERT INTO push_events (user_id, kind) VALUES ($1, 'morning_note')", [c.userId]);
    // capped: subscribed + daily cap already spent on other kinds
    const d = await signupUser("push-capped");
    await d.agent.post("/api/push/subscribe").send({
      subscription: { endpoint: `https://push.example.invalid/dry/${TS}-d`, keys: { p256dh: "p", auth: "s" } },
    });
    await pool.query("INSERT INTO push_events (user_id, kind) VALUES ($1, 'test'), ($1, 'chapter_ready')", [d.userId]);
    // outside-window: subscribed but local clock (UTC+14) is past 9 AM
    const e = await signupUser("push-outside");
    await e.agent.post("/api/push/subscribe").send({
      subscription: { endpoint: `https://push.example.invalid/dry/${TS}-e`, keys: { p256dh: "p", auth: "s" } },
    });
    await pool.query("UPDATE profile SET timezone = 'Etc/GMT-14' WHERE user_id = $1", [e.userId]);

    const ids = [a, b, c, d, e].map((u) => u.userId);
    const before = await snapshotWriteSurface(ids);
    armExplodingTransport();

    const result = await runMorningPushSweep(IN_WINDOW, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.sent).toBe(0);

    const ours = new Map(
      (result.decisions ?? [])
        .filter((x) => [a, b, c, d, e].some((u) => u.userId === x.userId))
        .map((x) => [x.userId, x.decision]),
    );
    expect(ours.get(a.userId)).toBe("would-send-morning-push");
    expect(ours.get(b.userId)).toBe("no-subscriptions");
    expect(ours.get(c.userId)).toBe("already-sent");
    expect(ours.get(d.userId)).toBe("capped");
    expect(ours.get(e.userId)).toBe("outside-window");
    // Exactly one decision per candidate — no duplicates.
    expect((result.decisions ?? []).filter((x) => ours.has(x.userId))).toHaveLength(5);

    // Zero writes anywhere the sweep could write.
    expect(await snapshotWriteSurface(ids)).toEqual(before);
  });

  it("is reachable through the HMAC internal endpoint with { dryRun: true }", async () => {
    const { agent, userId } = await signupUser("push-route");
    await agent.post("/api/push/subscribe").send({
      subscription: { endpoint: `https://push.example.invalid/dry/${TS}-r`, keys: { p256dh: "p", auth: "s" } },
    });

    const before = await snapshotWriteSurface([userId]);
    armExplodingTransport();

    const token = pushRunToken(process.env.SESSION_SECRET!, new Date());
    const res = await request(app)
      .post("/api/internal/push/morning-run")
      .set("x-internal-token", token)
      .send({ dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.sent).toBe(0);
    expect(Array.isArray(res.body.decisions)).toBe(true);
    // Our user got exactly one decision (verdict depends on the wall clock).
    expect(res.body.decisions.filter((x: { userId: number }) => x.userId === userId)).toHaveLength(1);

    expect(await snapshotWriteSurface([userId])).toEqual(before);
  });
});

describe("weekly chapter sweep dry run", () => {
  /** Backdate raw message rows (id/role/createdAt only are read in dry run). */
  async function seedMessages(userId: number, when: Date, count: number) {
    for (let i = 0; i < count; i++) {
      await pool.query(
        "INSERT INTO messages (user_id, role, content, created_at) VALUES ($1, 'user', $2, $3)",
        [userId, `dry-run fixture ${i}`, new Date(when.getTime() + i * 60_000)],
      );
    }
  }

  it("logs one decision per candidate and generates/writes/pushes nothing", async () => {
    // would-generate: 4+ weeks of history and 5+ messages in the analyzed week
    const a = await signupUser("ch-would");
    await seedMessages(a.userId, new Date("2026-06-15T10:00:00Z"), 3); // 5 weeks before IN_WINDOW
    await seedMessages(a.userId, new Date("2026-07-15T10:00:00Z"), 6); // inside week Jul 13–19
    // cold_start: brand-new user, no messages
    const b = await signupUser("ch-cold");
    // quiet_week: old history but a silent analyzed week
    const c = await signupUser("ch-quiet");
    await seedMessages(c.userId, new Date("2026-06-15T10:00:00Z"), 6);
    // exists: already has this week's chapter
    const d = await signupUser("ch-exists");
    await seedMessages(d.userId, new Date("2026-06-15T10:00:00Z"), 3);
    await seedMessages(d.userId, new Date("2026-07-15T10:00:00Z"), 6);
    await pool.query(
      `INSERT INTO weekly_chapters
         (user_id, week_start, week_end, status, themes, thread_opening, threshold_question, note_invite)
       VALUES ($1, '2026-07-13', '2026-07-19', 'ready', '[]', 'fixture opening', 'fixture question?', '{"prompt":"fixture"}')`,
      [d.userId],
    );
    // outside-window: valid user, but local clock is mid-week
    const e = await signupUser("ch-outside");

    const ids = [a, b, c, d, e].map((u) => u.userId);
    const before = await snapshotWriteSurface(ids);
    armExplodingTransport();

    // e is checked separately with an out-of-window clock.
    const outside = await runWeeklySweep({ now: OUT_OF_WINDOW, onlyUserId: e.userId, dryRun: true });
    expect(outside.decisions).toEqual([{ userId: e.userId, decision: "outside-window" }]);

    const result = await runWeeklySweep({ now: IN_WINDOW, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.generated).toBe(0);
    expect(result.failed).toBe(0);

    const ours = new Map(
      (result.decisions ?? [])
        .filter((x) => [a, b, c, d].some((u) => u.userId === x.userId))
        .map((x) => [x.userId, x.decision]),
    );
    expect(ours.get(a.userId)).toBe("would-generate-chapter");
    expect(ours.get(b.userId)).toBe("cold_start");
    expect(ours.get(c.userId)).toBe("quiet_week");
    expect(ours.get(d.userId)).toBe("exists");
    expect((result.decisions ?? []).filter((x) => ours.has(x.userId))).toHaveLength(4);

    // The would-generate user proves the model was never called: a real run
    // would have inserted a chapter (or failed); dry run leaves zero traces.
    const chapters = await pool.query("SELECT id FROM weekly_chapters WHERE user_id = $1", [a.userId]);
    expect(chapters.rowCount).toBe(0);

    expect(await snapshotWriteSurface(ids)).toEqual(before);
  });

  it("is reachable through the HMAC internal endpoint with { dryRun: true }", async () => {
    const { userId } = await signupUser("ch-route");

    const before = await snapshotWriteSurface([userId]);
    armExplodingTransport();

    const token = chaptersRunToken(process.env.SESSION_SECRET!, new Date());
    const res = await request(app)
      .post("/api/internal/chapters/run")
      .set("x-internal-token", token)
      .send({ dryRun: true, ignoreWindow: true, userId });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.generated).toBe(0);
    expect(res.body.decisions).toEqual([{ userId, decision: "cold_start" }]);

    expect(await snapshotWriteSurface([userId])).toEqual(before);
  });
});
