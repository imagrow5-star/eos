/**
 * Voice-minute metering (phase 3).
 *
 * THE invariant this file exists to pin: with VOICE_CAPS_ENFORCED unset
 * (the shipping default), NOBODY is ever blocked — measurement runs, the
 * gate does not. Everything else is layered on top of that:
 *  - a usage row opens at session start and the response carries its id;
 *  - the call-ended beacon closes it (idempotent, own-rows-only, clamped);
 *  - the sweeper closes abandoned rows from their last recorded activity,
 *    never charging a silent hour;
 *  - monthly aggregation counts open calls' live elapsed time and anchors
 *    to the subscription period when there is one;
 *  - flag ON: under-cap connects, at-cap blocks warmly, trials get 30
 *    minutes, legacy users are unlimited, and a crisis context bypasses
 *    the gate entirely (never paywall a crisis);
 *  - 75%/90% warnings queue once per window and deliver exactly once on
 *    the next app open — never mid-conversation;
 *  - GET /api/billing/usage requires auth and reports both shapes.
 *
 * Env: ELEVENLABS_AGENT_ID set + ELEVENLABS_API_KEY unset → the session
 * route takes the public-agent path, so no request ever leaves the process.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import {
  db,
  subscriptionsTable,
  voiceUsageTable,
  messagesTable,
  sealedNotesTable,
  personalizationStateTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  startVoiceUsage,
  closeVoiceUsage,
  sweepAbandonedVoiceCalls,
  getMonthlyVoiceUsage,
  evaluateVoiceGate,
  shouldBypassVoiceCap,
  capMinutesFor,
  deliverPendingVoiceNotice,
  isVoiceCapsEnforced,
  MAX_CALL_SECONDS,
  NO_ACTIVITY_GRACE_SECONDS,
  TRIAL_ALLOWANCE_MINUTES,
} from "../services/voiceMetering.js";
import { getUserTier } from "../services/tiers.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

const PRIOR_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const PRIOR_API_KEY = process.env.ELEVENLABS_API_KEY;
const PRIOR_ENFORCED = process.env.VOICE_CAPS_ENFORCED;

beforeAll(() => {
  process.env.ELEVENLABS_AGENT_ID = "agent_metering_test";
  delete process.env.ELEVENLABS_API_KEY; // public-agent path — no outbound fetch
  delete process.env.VOICE_CAPS_ENFORCED; // the shipping default: OFF
});

afterEach(() => {
  // Every test that flips the flag gets it flipped back — the default state
  // (measure, never block) must hold between tests exactly as in production.
  delete process.env.VOICE_CAPS_ENFORCED;
});

afterAll(async () => {
  if (PRIOR_AGENT_ID === undefined) delete process.env.ELEVENLABS_AGENT_ID;
  else process.env.ELEVENLABS_AGENT_ID = PRIOR_AGENT_ID;
  if (PRIOR_API_KEY === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = PRIOR_API_KEY;
  if (PRIOR_ENFORCED === undefined) delete process.env.VOICE_CAPS_ENFORCED;
  else process.env.VOICE_CAPS_ENFORCED = PRIOR_ENFORCED;
  await Promise.all(emails.splice(0).map(cleanupUser));
  await pool.end();
});

function nextEmail(tag: string): string {
  const e = `vmeter-${tag}-${Date.now()}-${emails.length}@example.invalid`;
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
    DELETE FROM email_verification_tokens WHERE user_id = ${uid};
    DELETE FROM messages              WHERE user_id = ${uid};
    DELETE FROM sealed_notes          WHERE user_id = ${uid};
    DELETE FROM personalization_state WHERE user_id = ${uid};
    DELETE FROM voice_usage           WHERE user_id = ${uid};
    DELETE FROM subscriptions         WHERE user_id = ${uid};
    DELETE FROM profile               WHERE user_id = ${uid};
    DELETE FROM users                 WHERE id      = ${uid};
    COMMIT;
  `);
}

async function signupUser(tag: string) {
  const email = nextEmail(tag);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(res.status).toBe(201);
  const userId: number = res.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  return { agent, userId };
}

/** A finished call `seconds` long, started `startedAgoMs` ago (default: just now, backdated by its own length). */
async function seedClosedCall(
  userId: number,
  seconds: number,
  startedAt: Date = new Date(Date.now() - seconds * 1000 - 1000),
): Promise<void> {
  await db.insert(voiceUsageTable).values({
    userId,
    callStartedAt: startedAt,
    callEndedAt: new Date(startedAt.getTime() + seconds * 1000),
    durationSeconds: seconds,
    source: "client_report",
  });
}

/** Mid-period subscription: window = [now − 15d, now + 15d], so seeded calls
 * from the recent past land inside it deterministically. */
async function seedSubscription(
  userId: number,
  tier: string,
  status: string,
  extra: Partial<{ trialEndsAt: Date }> = {},
): Promise<{ periodEnd: Date }> {
  const periodEnd = new Date(Date.now() + 15 * 86_400_000);
  await db.insert(subscriptionsTable).values({
    userId,
    tier,
    status,
    currentPeriodEndsAt: periodEnd,
    createdAt: new Date(Date.now() - 15 * 86_400_000),
    trialEndsAt: extra.trialEndsAt ?? null,
  });
  return { periodEnd };
}

// ─── Duration recording (always on) ──────────────────────────────────────────

describe("duration recording", () => {
  it("opens a usage row at session start and returns its id", async () => {
    const { agent, userId } = await signupUser("open");
    const res = await agent.post("/api/voice-agent/session").send({});
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.mode).toBe("public");
    expect(typeof res.body.usageId).toBe("number");

    const [row] = await db
      .select()
      .from(voiceUsageTable)
      .where(eq(voiceUsageTable.id, res.body.usageId));
    expect(row).toBeDefined();
    expect(row!.userId).toBe(userId);
    expect(row!.durationSeconds).toBeNull(); // open until the beacon/sweeper
  });

  it("call-ended beacon closes the row; a repeat beacon changes nothing", async () => {
    const { agent, userId } = await signupUser("beacon");
    const usageId = await startVoiceUsage(userId);
    // Backdate the start so the close records a real ~90s duration.
    await pool.query("UPDATE voice_usage SET call_started_at = NOW() - INTERVAL '90 seconds' WHERE id = $1", [usageId]);

    const res = await agent.post("/api/voice-agent/call-ended").send({ usageId });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.durationSeconds).toBeGreaterThanOrEqual(85);
    expect(res.body.durationSeconds).toBeLessThanOrEqual(95);
    const firstDuration = res.body.durationSeconds;

    // Idempotent: the second close is a no-op and the duration is unchanged.
    const again = await agent.post("/api/voice-agent/call-ended").send({ usageId });
    expect(again.status).toBe(200);
    const [row] = await db.select().from(voiceUsageTable).where(eq(voiceUsageTable.id, usageId));
    expect(row!.durationSeconds).toBe(firstDuration);
  });

  it("rejects a missing usageId and never closes another user's row", async () => {
    const { userId: victimId } = await signupUser("victim");
    const { agent: attacker } = await signupUser("attacker");
    const usageId = await startVoiceUsage(victimId);

    expect((await attacker.post("/api/voice-agent/call-ended").send({})).status).toBe(400);

    await attacker.post("/api/voice-agent/call-ended").send({ usageId });
    const [row] = await db.select().from(voiceUsageTable).where(eq(voiceUsageTable.id, usageId));
    expect(row!.durationSeconds).toBeNull(); // still open — attacker touched nothing
  });

  it("clamps durations: never negative, never above the per-call maximum", async () => {
    const { userId } = await signupUser("clamp");

    // endAt before start (clock skew / duplicate beacon weirdness) → 0.
    const early = await startVoiceUsage(userId);
    const negative = await closeVoiceUsage(early, userId, "client_report", new Date(Date.now() - 60_000));
    expect(negative.durationSeconds).toBe(0);

    // A row open for 2 hours closes at the 1-hour clamp, not 7200.
    const marathon = await startVoiceUsage(userId);
    await pool.query("UPDATE voice_usage SET call_started_at = NOW() - INTERVAL '2 hours' WHERE id = $1", [marathon]);
    const clamped = await closeVoiceUsage(marathon, userId, "client_report");
    expect(clamped.durationSeconds).toBe(MAX_CALL_SECONDS);
  });
});

// ─── Abandoned-call sweeper ───────────────────────────────────────────────────

describe("sweeper", () => {
  it("closes stale rows from their last activity — never charging a silent hour", async () => {
    const { userId } = await signupUser("sweep");

    // Call started 2h ago; last spoken turn (rolling call_ended_at) 30min in.
    const active = await startVoiceUsage(userId);
    await pool.query(
      `UPDATE voice_usage SET call_started_at = NOW() - INTERVAL '2 hours',
        call_ended_at = NOW() - INTERVAL '90 minutes' WHERE id = $1`,
      [active],
    );
    // Call started 2h ago with NO activity at all (connect that never spoke).
    const silent = await startVoiceUsage(userId);
    await pool.query("UPDATE voice_usage SET call_started_at = NOW() - INTERVAL '2 hours' WHERE id = $1", [silent]);
    // Young open call — the sweeper must not touch a call in progress.
    const young = await startVoiceUsage(userId);

    const closed = await sweepAbandonedVoiceCalls();
    expect(closed).toBeGreaterThanOrEqual(2);

    const rows = await db.select().from(voiceUsageTable).where(eq(voiceUsageTable.userId, userId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(active)!.durationSeconds).toBe(30 * 60); // last evidence, not the full 2h
    expect(byId.get(active)!.source).toBe("sweeper");
    expect(byId.get(silent)!.durationSeconds).toBe(NO_ACTIVITY_GRACE_SECONDS);
    expect(byId.get(young)!.durationSeconds).toBeNull(); // untouched

    await closeVoiceUsage(young, userId, "client_report"); // tidy
  });
});

// ─── Monthly aggregation ──────────────────────────────────────────────────────

describe("getMonthlyVoiceUsage", () => {
  it("counts closed calls PLUS the live elapsed time of open calls", async () => {
    const { userId } = await signupUser("agg-open");
    await seedClosedCall(userId, 600);
    const open = await startVoiceUsage(userId);
    await pool.query("UPDATE voice_usage SET call_started_at = NOW() - INTERVAL '300 seconds' WHERE id = $1", [open]);

    const usage = await getMonthlyVoiceUsage(userId);
    expect(usage.usedSeconds).toBeGreaterThanOrEqual(895);
    expect(usage.usedSeconds).toBeLessThanOrEqual(905);

    await closeVoiceUsage(open, userId, "client_report");
  });

  it("anchors the window to the subscription period when one is current", async () => {
    const { userId } = await signupUser("agg-anchor");
    const { periodEnd } = await seedSubscription(userId, "companion", "active");

    await seedClosedCall(userId, 999, new Date(Date.now() - 25 * 86_400_000)); // before period start
    await seedClosedCall(userId, 300, new Date(Date.now() - 5 * 86_400_000)); // inside the period

    const usage = await getMonthlyVoiceUsage(userId);
    expect(usage.usedSeconds).toBe(300);
    expect(usage.windowEnd.getTime()).toBe(periodEnd.getTime());
  });

  it("falls back to the UTC calendar month without a subscription", async () => {
    const { userId } = await signupUser("agg-cal");
    await seedClosedCall(userId, 999, new Date(Date.now() - 40 * 86_400_000)); // last month
    await seedClosedCall(userId, 120, new Date(Date.now() - 60_000)); // this month

    const usage = await getMonthlyVoiceUsage(userId);
    expect(usage.usedSeconds).toBe(120);
    const now = new Date();
    expect(usage.windowEnd.getTime()).toBe(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );
  });
});

// ─── The gate, flag ON ────────────────────────────────────────────────────────

describe("gate with VOICE_CAPS_ENFORCED=true", () => {
  it("connects a subscriber under their cap", async () => {
    const { agent, userId } = await signupUser("under");
    await seedSubscription(userId, "companion", "active");
    await seedClosedCall(userId, 100 * 60); // 100 of 150 minutes

    process.env.VOICE_CAPS_ENFORCED = "true";
    const res = await agent.post("/api/voice-agent/session").send({});
    expect(res.body.available).toBe(true);
    expect(typeof res.body.usageId).toBe("number");
  });

  it("blocks at the cap with warm copy, a reset date, and no usage row", async () => {
    const { agent, userId } = await signupUser("atcap");
    const { periodEnd } = await seedSubscription(userId, "companion", "active");
    await seedClosedCall(userId, 150 * 60); // the full 150 minutes

    process.env.VOICE_CAPS_ENFORCED = "true";
    const res = await agent.post("/api/voice-agent/session").send({});
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.reason).toBe("minutes_exhausted");
    expect(res.body.message).toMatch(/Text never stops/i);
    expect(res.body.message).not.toMatch(/error|limit exceeded|denied/i); // warm, not clinical
    expect(res.body.usedMinutes).toBe(150);
    expect(res.body.capMinutes).toBe(150);
    expect(new Date(res.body.resetAt).getTime()).toBe(periodEnd.getTime());

    // A blocked start opens NO usage row.
    const rows = await db.select().from(voiceUsageTable).where(eq(voiceUsageTable.userId, userId));
    expect(rows.filter((r) => r.durationSeconds === null)).toHaveLength(0);
  });

  it("gives trials 30 total minutes", async () => {
    const { agent, userId } = await signupUser("trial");
    await seedSubscription(userId, "closer", "trialing", {
      trialEndsAt: new Date(Date.now() + 5 * 86_400_000),
    });
    await seedClosedCall(userId, 29 * 60);

    process.env.VOICE_CAPS_ENFORCED = "true";
    // 29 of 30 trial minutes → still connects (NOT the closer tier's 400).
    const under = await agent.post("/api/voice-agent/session").send({});
    expect(under.body.available).toBe(true);
    await agent.post("/api/voice-agent/call-ended").send({ usageId: under.body.usageId });

    await seedClosedCall(userId, 2 * 60); // now past 30
    const over = await agent.post("/api/voice-agent/session").send({});
    expect(over.body.available).toBe(false);
    expect(over.body.reason).toBe("minutes_exhausted");
    expect(over.body.capMinutes).toBe(TRIAL_ALLOWANCE_MINUTES);
  });

  it("CRISIS BYPASS: recent crisis language connects even at the cap", async () => {
    const { agent, userId } = await signupUser("crisis-msg");
    await seedSubscription(userId, "companion", "active");
    await seedClosedCall(userId, 150 * 60);
    await db.insert(messagesTable).values({
      userId,
      role: "user",
      content: "i keep thinking about killing myself and i don't know what to do",
    });

    process.env.VOICE_CAPS_ENFORCED = "true";
    const res = await agent.post("/api/voice-agent/session").send({});
    expect(res.body.available).toBe(true); // never paywall a crisis
    expect(typeof res.body.usageId).toBe("number");
  });

  it("CRISIS BYPASS: a crisis-flagged sealed note also bypasses", async () => {
    const { userId } = await signupUser("crisis-note");
    await seedSubscription(userId, "companion", "active");
    await seedClosedCall(userId, 150 * 60);
    await db.insert(sealedNotesTable).values({
      userId,
      chapterId: 900_000_000 + userId, // unique per chapter constraint
      weekStart: "2026-07-20",
      kind: "free",
      text: "note text",
      crisisFlagged: true,
    });

    expect(await shouldBypassVoiceCap(userId)).toBe(true);

    process.env.VOICE_CAPS_ENFORCED = "true";
    const tier = await getUserTier(userId);
    const gate = await evaluateVoiceGate(userId, tier);
    expect(gate.blocked).toBe(false);
    expect(gate.crisisBypass).toBe(true);
  });

  it("legacy full-access users are unlimited", async () => {
    const { agent, userId } = await signupUser("legacy");
    await seedClosedCall(userId, 5000 * 60); // 5000 minutes — irrelevant

    process.env.VOICE_CAPS_ENFORCED = "true";
    const res = await agent.post("/api/voice-agent/session").send({});
    expect(res.body.available).toBe(true);

    const tier = await getUserTier(userId);
    expect(capMinutesFor(tier)).toBeNull();
  });
});

// ─── The invariant: flag OFF blocks nobody ────────────────────────────────────

describe("VOICE_CAPS_ENFORCED off (the shipping default)", () => {
  it("never blocks — even a subscriber wildly over their cap", async () => {
    const { agent, userId } = await signupUser("flagoff");
    await seedSubscription(userId, "companion", "active");
    await seedClosedCall(userId, 1000 * 60); // 1000 minutes on a 150-minute plan

    expect(isVoiceCapsEnforced()).toBe(false); // default: unset
    const res = await agent.post("/api/voice-agent/session").send({});
    expect(res.body.available).toBe(true);
    expect(typeof res.body.usageId).toBe("number"); // measurement still on

    process.env.VOICE_CAPS_ENFORCED = "false"; // explicit "false" is also off
    expect(isVoiceCapsEnforced()).toBe(false);
    const tier = await getUserTier(userId);
    expect((await evaluateVoiceGate(userId, tier)).blocked).toBe(false);
  });

  it("records no warnings while off", async () => {
    const { userId } = await signupUser("flagoff-warn");
    await seedSubscription(userId, "companion", "active");
    await seedClosedCall(userId, 110 * 60); // 73%

    const usageId = await startVoiceUsage(userId);
    await pool.query("UPDATE voice_usage SET call_started_at = NOW() - INTERVAL '10 minutes' WHERE id = $1", [usageId]);
    await closeVoiceUsage(usageId, userId, "client_report"); // crosses 75% — flag off

    const [state] = await db
      .select()
      .from(personalizationStateTable)
      .where(eq(personalizationStateTable.userId, userId));
    expect(state?.voiceNotice75At ?? null).toBeNull();
    expect(state?.voiceNoticePending ?? null).toBeNull();
  });
});

// ─── 75% / 90% warnings (flag on) ────────────────────────────────────────────

describe("usage warnings", () => {
  it("queues each threshold once and delivers on the next app open, exactly once", async () => {
    const { agent, userId } = await signupUser("warn");
    await seedSubscription(userId, "companion", "active");
    process.env.VOICE_CAPS_ENFORCED = "true";

    // 108 min closed (72%), then a 10-min call → 118 min (78.7%): crosses 75.
    await seedClosedCall(userId, 108 * 60);
    const call1 = await startVoiceUsage(userId);
    await pool.query("UPDATE voice_usage SET call_started_at = NOW() - INTERVAL '10 minutes' WHERE id = $1", [call1]);
    await closeVoiceUsage(call1, userId, "client_report");

    let [state] = await db
      .select()
      .from(personalizationStateTable)
      .where(eq(personalizationStateTable.userId, userId));
    expect(state?.voiceNotice75At).not.toBeNull();
    expect(state?.voiceNoticePending).toBe("75");
    const firstMark = state!.voiceNotice75At!.getTime();

    // Another small call stays under 90% — nothing new fires, mark unchanged.
    const call2 = await startVoiceUsage(userId);
    await pool.query("UPDATE voice_usage SET call_started_at = NOW() - INTERVAL '60 seconds' WHERE id = $1", [call2]);
    await closeVoiceUsage(call2, userId, "client_report");
    [state] = await db
      .select()
      .from(personalizationStateTable)
      .where(eq(personalizationStateTable.userId, userId));
    expect(state!.voiceNotice75At!.getTime()).toBe(firstMark);
    expect(state?.voiceNoticePending).toBe("75");

    // App open (GET /chat/messages) delivers the gentle note — exactly once.
    const first = await agent.get("/api/chat/messages");
    expect(first.status).toBe(200);
    const notes = (first.body as Array<{ content: string; isMorningNote?: boolean }>).filter(
      (m) => /three-quarters/.test(m.content),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.isMorningNote).toBe(true); // quiet note, not a chat reply

    const second = await agent.get("/api/chat/messages");
    const notesAgain = (second.body as Array<{ content: string }>).filter((m) =>
      /three-quarters/.test(m.content),
    );
    expect(notesAgain).toHaveLength(1); // delivered once, not per fetch

    // Crossing 90% queues the second (and last) note.
    const call3 = await startVoiceUsage(userId);
    await pool.query("UPDATE voice_usage SET call_started_at = NOW() - INTERVAL '20 minutes' WHERE id = $1", [call3]);
    await closeVoiceUsage(call3, userId, "client_report"); // ~138 min = 92%
    [state] = await db
      .select()
      .from(personalizationStateTable)
      .where(eq(personalizationStateTable.userId, userId));
    expect(state?.voiceNotice90At).not.toBeNull();
    expect(state?.voiceNoticePending).toBe("90");

    expect(await deliverPendingVoiceNotice(userId)).toBe(true);
    expect(await deliverPendingVoiceNotice(userId)).toBe(false); // claimed — gone
  });
});

// ─── GET /api/billing/usage ───────────────────────────────────────────────────

describe("GET /api/billing/usage", () => {
  it("requires a signed-in session", async () => {
    const res = await request(app).get("/api/billing/usage");
    expect(res.status).toBe(401);
  });

  it("legacy users see real usage with an unlimited total", async () => {
    const { agent, userId } = await signupUser("usage-legacy");
    await seedClosedCall(userId, 300);

    const res = await agent.get("/api/billing/usage");
    expect(res.status).toBe(200);
    expect(res.body.usedSeconds).toBe(300);
    expect(res.body.usedMinutes).toBe(5);
    expect(res.body.capMinutes).toBeNull();
    expect(res.body.unlimited).toBe(true);
    expect(res.body.enforced).toBe(false);
  });

  it("subscribers see their cap and the period reset date", async () => {
    const { agent, userId } = await signupUser("usage-sub");
    const { periodEnd } = await seedSubscription(userId, "companion", "active");
    await seedClosedCall(userId, 40 * 60);

    const res = await agent.get("/api/billing/usage");
    expect(res.body.usedMinutes).toBe(40);
    expect(res.body.capMinutes).toBe(150);
    expect(res.body.unlimited).toBe(false);
    expect(new Date(res.body.resetAt).getTime()).toBe(periodEnd.getTime());
  });
});
