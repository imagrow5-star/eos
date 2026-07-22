/**
 * Phase A privacy hardening — integration coverage for:
 *   • consent recording (version + timestamp + explicit-only data-sharing flag)
 *   • "forget this" endpoints: memory facts and chat messages, including the
 *     story-thread retelling scrub and chapter-quote-dismissal cleanup
 *   • CORS allow-listing (reflect-any-origin is gone)
 *   • security headers (helmet CSP on the API)
 *   • env-only VAPID keys (database access must never grant push capability)
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app, { isAllowedOrigin } from "../app.js";
import { decryptJson } from "@workspace/db";
import { ensureVapidKeys } from "../services/push.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Helpers (same pattern as push.test.ts — each file is self-contained) ────

const TS = Date.now();
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `privacy-${tag}-${TS}-${emails.length}@example.invalid`;
  emails.push(e);
  return e;
}

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions              WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM email_verification_tokens  WHERE user_id = ${uid};
    DELETE FROM chapter_quote_dismissals   WHERE user_id = ${uid};
    DELETE FROM story_threads              WHERE user_id = ${uid};
    DELETE FROM memory_facts               WHERE user_id = ${uid};
    DELETE FROM messages                   WHERE user_id = ${uid};
    DELETE FROM profile                    WHERE user_id = ${uid};
    DELETE FROM users                      WHERE id      = ${uid};
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

afterAll(async () => {
  await Promise.all(emails.splice(0).map(cleanupUser));
  await pool.end();
});

// ─── Security headers ─────────────────────────────────────────────────────────

describe("security headers (helmet)", () => {
  it("serves a locked-down CSP on API responses", async () => {
    const res = await request(app).get("/api/health");
    const csp = res.headers["content-security-policy"];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    // frameguard is off — frame-ancestors is the single source of truth
    expect(res.headers["x-frame-options"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

// ─── CORS allow-list ──────────────────────────────────────────────────────────

describe("CORS allow-list", () => {
  it("isAllowedOrigin: allows our domains, this workspace's preview, and originless requests", () => {
    expect(isAllowedOrigin(undefined)).toBe(true); // same-origin / curl / server-to-server
    expect(isAllowedOrigin("https://eoscompanion.com")).toBe(true);
    expect(isAllowedOrigin("https://www.eoscompanion.com")).toBe(true);
    expect(isAllowedOrigin("https://eos-companion.replit.app")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    if (process.env.REPLIT_DEV_DOMAIN) {
      expect(isAllowedOrigin(`https://${process.env.REPLIT_DEV_DOMAIN}`)).toBe(true);
    }
  });

  it("isAllowedOrigin: rejects everything else — including OTHER repls' *.replit.dev hosts", () => {
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("https://eoscompanion.com.evil.example")).toBe(false);
    // No wildcard suffix: another repl's preview domain must NOT be trusted
    expect(isAllowedOrigin("https://some-other-repl.riker.replit.dev")).toBe(false);
    expect(isAllowedOrigin("https://notreplit.dev")).toBe(false);
    expect(isAllowedOrigin("chrome-extension://abcdef")).toBe(false);
    expect(isAllowedOrigin("null")).toBe(false); // sandboxed iframe origin
    expect(isAllowedOrigin("not a url")).toBe(false);
  });

  it("echoes allowed origins with credentials", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "https://eoscompanion.com");
    expect(res.headers["access-control-allow-origin"]).toBe("https://eoscompanion.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("sends NO CORS headers for unknown origins", async () => {
    const res = await request(app).get("/api/health").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

// ─── Consent recording ────────────────────────────────────────────────────────

describe("POST /api/profile/consent", () => {
  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/profile/consent")
      .send({ version: "test-1" });
    expect(res.status).toBe(401);
  });

  it("rejects a missing or oversized version tag", async () => {
    const { agent } = await signupUser("consent-bad");
    expect((await agent.post("/api/profile/consent").send({})).status).toBe(400);
    expect(
      (await agent.post("/api/profile/consent").send({ version: "  " })).status,
    ).toBe(400);
    expect(
      (await agent.post("/api/profile/consent").send({ version: "x".repeat(65) })).status,
    ).toBe(400);
  });

  it("records version + server timestamp; data sharing stays off unless literally true", async () => {
    const { agent } = await signupUser("consent-ok");

    const r1 = await agent
      .post("/api/profile/consent")
      .send({ version: "test-v1", dataSharingOptIn: "yes" }); // truthy string ≠ consent
    expect(r1.status).toBe(200);
    expect(r1.body.consentVersion).toBe("test-v1");
    expect(r1.body.dataSharingOptIn).toBe(false);
    expect(new Date(r1.body.consentAt).getTime()).toBeGreaterThan(TS - 60_000);

    // Profile payload reflects it
    const prof = await agent.get("/api/profile");
    expect(prof.body.consentVersion).toBe("test-v1");
    expect(prof.body.dataSharingOptIn).toBe(false);
    expect(prof.body.consentAt).toBeTruthy();

    // Re-consent to a newer version overwrites; explicit true opts in
    const r2 = await agent
      .post("/api/profile/consent")
      .send({ version: "test-v2", dataSharingOptIn: true });
    expect(r2.body.consentVersion).toBe("test-v2");
    expect(r2.body.dataSharingOptIn).toBe(true);
  });
});

// ─── Forget a memory fact ─────────────────────────────────────────────────────

describe("DELETE /api/memory/facts/:id", () => {
  it("deletes own facts, 404s on others' and on repeats", async () => {
    const { agent: agentA, userId: userA } = await signupUser("facts-a");
    const { agent: agentB } = await signupUser("facts-b");

    const ins = await pool.query<{ id: number }>(
      "INSERT INTO memory_facts (user_id, fact, category) VALUES ($1, $2, 'life') RETURNING id",
      [userA, "loves quiet mornings"],
    );
    const factId = ins.rows[0]!.id;

    // Someone else's fact is invisible — 404, row untouched
    expect((await agentB.delete(`/api/memory/facts/${factId}`)).status).toBe(404);
    const still = await pool.query("SELECT 1 FROM memory_facts WHERE id = $1", [factId]);
    expect(still.rowCount).toBe(1);

    // Owner deletes for real
    const del = await agentA.delete(`/api/memory/facts/${factId}`);
    expect(del.status).toBe(200);
    const gone = await pool.query("SELECT 1 FROM memory_facts WHERE id = $1", [factId]);
    expect(gone.rowCount).toBe(0);

    // Idempotence: repeat delete is a 404, invalid ids are 400
    expect((await agentA.delete(`/api/memory/facts/${factId}`)).status).toBe(404);
    expect((await agentA.delete("/api/memory/facts/abc")).status).toBe(400);
  });
});

// ─── Forget a chat message (with scrubbing) ───────────────────────────────────

describe("DELETE /api/chat/messages/:id", () => {
  it("deletes the message and scrubs story-thread quotes + dismissals in one transaction", async () => {
    const { agent, userId } = await signupUser("msg-scrub");

    const m1 = (
      await pool.query<{ id: number }>(
        "INSERT INTO messages (user_id, role, content) VALUES ($1, 'user', $2) RETURNING id",
        [userId, "why did I stay so long?"],
      )
    ).rows[0]!.id;
    const m2 = (
      await pool.query<{ id: number }>(
        "INSERT INTO messages (user_id, role, content) VALUES ($1, 'user', 'unrelated') RETURNING id",
        [userId],
      )
    ).rows[0]!.id;

    await pool.query(
      "INSERT INTO chapter_quote_dismissals (user_id, message_id) VALUES ($1, $2)",
      [userId, m1],
    );

    const retellings = [
      {
        weekStart: "2026-07-13",
        summary: "told the story of leaving",
        question: "why did I stay so long?",
        questionMessageId: m1,
        framing: "past tense, self-blame",
        sameAsPrior: false,
        confidence: 0.9,
      },
      {
        weekStart: "2026-07-20",
        summary: "same story, new angle",
        question: null,
        questionMessageId: null,
        framing: "present tense",
        sameAsPrior: false,
        confidence: 0.8,
      },
    ];
    const threadId = (
      await pool.query<{ id: number }>(
        `INSERT INTO story_threads (user_id, slug, label, first_seen_week, last_seen_week, retellings)
         VALUES ($1, 'leaving-story', 'the leaving story', '2026-07-13', '2026-07-20', $2::jsonb)
         RETURNING id`,
        [userId, JSON.stringify(retellings)],
      )
    ).rows[0]!.id;

    // Nonexistent + other users' messages: 404, nothing changes
    expect((await agent.delete("/api/chat/messages/999999999")).status).toBe(404);
    const { agent: stranger } = await signupUser("msg-stranger");
    expect((await stranger.delete(`/api/chat/messages/${m1}`)).status).toBe(404);

    // Owner forgets m1
    const del = await agent.delete(`/api/chat/messages/${m1}`);
    expect(del.status).toBe(200);

    const msgs = await pool.query("SELECT id FROM messages WHERE user_id = $1 ORDER BY id", [
      userId,
    ]);
    expect(msgs.rows.map((r) => r.id)).toEqual([m2]); // m1 gone, m2 intact

    const dism = await pool.query(
      "SELECT 1 FROM chapter_quote_dismissals WHERE user_id = $1 AND message_id = $2",
      [userId, m1],
    );
    expect(dism.rowCount).toBe(0);

    const thread = await pool.query<{ retellings: any }>(
      "SELECT retellings FROM story_threads WHERE id = $1",
      [threadId],
    );
    // The scrub rewrites retellings through drizzle, which re-encrypts the
    // jsonb — decryptJson also passes legacy plaintext arrays through.
    const after = decryptJson<any[]>(thread.rows[0]!.retellings, "story_threads.retellings");
    expect(after).toHaveLength(2);
    expect(after[0].question).toBeNull(); // verbatim quote scrubbed
    expect(after[0].questionMessageId).toBeNull();
    expect(after[0].summary).toBe("told the story of leaving"); // neutral paraphrase kept
    expect(after[1]).toEqual(retellings[1]); // untouched entry survives byte-for-byte
  });
});

// ─── VAPID keys from environment only ─────────────────────────────────────────

describe("VAPID keys (env-only)", () => {
  it("ensureVapidKeys returns exactly the environment pair", async () => {
    const keys = await ensureVapidKeys();
    expect(keys.publicKey).toBe(process.env.VAPID_PUBLIC_KEY);
    expect(keys.privateKey).toBe(process.env.VAPID_PRIVATE_KEY);
  });

  it("serves the env public key to clients", async () => {
    const { agent } = await signupUser("vapid-env");
    const res = await agent.get("/api/push/vapid-public-key");
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe(process.env.VAPID_PUBLIC_KEY);
  });
});
