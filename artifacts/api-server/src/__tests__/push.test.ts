/**
 * Web push — subscribe/unsubscribe routes, the atomic 2-per-day cap, dead
 * subscription pruning, the morning sweep window, and the HMAC-guarded
 * internal morning-run endpoint.
 *
 * The web-push transport is mocked via _setWebPushForTests, so no real push
 * service is contacted; everything else (routes, DB, cap enforcement) is real.
 */

import { describe, it, expect, afterEach, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import {
  sendPushToUser,
  runMorningPushSweep,
  ensureVapidKeys,
  PUSH_DAILY_CAP,
  _setWebPushForTests,
  _clearVapidCacheForTests,
} from "../services/push.js";
import { pushRunToken } from "../routes/push.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TS = Date.now();
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `push-${tag}-${TS}-${emails.length}@example.invalid`;
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
    DELETE FROM messages           WHERE user_id = ${uid};
    DELETE FROM profile            WHERE user_id = ${uid};
    DELETE FROM users              WHERE id      = ${uid};
    COMMIT;
  `);
}

/** Sign up, verify, and materialize the profile row. Returns { agent, userId }. */
async function signupUser(tag: string) {
  const email = nextEmail(tag);
  const agent = request.agent(app);
  const signupRes = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signupRes.status).toBe(201);
  const userId: number = signupRes.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  const prof = await agent.get("/api/profile");
  expect(prof.status).toBe(200);
  return { agent, userId, email };
}

function fakeSubscription(seed: string) {
  return {
    endpoint: `https://push.example.invalid/ep/${TS}-${seed}`,
    keys: { p256dh: `p256dh-${seed}`, auth: `auth-${seed}` },
  };
}

/** Injects a mock transport; returns the list of captured sends. */
function useMockTransport(sendImpl?: (sub: { endpoint: string }, payload: string) => Promise<void>) {
  const sent: Array<{ endpoint: string; payload: string }> = [];
  _setWebPushForTests({
    generateVAPIDKeys: () => ({ publicKey: "test-public-key", privateKey: "test-private-key" }),
    setVapidDetails: () => {},
    sendNotification: async (sub: { endpoint: string }, payload: string) => {
      if (sendImpl) {
        await sendImpl(sub, payload);
        return;
      }
      sent.push({ endpoint: sub.endpoint, payload });
    },
  } as Parameters<typeof _setWebPushForTests>[0]);
  return sent;
}

afterEach(async () => {
  _setWebPushForTests(null);
  _clearVapidCacheForTests();
  await Promise.all(emails.splice(0).map(cleanupUser));
});

afterAll(async () => {
  await pool.end();
});

// ─── Routes ──────────────────────────────────────────────────────────────────

describe("push subscribe/unsubscribe routes", () => {
  it("stores the device, flips pushOptIn on, and surfaces it in the profile", async () => {
    const { agent, userId } = await signupUser("sub");

    const res = await agent.post("/api/push/subscribe").send({ subscription: fakeSubscription("a") });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const subs = await pool.query("SELECT endpoint FROM push_subscriptions WHERE user_id = $1", [userId]);
    expect(subs.rowCount).toBe(1);
    const prof = await pool.query<{ push_opt_in: boolean }>(
      "SELECT push_opt_in FROM profile WHERE user_id = $1",
      [userId],
    );
    expect(prof.rows[0]!.push_opt_in).toBe(true);

    // And the GET /api/profile payload carries the flag for the Settings toggle.
    const apiProf = await agent.get("/api/profile");
    expect(apiProf.status).toBe(200);
    expect(apiProf.body.pushOptIn).toBe(true);
  });

  it("rejects malformed subscriptions", async () => {
    const { agent } = await signupUser("bad");
    const cases = [
      {},
      { subscription: { endpoint: "http://not-https.example", keys: { p256dh: "x", auth: "y" } } },
      { subscription: { endpoint: "https://ok.example/e", keys: { p256dh: "", auth: "y" } } },
      { subscription: { endpoint: "https://ok.example/e", keys: { p256dh: "x" } } },
    ];
    for (const body of cases) {
      const res = await agent.post("/api/push/subscribe").send(body);
      expect(res.status).toBe(400);
    }
  });

  it("re-subscribing the same endpoint re-binds instead of duplicating", async () => {
    const { agent, userId } = await signupUser("rebind");
    const sub = fakeSubscription("rebind");
    await agent.post("/api/push/subscribe").send({ subscription: sub });
    const again = await agent
      .post("/api/push/subscribe")
      .send({ subscription: { ...sub, keys: { p256dh: "new-p", auth: "new-a" } } });
    expect(again.status).toBe(200);

    const rows = await pool.query<{ p256dh: string }>(
      "SELECT p256dh FROM push_subscriptions WHERE user_id = $1",
      [userId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.p256dh).toBe("new-p");
  });

  it("unsubscribe without an endpoint clears every device and flips opt-in off", async () => {
    const { agent, userId } = await signupUser("unsub");
    await agent.post("/api/push/subscribe").send({ subscription: fakeSubscription("u1") });
    await agent.post("/api/push/subscribe").send({ subscription: fakeSubscription("u2") });

    const res = await agent.post("/api/push/unsubscribe").send({});
    expect(res.status).toBe(200);
    expect(res.body.remaining).toBe(0);

    const subs = await pool.query("SELECT id FROM push_subscriptions WHERE user_id = $1", [userId]);
    expect(subs.rowCount).toBe(0);
    const prof = await pool.query<{ push_opt_in: boolean }>(
      "SELECT push_opt_in FROM profile WHERE user_id = $1",
      [userId],
    );
    expect(prof.rows[0]!.push_opt_in).toBe(false);
  });

  it("unsubscribing one of two devices keeps opt-in on", async () => {
    const { agent, userId } = await signupUser("partial");
    const s1 = fakeSubscription("p1");
    await agent.post("/api/push/subscribe").send({ subscription: s1 });
    await agent.post("/api/push/subscribe").send({ subscription: fakeSubscription("p2") });

    const res = await agent.post("/api/push/unsubscribe").send({ endpoint: s1.endpoint });
    expect(res.status).toBe(200);
    expect(res.body.remaining).toBe(1);
    const prof = await pool.query<{ push_opt_in: boolean }>(
      "SELECT push_opt_in FROM profile WHERE user_id = $1",
      [userId],
    );
    expect(prof.rows[0]!.push_opt_in).toBe(true);
  });

  it("requires auth", async () => {
    const res = await request(app).post("/api/push/subscribe").send({ subscription: fakeSubscription("x") });
    expect(res.status).toBe(401);
  });
});

// ─── Sending + cap ───────────────────────────────────────────────────────────

describe("sendPushToUser", () => {
  it("returns opted_out / no_subscriptions before ever touching the cap", async () => {
    const { agent, userId } = await signupUser("gates");
    useMockTransport();

    expect(await sendPushToUser(userId, "test", { title: "t", body: "b", url: "/" })).toBe("opted_out");

    await pool.query("UPDATE profile SET push_opt_in = true WHERE user_id = $1", [userId]);
    expect(await sendPushToUser(userId, "test", { title: "t", body: "b", url: "/" })).toBe("no_subscriptions");

    const events = await pool.query("SELECT id FROM push_events WHERE user_id = $1", [userId]);
    expect(events.rowCount).toBe(0);
    void agent;
  });

  it("enforces the hard 2-per-rolling-24h cap", async () => {
    const { agent, userId } = await signupUser("cap");
    await agent.post("/api/push/subscribe").send({ subscription: fakeSubscription("cap") });
    const sent = useMockTransport();

    const outcomes = [
      await sendPushToUser(userId, "test", { title: "1", body: "b", url: "/" }),
      await sendPushToUser(userId, "morning_note", { title: "2", body: "b", url: "/" }),
      await sendPushToUser(userId, "chapter_ready", { title: "3", body: "b", url: "/chapters" }),
    ];
    expect(outcomes).toEqual(["sent", "sent", "capped"]);
    expect(sent.length).toBe(PUSH_DAILY_CAP);

    const events = await pool.query("SELECT id FROM push_events WHERE user_id = $1", [userId]);
    expect(events.rowCount).toBe(PUSH_DAILY_CAP);
  });

  it("keeps the cap atomic under concurrent sends", async () => {
    const { agent, userId } = await signupUser("race");
    await agent.post("/api/push/subscribe").send({ subscription: fakeSubscription("race") });
    useMockTransport();

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        sendPushToUser(userId, "test", { title: `r${i}`, body: "b", url: "/" }),
      ),
    );
    expect(outcomes.filter((o) => o === "sent").length).toBe(PUSH_DAILY_CAP);
    expect(outcomes.filter((o) => o === "capped").length).toBe(6 - PUSH_DAILY_CAP);

    const events = await pool.query("SELECT id FROM push_events WHERE user_id = $1", [userId]);
    expect(events.rowCount).toBe(PUSH_DAILY_CAP);
  });

  it("prunes a dead subscription on 410 and reports all_failed", async () => {
    const { agent, userId } = await signupUser("prune");
    await agent.post("/api/push/subscribe").send({ subscription: fakeSubscription("dead") });
    useMockTransport(async () => {
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    });

    const outcome = await sendPushToUser(userId, "test", { title: "t", body: "b", url: "/" });
    expect(outcome).toBe("all_failed");
    const subs = await pool.query("SELECT id FROM push_subscriptions WHERE user_id = $1", [userId]);
    expect(subs.rowCount).toBe(0);
  });

  it("increments failureCount (without pruning) on transient errors", async () => {
    const { agent, userId } = await signupUser("flaky");
    await agent.post("/api/push/subscribe").send({ subscription: fakeSubscription("flaky") });
    useMockTransport(async () => {
      throw Object.assign(new Error("timeout"), { statusCode: 502 });
    });

    const outcome = await sendPushToUser(userId, "test", { title: "t", body: "b", url: "/" });
    expect(outcome).toBe("all_failed");
    const subs = await pool.query<{ failure_count: number }>(
      "SELECT failure_count FROM push_subscriptions WHERE user_id = $1",
      [userId],
    );
    expect(subs.rowCount).toBe(1);
    expect(subs.rows[0]!.failure_count).toBe(1);
  });
});

// ─── VAPID keys ──────────────────────────────────────────────────────────────

describe("VAPID keys", () => {
  it("are stable across process cache clears (persisted in push_config)", async () => {
    useMockTransport();
    const first = await ensureVapidKeys();
    _clearVapidCacheForTests();
    const second = await ensureVapidKeys();
    expect(second.publicKey).toBe(first.publicKey);
  });

  it("are served to the client via the authed route", async () => {
    const { agent } = await signupUser("vapid");
    const res = await agent.get("/api/push/vapid-public-key");
    expect(res.status).toBe(200);
    expect(typeof res.body.publicKey).toBe("string");
    expect(res.body.publicKey.length).toBeGreaterThan(0);
  });
});

// ─── Morning sweep ───────────────────────────────────────────────────────────

describe("runMorningPushSweep", () => {
  async function morningReadyUser(tag: string) {
    const { agent, userId } = await signupUser(tag);
    await agent.post("/api/push/subscribe").send({ subscription: fakeSubscription(tag) });
    await pool.query(
      "UPDATE profile SET is_onboarding_complete = true, timezone = 'UTC' WHERE user_id = $1",
      [userId],
    );
    return userId;
  }

  it("sends inside the 6–9 AM local window, once per day", async () => {
    const userId = await morningReadyUser("morning");
    const sent = useMockTransport();

    const inWindow = new Date("2026-07-22T07:30:00Z");
    const first = await runMorningPushSweep(inWindow);
    expect(first.sent).toBeGreaterThanOrEqual(1);
    expect(sent.some((s) => s.endpoint.includes("morning"))).toBe(true);

    const again = await runMorningPushSweep(inWindow);
    expect((again.skipped.already_sent ?? 0)).toBeGreaterThanOrEqual(1);

    const events = await pool.query(
      "SELECT id FROM push_events WHERE user_id = $1 AND kind = 'morning_note'",
      [userId],
    );
    expect(events.rowCount).toBe(1);
  });

  it("never double-sends the morning note even when two sweeps race", async () => {
    const userId = await morningReadyUser("sweeprace");
    useMockTransport();

    const inWindow = new Date("2026-07-22T07:00:00Z");
    await Promise.all([runMorningPushSweep(inWindow), runMorningPushSweep(inWindow)]);

    const events = await pool.query(
      "SELECT id FROM push_events WHERE user_id = $1 AND kind = 'morning_note'",
      [userId],
    );
    expect(events.rowCount).toBe(1);
  });

  it("skips users outside the morning window", async () => {
    const userId = await morningReadyUser("midday");
    useMockTransport();

    await runMorningPushSweep(new Date("2026-07-22T13:00:00Z"));
    const events = await pool.query("SELECT id FROM push_events WHERE user_id = $1", [userId]);
    expect(events.rowCount).toBe(0);
  });
});

// ─── Internal HMAC endpoint ──────────────────────────────────────────────────

describe("POST /api/internal/push/morning-run", () => {
  it("rejects missing or wrong tokens", async () => {
    const none = await request(app).post("/api/internal/push/morning-run").send({});
    expect(none.status).toBe(401);

    const wrong = await request(app)
      .post("/api/internal/push/morning-run")
      .set("x-internal-token", "not-the-token")
      .send({});
    expect(wrong.status).toBe(401);
  });

  it("accepts the current hour's HMAC token without a session", async () => {
    useMockTransport();
    const token = pushRunToken(process.env.SESSION_SECRET!, new Date());
    const res = await request(app)
      .post("/api/internal/push/morning-run")
      .set("x-internal-token", token)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("considered");
    expect(res.body).toHaveProperty("sent");
  });
});
