/**
 * Billing webhook (Dodo Payments) + billing routes.
 *
 * No real Dodo traffic: webhook deliveries are signed locally with the test
 * secret (the same Standard Webhooks HMAC scheme Dodo uses over the RAW body
 * — which also proves the raw-body mount works end-to-end through the real
 * app), and Dodo REST calls (customer lookup, cancel) are intercepted at the
 * fetch layer. Fixtures mirror the REAL sandbox payload shape captured from
 * a test-mode trial checkout: envelope {business_id, data, timestamp, type}
 * with NO event id (idempotency keys on the webhook-id header), flat data
 * with top-level product_id/subscription_id, embedded customer, metadata.
 *
 * Covers the required list: signature rejection (bad/missing/stale, and the
 * retired Paddle scheme), header-keyed idempotent double-delivery, the full
 * approved status mapping (pending/active-trial/active/on_hold/cancelled/
 * expired), tier resolution from product ids, user matching via metadata →
 * embedded email → API lookup, config never leaking secrets, cancel endpoint
 * auth, plus the deletion-cancels-Dodo path (including Dodo being down —
 * deletion must still succeed).
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

// ── Dodo REST interception (checkout session + customer lookup + cancel) ────
const dodoCalls: Array<{ url: string; method: string }> = [];
const checkoutSessionBodies: Array<Record<string, unknown>> = [];
let customerEmailByThisTest: string | null = null;
let dodoCancelFails = false;

const priorFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://live.dodopayments.com/")) {
    dodoCalls.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/checkouts") && init?.method === "POST") {
      checkoutSessionBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(
        new Response(
          JSON.stringify({ session_id: "cks_test_1", checkout_url: "https://test.checkout.dodopayments.com/cks_test_1" }),
          { status: 200 },
        ),
      );
    }
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
const eventIds: string[] = []; // webhook-id header values — the ledger keys

function nextEmail(tag: string): string {
  const e = `dodo-${tag}-${Date.now()}-${emails.length}@example.invalid`;
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

// ── Fixtures — mirror the captured sandbox delivery ─────────────────────────

const DAY_MS = 86_400_000;

function subscriptionPayload(opts: {
  type?: string;
  /** Sets metadata.user_id; null → empty metadata (email-matching paths). */
  userId?: number | null;
  productId?: string;
  status?: string;
  subId?: string;
  customerId?: string;
  customerEmail?: string;
  /** Days of trial on the product (0 = none). Default 7, like the capture. */
  trialDays?: number;
  createdAt?: string;
  nextBillingDate?: string;
}): string {
  const now = Date.now();
  const trialDays = opts.trialDays ?? 7;
  const createdAt = opts.createdAt ?? new Date(now).toISOString();
  const nextBillingDate =
    opts.nextBillingDate ??
    new Date(now + (trialDays > 0 ? trialDays : 30) * DAY_MS).toISOString();
  return JSON.stringify({
    business_id: "bus_test_1",
    type: opts.type ?? "subscription.active",
    timestamp: new Date(now).toISOString(),
    data: {
      payload_type: "Subscription",
      subscription_id: opts.subId ?? "sub_test_1",
      customer: {
        customer_id: opts.customerId ?? "ctm_test_1",
        email: opts.customerEmail ?? "nobody@example.invalid",
        name: "Test Customer",
      },
      metadata: opts.userId === null || opts.userId === undefined ? {} : { user_id: String(opts.userId) },
      product_id: opts.productId ?? "prod_essential_test",
      status: opts.status ?? "active",
      created_at: createdAt,
      next_billing_date: nextBillingDate,
      previous_billing_date: createdAt,
      trial_period_days: trialDays,
    },
  });
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
  eventIds.push(id); // ledger cleanup — webhook-id is the idempotency key
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
  it("rejects a missing signature with 401", async () => {
    const raw = subscriptionPayload({});
    const res = await postWebhook(raw);
    expect(res.status).toBe(401);
  });

  it("rejects a forged signature with 401", async () => {
    const raw = subscriptionPayload({});
    const forged = sign(raw);
    forged.signature = "v1," + Buffer.from("0".repeat(32)).toString("base64");
    const res = await postWebhook(raw, forged);
    expect(res.status).toBe(401);
  });

  it("rejects a Paddle-style signature (retired scheme) with 401", async () => {
    const raw = subscriptionPayload({});
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
  });

  it("rejects a tampered body (valid signature over different bytes)", async () => {
    const raw = subscriptionPayload({});
    const res = await postWebhook(raw.replace("active", "paused"), sign(raw));
    expect(res.status).toBe(401);
  });

  it("rejects a stale timestamp (replay defense)", async () => {
    const raw = subscriptionPayload({});
    const staleTs = Math.floor(Date.now() / 1000) - 60 * 60; // an hour old
    const res = await postWebhook(raw, sign(raw, staleTs));
    expect(res.status).toBe(401);
  });
});

describe("subscription lifecycle events", () => {
  it("subscription.active during trial creates a trialing row (metadata match) and /billing/me reflects it", async () => {
    const { agent, userId } = await signupUser("created");
    const raw = subscriptionPayload({ userId, subId: "sub_created_1" }); // 7-day trial default
    const res = await postWebhook(raw, sign(raw));
    expect(res.status).toBe(200);

    const row = await subRow(userId);
    expect(row).not.toBeNull();
    expect(row.tier).toBe("companion");
    expect(row.status).toBe("trialing"); // active + inside trial window → trialing
    expect(row.dodo_subscription_id).toBe("sub_created_1");
    expect(row.dodo_customer_id).toBe("ctm_test_1");
    expect(row.trial_ends_at).not.toBeNull(); // = next_billing_date during trial
    expect(row.current_period_ends_at).not.toBeNull();

    const me = await agent.get("/api/billing/me");
    expect(me.body.kind).toBe("subscribed");
    expect(me.body.tier).toBe("companion");
    expect(me.body.status).toBe("trialing");
    expect(me.body.voiceMinutesPerMonth).toBe(120);
  });

  it("is idempotent: the same webhook-id delivered twice processes once", async () => {
    const { userId } = await signupUser("dupe");
    const raw = subscriptionPayload({ userId, subId: "sub_dupe_1" });
    const sig = sign(raw); // SAME headers both times — a real retry re-sends them

    expect((await postWebhook(raw, sig)).status).toBe(200);
    expect((await postWebhook(raw, sig)).status).toBe(200); // retry delivery

    const led = await pool.query(`SELECT COUNT(*)::int AS n FROM billing_events WHERE event_id = $1`, [sig.id]);
    expect(led.rows[0]!.n).toBe(1);
    const rows = await pool.query(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE user_id = $1`, [userId]);
    expect(rows.rows[0]!.n).toBe(1);
  });

  it("subscription.plan_changed re-resolves the tier from the product id; active without trial maps to active", async () => {
    const { userId } = await signupUser("planchange");
    const created = subscriptionPayload({ userId, subId: "sub_upd_1" });
    await postWebhook(created, sign(created));

    const changed = subscriptionPayload({
      type: "subscription.plan_changed",
      userId,
      subId: "sub_upd_1",
      productId: "prod_standard_test",
      status: "active",
      trialDays: 0,
    });
    expect((await postWebhook(changed, sign(changed))).status).toBe(200);

    const row = await subRow(userId);
    expect(row.tier).toBe("closer");
    expect(row.status).toBe("active");
  });

  it("subscription.on_hold marks the row past_due (failed renewal)", async () => {
    const { userId } = await signupUser("onhold");
    const created = subscriptionPayload({ userId, subId: "sub_hold_1", trialDays: 0 });
    await postWebhook(created, sign(created));

    const onHold = subscriptionPayload({
      type: "subscription.on_hold",
      userId,
      subId: "sub_hold_1",
      status: "on_hold",
      trialDays: 0,
    });
    expect((await postWebhook(onHold, sign(onHold))).status).toBe(200);
    expect((await subRow(userId)).status).toBe("past_due");
  });

  it("subscription.cancelled marks the row canceled", async () => {
    const { userId } = await signupUser("cancelled");
    const created = subscriptionPayload({ userId, subId: "sub_can_1", trialDays: 0 });
    await postWebhook(created, sign(created));

    const cancelled = subscriptionPayload({
      type: "subscription.cancelled",
      userId,
      subId: "sub_can_1",
      status: "cancelled",
      trialDays: 0,
    });
    expect((await postWebhook(cancelled, sign(cancelled))).status).toBe(200);
    expect((await subRow(userId)).status).toBe("canceled");
  });

  it("subscription.expired marks the row canceled (terminal bucket)", async () => {
    const { userId } = await signupUser("expired");
    const created = subscriptionPayload({ userId, subId: "sub_exp_1", trialDays: 0 });
    await postWebhook(created, sign(created));

    const expired = subscriptionPayload({
      type: "subscription.expired",
      userId,
      subId: "sub_exp_1",
      status: "expired",
      trialDays: 0,
    });
    expect((await postWebhook(expired, sign(expired))).status).toBe(200);
    expect((await subRow(userId)).status).toBe("canceled");
  });

  it("a pending subscription stores nothing (not yet entitled)", async () => {
    const { userId } = await signupUser("pending");
    const raw = subscriptionPayload({ userId, subId: "sub_pending_1", status: "pending" });
    expect((await postWebhook(raw, sign(raw))).status).toBe(200);
    expect(await subRow(userId)).toBeNull();
  });

  it("an unknown product id on a new subscription stores nothing (loud log, 200)", async () => {
    const { userId } = await signupUser("unknownproduct");
    const raw = subscriptionPayload({ userId, productId: "prod_someone_elses" });
    expect((await postWebhook(raw, sign(raw))).status).toBe(200);
    expect(await subRow(userId)).toBeNull();
  });

  it("matches via the embedded customer email when metadata is empty — no API call", async () => {
    const { userId, email } = await signupUser("embeddedemail");
    const before = dodoCalls.length;
    const raw = subscriptionPayload({
      userId: null, // metadata: {} — like the captured sandbox delivery
      subId: "sub_email_1",
      customerId: "ctm_email_1",
      customerEmail: email,
    });
    expect((await postWebhook(raw, sign(raw))).status).toBe(200);
    const row = await subRow(userId);
    expect(row).not.toBeNull();
    expect(row.dodo_subscription_id).toBe("sub_email_1");
    // Embedded email sufficed — the customer-lookup API must NOT be called.
    expect(dodoCalls.slice(before).some((c) => c.url.includes("/customers/"))).toBe(false);
  });

  it("falls back to the Dodo customer API when the embedded email matches no user", async () => {
    const { userId, email } = await signupUser("apifallback");
    customerEmailByThisTest = email;
    try {
      const raw = subscriptionPayload({
        userId: null,
        subId: "sub_email_2",
        customerId: "ctm_email_2",
        customerEmail: "stale-checkout-email@example.invalid",
      });
      expect((await postWebhook(raw, sign(raw))).status).toBe(200);
      const row = await subRow(userId);
      expect(row).not.toBeNull();
      expect(row.dodo_subscription_id).toBe("sub_email_2");
      expect(dodoCalls.some((c) => c.url.includes("/customers/ctm_email_2"))).toBe(true);
    } finally {
      customerEmailByThisTest = null;
    }
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

  it("POST /billing/checkout-session creates a Dodo session with metadata.user_id from the SESSION", async () => {
    const { agent, userId, email } = await signupUser("checkout");
    const res = await agent.post("/api/billing/checkout-session").send({ tier: "closer" });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://test.checkout.dodopayments.com/cks_test_1");

    const body = checkoutSessionBodies.at(-1)!;
    // The webhook's primary user matcher — must come from the session, and
    // stringified (metadata values are strings).
    expect(body.metadata).toEqual({ user_id: String(userId) });
    expect(body.product_cart).toEqual([{ product_id: "prod_standard_test", quantity: 1 }]);
    expect((body.customer as { email: string }).email).toBe(email);
    expect((body.subscription_data as { trial_period_days: number }).trial_period_days).toBe(7);
    expect(String(body.return_url)).toContain("/pricing?checkout=return");
  });

  it("POST /billing/checkout-session rejects unknown tiers and unauthenticated callers", async () => {
    const { agent } = await signupUser("checkout-bad");
    expect((await agent.post("/api/billing/checkout-session").send({ tier: "platinum" })).status).toBe(400);
    expect((await request(app).post("/api/billing/checkout-session").send({ tier: "closer" })).status).toBe(401);
  });

  it("POST /billing/cancel cancels the CALLER's subscription via Dodo", async () => {
    const { agent, userId } = await signupUser("cancel");
    const created = subscriptionPayload({ userId, subId: "sub_cancel_me", trialDays: 0 });
    await postWebhook(created, sign(created));

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
    const created = subscriptionPayload({ userId, subId: "sub_delete_me", trialDays: 0 });
    await postWebhook(created, sign(created));

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
    const created = subscriptionPayload({ userId, subId: "sub_delete_outage", trialDays: 0 });
    await postWebhook(created, sign(created));

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
