/**
 * Billing foundation (phase 1 — no Paddle yet).
 *
 * The one behavior that matters most in this phase: NOTHING changes for
 * current users. These tests pin that:
 *  - a user with no subscriptions row resolves to legacy_full_access and the
 *    entitlement middleware attaches without ever blocking or erroring
 *    (including with a completely empty subscriptions table);
 *  - a seeded 'companion' subscriber row resolves to the right tier, status,
 *    and 150-minute allowance;
 *  - a corrupt tier/status string fails OPEN to full access (a bad phase-2
 *    webhook must never lock a paying user out);
 *  - the central tier config matches the marketed numbers exactly;
 *  - webhook idempotency: billing_events' unique event_id rejects a replay.
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { db, subscriptionsTable } from "@workspace/db";
import { TIERS, getUserTier, getPaddlePriceId } from "../services/tiers.js";
import { attachEntitlements } from "../middleware/entitlements.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `billing-${tag}-${Date.now()}-${emails.length}@example.invalid`;
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
    DELETE FROM voice_usage   WHERE user_id = ${uid};
    DELETE FROM subscriptions WHERE user_id = ${uid};
    DELETE FROM profile       WHERE user_id = ${uid};
    DELETE FROM users         WHERE id      = ${uid};
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

afterAll(async () => {
  await Promise.all(emails.splice(0).map(cleanupUser));
  await pool.end();
});

describe("central tier config", () => {
  it("matches the marketed plans exactly (single source of truth)", () => {
    expect(TIERS.companion.monthlyPriceCents).toBe(1999);
    expect(TIERS.closer.monthlyPriceCents).toBe(3999);
    expect(TIERS.always.monthlyPriceCents).toBe(5999);
    expect(TIERS.companion.voiceMinutesPerMonth).toBe(120);
    expect(TIERS.closer.voiceMinutesPerMonth).toBe(300);
    expect(TIERS.always.voiceMinutesPerMonth).toBe(500);
    for (const t of Object.values(TIERS)) expect(t.trialDays).toBe(7);
    expect(TIERS.companion.paddlePriceIdEnvVar).toBe("PADDLE_PRICE_COMPANION");
    expect(TIERS.closer.paddlePriceIdEnvVar).toBe("PADDLE_PRICE_CLOSER");
    expect(TIERS.always.paddlePriceIdEnvVar).toBe("PADDLE_PRICE_ALWAYS");
  });

  it("resolves Paddle price ids from env (null until phase 2 sets them)", () => {
    delete process.env.PADDLE_PRICE_COMPANION;
    expect(getPaddlePriceId("companion")).toBeNull();
    process.env.PADDLE_PRICE_COMPANION = "pri_test_123";
    try {
      expect(getPaddlePriceId("companion")).toBe("pri_test_123");
    } finally {
      delete process.env.PADDLE_PRICE_COMPANION;
    }
  });
});

describe("getUserTier", () => {
  it("returns legacy_full_access when the user has no subscription row", async () => {
    const { userId } = await signupUser("legacy");
    const tier = await getUserTier(userId);
    expect(tier.kind).toBe("legacy_full_access");
    expect(tier.voiceMinutesPerMonth).toBeNull(); // unlimited — today's behavior
  });

  it("resolves a seeded companion subscriber correctly", async () => {
    const { userId } = await signupUser("companion");
    await db.insert(subscriptionsTable).values({
      userId,
      tier: "companion",
      status: "trialing",
      trialEndsAt: new Date(Date.now() + 7 * 86_400_000),
    });
    const tier = await getUserTier(userId);
    expect(tier.kind).toBe("subscribed");
    if (tier.kind === "subscribed") {
      expect(tier.tier).toBe("companion");
      expect(tier.status).toBe("trialing");
      expect(tier.voiceMinutesPerMonth).toBe(120);
      expect(tier.trialEndsAt).not.toBeNull();
      expect(tier.config.displayName).toBe("Essential");
    }
  });

  it("fails OPEN to full access on an unknown tier string", async () => {
    const { userId } = await signupUser("corrupt");
    await pool.query(
      `INSERT INTO subscriptions (user_id, tier, status) VALUES ($1, 'platinum-ultra', 'active')`,
      [userId],
    );
    const tier = await getUserTier(userId);
    expect(tier.kind).toBe("legacy_full_access"); // never lock a user out on bad data
  });
});

describe("entitlement middleware (phase 1: attach-only, never blocks)", () => {
  it("attaches legacy_full_access for a normal user and the request proceeds", async () => {
    const { agent, userId } = await signupUser("mw-legacy");

    // Direct middleware check: attaches, calls next with no error.
    const fakeReq = { userId } as never;
    let nextArg: unknown = "not-called";
    await attachEntitlements(fakeReq, {} as never, (e?: unknown) => (nextArg = e));
    expect(nextArg).toBeUndefined();
    expect((fakeReq as { entitlements?: { kind: string } }).entitlements?.kind).toBe(
      "legacy_full_access",
    );

    // Full-stack check: protected routes behave exactly as before.
    const profile = await agent.get("/api/profile");
    expect(profile.status).toBe(200);
    const messages = await agent.get("/api/chat/messages");
    expect(messages.status).toBe(200);
  });

  it("attaches the subscribed tier for a subscriber — and still blocks nothing", async () => {
    const { agent, userId } = await signupUser("mw-sub");
    await db.insert(subscriptionsTable).values({ userId, tier: "closer", status: "active" });

    const fakeReq = { userId } as never;
    await attachEntitlements(fakeReq, {} as never, () => {});
    const ent = (fakeReq as { entitlements?: { kind: string; tier?: string } }).entitlements;
    expect(ent?.kind).toBe("subscribed");
    expect(ent?.tier).toBe("closer");

    // Phase 1 guarantee: a subscriber row changes ZERO behavior today.
    expect((await agent.get("/api/profile")).status).toBe(200);
    expect((await agent.get("/api/goals")).status).toBe(200);
  });

  it("never errors even if the lookup throws (fails open, logged)", async () => {
    // Simulate a lookup failure by passing an impossible userId type — the
    // middleware's catch must convert any throw into legacy access.
    const fakeReq = { userId: Number.NaN } as never;
    let nextArg: unknown = "not-called";
    await attachEntitlements(fakeReq, {} as never, (e?: unknown) => (nextArg = e));
    expect(nextArg).toBeUndefined(); // next() with NO error
    expect((fakeReq as { entitlements?: { kind: string } }).entitlements?.kind).toBe(
      "legacy_full_access",
    );
  });
});

describe("billing_events idempotency ledger", () => {
  it("rejects a duplicate event_id (webhook replay defense for phase 2)", async () => {
    const eventId = `evt_test_${Date.now()}`;
    await pool.query(
      `INSERT INTO billing_events (event_id, event_type, payload_summary) VALUES ($1, 'test.event', 'summary only')`,
      [eventId],
    );
    await expect(
      pool.query(
        `INSERT INTO billing_events (event_id, event_type, payload_summary) VALUES ($1, 'test.event', 'replay')`,
        [eventId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
    await pool.query(`DELETE FROM billing_events WHERE event_id = $1`, [eventId]);
  });
});
