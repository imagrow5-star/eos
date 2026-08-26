/**
 * Billing webhook (Dodo Payments) + billing routes.
 *
 * No real Dodo traffic: webhook deliveries are signed locally with the test
 * secret (the same Standard Webhooks HMAC scheme Dodo uses over the RAW body
 * — which also proves the raw-body mount works end-to-end through the real
 * app), and Dodo REST calls (customer lookup, cancel) are intercepted at the
 * fetch layer.
 *
 * Covers the required list: signature rejection (bad/missing/stale, and the
 * retired Paddle scheme), idempotent double-delivery, each subscription event
 * mutating the row, tier resolution from product ids, config never leaking
 * secrets, cancel endpoint auth, plus the deletion-cancels-Dodo path
 * (including Dodo being down — deletion must still succeed).
 */

import crypto from "node:crypto";
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import pg from "pg";

// Standard Webhooks secrets are base64 with a whsec_ prefix. Computed at load
// so no key-shaped base64 literal lives in the file (secret-scan.test.ts).
const RAW_WEBHOOK_KEY = "dodo-test-webhook-secret-not-real";
process.env.DODO_WEBHOOK_SECRET = "whsec_" + Buffer.from(RAW_WEBHOOK_KEY).toString("base64");
process.env.DODO_API_KEY = "test-dodo-api-key-sk-abc123";
process.env.DODO_PRODUCT_ESSENTIAL = "prod_essential_test";
process.env.DODO_PRODUCT_STANDARD = "prod_standard_test";
process.env.DODO_PRODUCT_FULL = "prod_full_test";

// ── Dodo REST interception (customer lookup + cancel) ───────────────────────
const dodoCalls: Array<{ url: string; method: string }> = [];
let customerEmailByThisTest: string | null = null;
let dodoCancelFails = false;

const priorFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://live.dodopayments.com/")) {
    dodoCalls.push({ url, method: init?.method ?? "GET" });
    if (url.includes("/subscriptions/") && init?.method === "PATCH") {
      return Promise.resolve(
        dodoCancelFails
          ? new Response("simulated dodo outage", { status: 500 })
          : new Response(JSON.stringify({ status: "cancelled", cancel_at_next_billing_date: true }), {
              status: 200,
            }),
      );
    }
    if (url.includes("/customers/")) {
      // Dodo returns the Customer object directly, with a top-level email.
      return Promise.resolve(
        new Response(
          JSON.stringify({ customer_id: "ctm_x", name: "x", email: customerEmailByThisTest }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }
  return priorFetch(input, init);
}) as typeof fetch;

import app from "../app.js";
import { signDodoPayloadForTests } from "../services/dodo.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];
const eventIds: string[] = [];

function nextEmail(tag: string): string {
  const e = `paddle-${tag}-${Date.now()}-${emails.length}@example.invalid`;
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

let eventSeq = 0;
function subscriptionPayload(opts: {
  type?: string;
  userId?: number | null;
  priceId?: string;
  status?: string;
  subId?: string;
  customerId?: string;
  trialEnd?: string | null;
  periodEnd?: string | null;
}): { raw: string; eventId: string } {
  const eventId = `evt_test_${Date.now()}_${eventSeq++}`;
  eventIds.push(eventId);
  const raw = JSON.stringify({
    event_id: eventId,
    event_type: opts.type ?? "subscription.created",
    data: {
      id: opts.subId ?? "sub_test_1",
      customer_id: opts.customerId ?? "ctm_test_1",
      status: opts.status ?? "trialing",
      custom_data: opts.userId === null ? null : { user_id: opts.userId },
      items: [
        {
          price: { id: opts.priceId ?? "prod_essential_test" },
          trial_dates: { ends_at: opts.trialEnd ?? "2026-08-06T00:00:00Z" },
        },
      ],
      current_billing_period: { ends_at: opts.periodEnd ?? "2026-08-06T00:00:00Z" },
    },
  });
  return { raw, eventId };
}

/** Standard Webhooks header triple for one delivery. */
interface SigHeaders {
  id: string;
  timestamp: number;
  signature: string;
}

function postWebhook(raw: string, sig?: SigHeaders) {
  const req2 = request(app)
    .post("/api/billing/webhook")
    .set("Content-Type", "application/json");
  if (sig !== undefined) {
    req2
      .set("webhook-id", sig.id)
      .set("webhook-timestamp", String(sig.timestamp))
      .set("webhook-signature", sig.signature);
  }
  return req2.send(raw);
}

let msgSeq = 0;
function sign(raw: string, ts?: number): SigHeaders {
  const id = `msg_test_${Date.now()}_${msgSeq++}`;
  const timestamp = ts ?? Math.floor(Date.now() / 1000);
  return {
    id,
    timestamp,
    signature: signDodoPayloadForTests(raw, process.env.DODO_WEBHOOK_SECRET!, id, timestamp),
  };
}

async function subRow(userId: number) {
  const r = await pool.query(
    `SELECT tier, status, dodo_customer_id, dodo_subscription_id, trial_ends_at, current_period_ends_at
     FROM subscriptions WHERE user_id = $1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

beforeAll(() => {
  dodoCalls.length = 0;
});

afterAll(async () => {
  for (const id of eventIds) {
    await pool.query(`DELETE FROM billing_events WHERE event_id = $1`, [id]);
  }
  await Promise.all(emails.splice(0).map(cleanupUser));
  await pool.end();
  globalThis.fetch = priorFetch;
});

describe("webhook signature verification", () => {
  it("rejects a missing signature with 401 and records nothing", async () => {
    const { raw, eventId } = subscriptionPayload({});
    const res = await postWebhook(raw);
    expect(res.status).toBe(401);
    const led = await pool.query(`SELECT 1 FROM billing_events WHERE event_id = $1`, [eventId]);
    expect(led.rowCount).toBe(0);
  });

  it("rejects a forged signature with 401", async () => {
    const { raw } = subscriptionPayload({});
    const forged = sign(raw);
    forged.signature = "v1," + Buffer.from("0".repeat(32)).toString("base64");
    const res = await postWebhook(raw, forged);
    expect(res.status).toBe(401);
  });

  it("rejects a Paddle-style signature (retired scheme) with 401", async () => {
    const { raw, eventId } = subscriptionPayload({});
    // A correctly-computed signature in Paddle's OLD format (ts=..;h1=<hex
    // hmac over `${ts}:${body}`), sent under Paddle's old header, with no
    // Standard Webhooks headers. The old scheme must no longer authenticate.
    const ts = Math.floor(Date.now() / 1000);
    const h1 = crypto.createHmac("sha256", RAW_WEBHOOK_KEY).update(`${ts}:${raw}`).digest("hex");
    const res = await request(app)
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .set("Paddle-Signature", `ts=${ts};h1=${h1}`)
      .send(raw);
    expect(res.status).toBe(401);
    const led = await pool.query(`SELECT 1 FROM billing_events WHERE event_id = $1`, [eventId]);
    expect(led.rowCount).toBe(0);
  });

  it("rejects a tampered body (valid signature over different bytes)", async () => {
    const { raw } = subscriptionPayload({});
    const res = await postWebhook(raw.replace("trialing", "active__"), sign(raw));
    expect(res.status).toBe(401);
  });

  it("rejects a stale timestamp (replay defense)", async () => {
    const { raw } = subscriptionPayload({});
    const staleTs = Math.floor(Date.now() / 1000) - 60 * 60; // an hour old
    const res = await postWebhook(raw, sign(raw, staleTs));
    expect(res.status).toBe(401);
  });
});

describe("subscription lifecycle events", () => {
  it("creates a row on subscription.created (custom_data match) and /billing/me reflects it", async () => {
    const { agent, userId } = await signupUser("created");
    const { raw } = subscriptionPayload({ userId, subId: "sub_created_1" });
    const res = await postWebhook(raw, sign(raw));
    expect(res.status).toBe(200);

    const row = await subRow(userId);
    expect(row).not.toBeNull();
    expect(row.tier).toBe("companion");
    expect(row.status).toBe("trialing");
    expect(row.dodo_subscription_id).toBe("sub_created_1");
    expect(row.dodo_customer_id).toBe("ctm_test_1");
    expect(row.trial_ends_at).not.toBeNull();
    expect(row.current_period_ends_at).not.toBeNull();

    const me = await agent.get("/api/billing/me");
    expect(me.body.kind).toBe("subscribed");
    expect(me.body.tier).toBe("companion");
    expect(me.body.status).toBe("trialing");
    expect(me.body.voiceMinutesPerMonth).toBe(120);
  });

  it("is idempotent: the same event_id delivered twice processes once", async () => {
    const { userId } = await signupUser("dupe");
    const { raw, eventId } = subscriptionPayload({ userId, subId: "sub_dupe_1" });

    expect((await postWebhook(raw, sign(raw))).status).toBe(200);
    expect((await postWebhook(raw, sign(raw))).status).toBe(200); // retry delivery

    const led = await pool.query(`SELECT COUNT(*)::int AS n FROM billing_events WHERE event_id = $1`, [eventId]);
    expect(led.rows[0]!.n).toBe(1);
    const rows = await pool.query(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE user_id = $1`, [userId]);
    expect(rows.rows[0]!.n).toBe(1);
  });

  it("subscription.updated re-resolves the tier from the price id and updates status", async () => {
    const { userId } = await signupUser("updated");
    const created = subscriptionPayload({ userId, subId: "sub_upd_1" });
    await postWebhook(created.raw, sign(created.raw));

    const updated = subscriptionPayload({
      type: "subscription.updated",
      userId,
      subId: "sub_upd_1",
      priceId: "prod_standard_test",
      status: "active",
      trialEnd: null,
      periodEnd: "2026-08-30T00:00:00Z",
    });
    expect((await postWebhook(updated.raw, sign(updated.raw))).status).toBe(200);

    const row = await subRow(userId);
    expect(row.tier).toBe("closer");
    expect(row.status).toBe("active");
  });

  it("subscription.canceled marks the row canceled", async () => {
    const { userId } = await signupUser("canceled");
    const created = subscriptionPayload({ userId, subId: "sub_can_1", status: "active", trialEnd: null });
    await postWebhook(created.raw, sign(created.raw));

    const canceled = subscriptionPayload({
      type: "subscription.canceled",
      userId,
      subId: "sub_can_1",
      status: "canceled",
      trialEnd: null,
    });
    expect((await postWebhook(canceled.raw, sign(canceled.raw))).status).toBe(200);
    expect((await subRow(userId)).status).toBe("canceled");
  });

  it("an unknown price id on a new subscription stores nothing (loud log, 200)", async () => {
    const { userId } = await signupUser("unknownprice");
    const { raw } = subscriptionPayload({ userId, priceId: "pri_someone_elses_product" });
    expect((await postWebhook(raw, sign(raw))).status).toBe(200);
    expect(await subRow(userId)).toBeNull();
  });

  it("falls back to Dodo customer email when custom_data is missing", async () => {
    const { userId, email } = await signupUser("emailmatch");
    customerEmailByThisTest = email;
    try {
      const { raw } = subscriptionPayload({ userId: null, subId: "sub_email_1", customerId: "ctm_email_1" });
      expect((await postWebhook(raw, sign(raw))).status).toBe(200);
      const row = await subRow(userId);
      expect(row).not.toBeNull();
      expect(row.dodo_subscription_id).toBe("sub_email_1");
      expect(dodoCalls.some((c) => c.url.includes("/customers/ctm_email_1"))).toBe(true);
    } finally {
      customerEmailByThisTest = null;
    }
  });

  it("transaction.payment_failed with past_due flips the matching row", async () => {
    const { userId } = await signupUser("pastdue");
    const created = subscriptionPayload({ userId, subId: "sub_pd_1", status: "active", trialEnd: null });
    await postWebhook(created.raw, sign(created.raw));

    const eventId = `evt_test_${Date.now()}_${eventSeq++}`;
    eventIds.push(eventId);
    const raw = JSON.stringify({
      event_id: eventId,
      event_type: "transaction.payment_failed",
      data: { subscription_id: "sub_pd_1", status: "past_due" },
    });
    expect((await postWebhook(raw, sign(raw))).status).toBe(200);
    expect((await subRow(userId)).status).toBe("past_due");
  });
});

describe("billing routes", () => {
  it("GET /billing/config exposes tier metadata + product ids and NO secrets", async () => {
    const res = await request(app).get("/api/billing/config");
    expect(res.status).toBe(200);
    expect(res.body.checkoutAvailable).toBe(true);
    expect(res.body.tiers).toHaveLength(3);
    const companion = res.body.tiers.find((t: { id: string }) => t.id === "companion");
    expect(companion.priceId).toBe("prod_essential_test");
    expect(companion.monthlyPriceCents).toBe(1999);
    // Never leak secrets — check the raw response text for both secret values.
    expect(res.text).not.toContain(process.env.DODO_API_KEY!);
    expect(res.text).not.toContain(process.env.DODO_WEBHOOK_SECRET!);
  });

  it("POST /billing/cancel cancels the CALLER's subscription via Dodo", async () => {
    const { agent, userId } = await signupUser("cancel");
    const created = subscriptionPayload({ userId, subId: "sub_cancel_me", status: "active", trialEnd: null });
    await postWebhook(created.raw, sign(created.raw));

    const before = dodoCalls.length;
    const res = await agent.post("/api/billing/cancel");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const cancelCalls = dodoCalls.slice(before).filter((c) => c.method === "PATCH");
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]!.url).toContain("/subscriptions/sub_cancel_me");
  });

  it("POST /billing/cancel without a subscription → 404; unauthenticated → 401", async () => {
    const { agent } = await signupUser("nosub");
    expect((await agent.post("/api/billing/cancel")).status).toBe(404);
    expect((await request(app).post("/api/billing/cancel")).status).toBe(401);
  });
});

describe("account deletion cancels Dodo billing", () => {
  it("schedules a Dodo cancel during deletion", async () => {
    const { agent, userId } = await signupUser("delete");
    const created = subscriptionPayload({ userId, subId: "sub_delete_me", status: "active", trialEnd: null });
    await postWebhook(created.raw, sign(created.raw));

    const before = dodoCalls.length;
    const res = await agent.delete("/api/auth/account");
    expect(res.status).toBe(200);
    expect(
      dodoCalls
        .slice(before)
        .some((c) => c.method === "PATCH" && c.url.includes("/subscriptions/sub_delete_me")),
    ).toBe(true);
    const gone = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
    expect(gone.rowCount).toBe(0);
  });

  it("deletion still succeeds when the Dodo API is down (logged, not blocking)", async () => {
    const { agent, userId } = await signupUser("delete-outage");
    const created = subscriptionPayload({ userId, subId: "sub_delete_outage", status: "active", trialEnd: null });
    await postWebhook(created.raw, sign(created.raw));

    dodoCancelFails = true;
    try {
      const res = await agent.delete("/api/auth/account");
      expect(res.status).toBe(200); // the user's right to erase beats bookkeeping
      const gone = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
      expect(gone.rowCount).toBe(0);
    } finally {
      dodoCancelFails = false;
    }
  });
});
