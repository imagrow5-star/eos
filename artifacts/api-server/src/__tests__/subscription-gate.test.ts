/**
 * Subscription gate (entitlement stage).
 *
 * Three layers, mirroring the implementation:
 *  1. resolveAccess — the pure decision: every row status on both sides of
 *     the cutoff, the no-row cases, the exact boundary, unknown statuses.
 *  2. needsSubscription — the DB wrapper's ONE UNBENDABLE RULE, proven with
 *     injected lookups: any lookup failure grants access. A database hiccup
 *     must never lock a paying customer out.
 *  2b. chatGateStatus — the SOFT chat gate: a gated account is still let
 *     through while it has free messages left, with a countdown; grandfathered
 *     and subscribed accounts have no counter; fails open like the hard gate.
 *  3. The wired gate through the real app: the /api/auth/me flag +
 *     freeMessagesRemaining, and 402 behaviour — chat endpoints honour the
 *     free window, /voice-agent/session never does (no free voice).
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import {
  needsSubscription,
  chatGateStatus,
  resolveAccess,
  SUBSCRIPTION_REQUIRED_AFTER,
  FREE_MESSAGE_LIMIT,
  type GateLookups,
} from "../services/tiers.js";

const DAY_MS = 86_400_000;
// Pure tests pin their own cutoff so they don't move when the real constant does.
const CUTOFF = new Date("2030-01-01T00:00:00Z");
const BEFORE = new Date(CUTOFF.getTime() - DAY_MS);
const AFTER = new Date(CUTOFF.getTime() + DAY_MS);

describe("resolveAccess (pure decision)", () => {
  const LIVE = ["trialing", "active", "past_due"] as const;
  const DEAD = ["canceled", "paused"] as const;

  it.each(LIVE)("post-cutoff + %s row → granted", (status) => {
    expect(resolveAccess({ status }, AFTER, CUTOFF)).toBe("granted");
  });

  it.each(DEAD)("post-cutoff + %s row → needs_subscription", (status) => {
    expect(resolveAccess({ status }, AFTER, CUTOFF)).toBe("needs_subscription");
  });

  it("post-cutoff + no row → needs_subscription", () => {
    expect(resolveAccess(null, AFTER, CUTOFF)).toBe("needs_subscription");
  });

  it.each([...LIVE, ...DEAD])("pre-cutoff + %s row → granted (grandfather wins over row state)", (status) => {
    expect(resolveAccess({ status }, BEFORE, CUTOFF)).toBe("granted");
  });

  it("pre-cutoff + no row → granted", () => {
    expect(resolveAccess(null, BEFORE, CUTOFF)).toBe("granted");
  });

  it("created exactly AT the cutoff → granted (on-or-before is grandfathered)", () => {
    expect(resolveAccess(null, new Date(CUTOFF), CUTOFF)).toBe("granted");
  });

  it("post-cutoff + UNKNOWN row status → granted (fail open, matches getUserTier)", () => {
    expect(resolveAccess({ status: "on_hold_v2_future" }, AFTER, CUTOFF)).toBe("granted");
  });
});

describe("needsSubscription fail-open (the one unbendable rule)", () => {
  const gatedCreatedAt = new Date(SUBSCRIPTION_REQUIRED_AFTER.getTime() + DAY_MS);

  it("grants access when the user lookup throws", async () => {
    const lookups: GateLookups = {
      userCreatedAt: async () => {
        throw new Error("db down");
      },
      subscriptionRow: async () => null,
    };
    expect(await needsSubscription(1, lookups)).toBe(false);
  });

  it("grants access when the subscription lookup throws", async () => {
    const lookups: GateLookups = {
      userCreatedAt: async () => gatedCreatedAt,
      subscriptionRow: async () => {
        throw new Error("db down");
      },
    };
    expect(await needsSubscription(1, lookups)).toBe(false);
  });

  it("grants access when the user's creation date can't be established", async () => {
    const lookups: GateLookups = {
      userCreatedAt: async () => null,
      subscriptionRow: async () => null,
    };
    expect(await needsSubscription(1, lookups)).toBe(false);
  });

  it("still gates on positively established facts (sanity: not fail-open-everything)", async () => {
    const lookups: GateLookups = {
      userCreatedAt: async () => gatedCreatedAt,
      subscriptionRow: async () => null,
    };
    expect(await needsSubscription(1, lookups)).toBe(true);
  });
});

describe("chatGateStatus (free-message window)", () => {
  const GATED_AT = new Date(SUBSCRIPTION_REQUIRED_AFTER.getTime() + DAY_MS);
  const GRANDFATHERED_AT = new Date(SUBSCRIPTION_REQUIRED_AFTER.getTime() - DAY_MS);
  const gated = (used: number): GateLookups => ({
    userCreatedAt: async () => GATED_AT,
    subscriptionRow: async () => null,
    userMessageCount: async () => used,
  });

  it("post-cutoff, no sub, no messages → granted with a full countdown", async () => {
    expect(await chatGateStatus(1, gated(0))).toEqual({
      needsSubscription: FREE_MESSAGE_LIMIT <= 0,
      freeMessagesRemaining: FREE_MESSAGE_LIMIT,
    });
  });

  it("one below the limit → one free message left, still granted", async () => {
    if (FREE_MESSAGE_LIMIT < 1) return; // window disabled by env — nothing to prove
    expect(await chatGateStatus(1, gated(FREE_MESSAGE_LIMIT - 1))).toEqual({
      needsSubscription: false,
      freeMessagesRemaining: 1,
    });
  });

  it("at the limit → zero left, gated", async () => {
    expect(await chatGateStatus(1, gated(FREE_MESSAGE_LIMIT))).toEqual({
      needsSubscription: true,
      freeMessagesRemaining: 0,
    });
  });

  it("past the limit → clamped at zero, gated", async () => {
    expect(await chatGateStatus(1, gated(FREE_MESSAGE_LIMIT + 5))).toEqual({
      needsSubscription: true,
      freeMessagesRemaining: 0,
    });
  });

  it("grandfathered → no counter, and the message count is never even queried", async () => {
    let counted = false;
    const g = await chatGateStatus(1, {
      userCreatedAt: async () => GRANDFATHERED_AT,
      subscriptionRow: async () => null,
      userMessageCount: async () => {
        counted = true;
        return 0;
      },
    });
    expect(g).toEqual({ needsSubscription: false, freeMessagesRemaining: null });
    expect(counted).toBe(false);
  });

  it("live subscription → no counter (unlimited)", async () => {
    expect(
      await chatGateStatus(1, {
        userCreatedAt: async () => GATED_AT,
        subscriptionRow: async () => ({ status: "trialing" }),
        userMessageCount: async () => 999,
      }),
    ).toEqual({ needsSubscription: false, freeMessagesRemaining: null });
  });

  it("fails open (granted, no counter) when a lookup throws", async () => {
    expect(
      await chatGateStatus(1, {
        userCreatedAt: async () => {
          throw new Error("db down");
        },
        subscriptionRow: async () => null,
        userMessageCount: async () => 0,
      }),
    ).toEqual({ needsSubscription: false, freeMessagesRemaining: null });
  });
});

// ─── The wired gate, through the real app ────────────────────────────────────

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `gate-${tag}-${Date.now()}-${emails.length}@example.invalid`;
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
    DELETE FROM subscriptions WHERE user_id = ${uid};
    DELETE FROM messages      WHERE user_id = ${uid};
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
  return { agent, userId, email };
}

async function setCreatedAt(userId: number, date: Date): Promise<void> {
  await pool.query("UPDATE users SET created_at = $2 WHERE id = $1", [userId, date]);
}

async function setSubscription(userId: number, status: string | null): Promise<void> {
  await pool.query("DELETE FROM subscriptions WHERE user_id = $1", [userId]);
  if (status !== null) {
    await pool.query(
      "INSERT INTO subscriptions (user_id, tier, status) VALUES ($1, 'companion', $2)",
      [userId, status],
    );
  }
}

// Seed N real user messages directly. content is encryptedText over a plain
// text column and the gate only COUNTS role="user" rows (never decrypts), so
// raw ciphertext-shaped placeholders are fine here.
async function seedUserMessages(userId: number, n: number): Promise<void> {
  await pool.query("DELETE FROM messages WHERE user_id = $1", [userId]);
  for (let i = 0; i < n; i++) {
    await pool.query(
      "INSERT INTO messages (user_id, role, content) VALUES ($1, 'user', $2)",
      [userId, `seed-${i}`],
    );
  }
}

async function meFlag(agent: ReturnType<typeof request.agent>): Promise<boolean | undefined> {
  const res = await agent.get("/api/auth/me");
  expect(res.status).toBe(200);
  return res.body.needsSubscription;
}

async function meRemaining(
  agent: ReturnType<typeof request.agent>,
): Promise<number | null | undefined> {
  const res = await agent.get("/api/auth/me");
  expect(res.status).toBe(200);
  return res.body.freeMessagesRemaining;
}

const POST_CUTOFF = new Date(SUBSCRIPTION_REQUIRED_AFTER.getTime() + DAY_MS);
const PRE_CUTOFF = new Date(SUBSCRIPTION_REQUIRED_AFTER.getTime() - DAY_MS);

afterAll(async () => {
  await Promise.all(emails.splice(0).map(cleanupUser));
  await pool.end();
});

describe("subscription gate through the app", () => {
  it("post-cutoff, no row, fresh account: free window is OPEN (chat allowed, voice gated)", async () => {
    const { agent, userId } = await signupUser("free-open");
    await setCreatedAt(userId, POST_CUTOFF);

    // No messages yet → inside the free window: not flagged, full countdown.
    expect(await meFlag(agent)).toBe(false);
    expect(await meRemaining(agent)).toBe(FREE_MESSAGE_LIMIT);
    // Chat endpoints are NOT gated during the free window (they may fail
    // further in without LLM creds — this pins only that the GATE isn't what
    // blocks them)...
    expect((await agent.post("/api/chat/send").send({ content: "hi" })).status).not.toBe(402);
    expect((await agent.post("/api/chat/stream").send({ content: "hi" })).status).not.toBe(402);
    // ...but voice is never free.
    expect((await agent.post("/api/voice-agent/session").send({})).status).toBe(402);
  });

  it("post-cutoff, no row, free messages spent: wall closes (chat 402, voice 402)", async () => {
    const { agent, userId } = await signupUser("free-spent");
    await setCreatedAt(userId, POST_CUTOFF);
    await seedUserMessages(userId, FREE_MESSAGE_LIMIT);

    expect(await meFlag(agent)).toBe(true);
    expect(await meRemaining(agent)).toBe(0);
    expect((await agent.post("/api/chat/send").send({ content: "hi" })).status).toBe(402);
    expect((await agent.post("/api/chat/stream").send({ content: "hi" })).status).toBe(402);
    expect((await agent.post("/api/voice-agent/session").send({})).status).toBe(402);
  });

  it("post-cutoff account: each row status matches the approved access table", async () => {
    const { agent, userId } = await signupUser("statuses");
    await setCreatedAt(userId, POST_CUTOFF);
    // Close the free window first so this isolates the row-state decision,
    // not the free-message allowance.
    await seedUserMessages(userId, FREE_MESSAGE_LIMIT);

    const expected: Array<[string, boolean]> = [
      ["trialing", false],
      ["active", false],
      ["past_due", false], // grace during dunning
      ["canceled", true], // same as no row
      ["paused", true], // chose to stop paying
    ];
    for (const [status, gated] of expected) {
      await setSubscription(userId, status);
      expect(await meFlag(agent), `status=${status}`).toBe(gated);
    }
  });

  it("post-cutoff + trialing row: money endpoints are NOT 402-gated", async () => {
    const { agent, userId } = await signupUser("trial-open");
    await setCreatedAt(userId, POST_CUTOFF);
    await setSubscription(userId, "trialing");

    // The handlers may fail further in without LLM/voice creds — what this
    // test pins is only that the GATE isn't what blocks them.
    expect((await agent.post("/api/chat/send").send({ content: "hi" })).status).not.toBe(402);
    expect((await agent.post("/api/voice-agent/session").send({})).status).not.toBe(402);
  });

  it("pre-cutoff account with no row keeps full access", async () => {
    const { agent, userId } = await signupUser("legacy");
    await setCreatedAt(userId, PRE_CUTOFF);

    expect(await meFlag(agent)).toBe(false);
    expect(await meRemaining(agent)).toBe(null); // grandfathered → unlimited, no counter
    expect((await agent.post("/api/chat/send").send({ content: "hi" })).status).not.toBe(402);
  });

  it("pre-cutoff account with a CANCELED row still keeps access (grandfather over row state)", async () => {
    const { agent, userId } = await signupUser("legacy-canceled");
    await setCreatedAt(userId, PRE_CUTOFF);
    await setSubscription(userId, "canceled");

    expect(await meFlag(agent)).toBe(false);
    expect((await agent.post("/api/voice-agent/session").send({})).status).not.toBe(402);
  });
});
