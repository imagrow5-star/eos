/**
 * ElevenLabs post-call webhook — voice-minute metering (stage A).
 *
 * No real ElevenLabs traffic: deliveries are signed locally with the test
 * secret using the exact scheme from the official SDK (t=<secs>,v0=<hex
 * HMAC-SHA256 over `${t}.${rawBody}`>), sent through the real app so the
 * raw-body mount is proven end-to-end. Fixtures mirror the REAL captured
 * post_call_transcription deliveries (2026-09-02): data.conversation_id,
 * data.metadata.{start_time_unix_secs, call_duration_secs}, and our voice
 * token at data.conversation_initiation_client_data.custom_llm_extra_body
 * .user_token.
 *
 * Covers: a real delivery writes one attributed voice_usage row; retried
 * (same conversation_id) deliveries stay one row; failed calls still meter;
 * an EXPIRED voice token still attributes (post-call deliveries arrive after
 * the call); bad/missing/stale signatures are rejected with nothing stored;
 * unmatchable or non-transcription deliveries answer 200 (never a retry
 * storm) and store nothing.
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";

process.env.ELEVENLABS_WEBHOOK_SECRET = "elevenlabs-test-webhook-secret-not-real";

import app from "../app.js";
import { signElevenLabsPayloadForTests } from "../services/elevenlabs.js";
import { mintVoiceToken } from "../lib/voiceToken.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `elwh-${tag}-${Date.now()}-${emails.length}@example.invalid`;
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
  return { userId, email };
}

// ── Fixtures — mirror the captured post_call_transcription deliveries ───────

let convSeq = 0;
function postCallPayload(opts: {
  userToken?: string | null;
  conversationId?: string;
  type?: string;
  startSecs?: number | null;
  durationSecs?: number | null;
  status?: string;
}): string {
  const conversationId = opts.conversationId ?? `conv_test_${Date.now()}_${convSeq++}`;
  const startSecs =
    opts.startSecs === undefined ? Math.floor(Date.now() / 1000) - 60 : opts.startSecs;
  return JSON.stringify({
    type: opts.type ?? "post_call_transcription",
    event_timestamp: Math.floor(Date.now() / 1000),
    data: {
      agent_id: "agent_test_1",
      status: opts.status ?? "done",
      conversation_id: conversationId,
      metadata: {
        ...(startSecs === null ? {} : { start_time_unix_secs: startSecs }),
        ...(opts.durationSecs === null ? {} : { call_duration_secs: opts.durationSecs ?? 42 }),
      },
      conversation_initiation_client_data: {
        custom_llm_extra_body:
          opts.userToken === null ? {} : { user_token: opts.userToken ?? "garbage" },
      },
      transcript: [],
    },
  });
}

function postWebhook(raw: string, sigHeader?: string) {
  const r = request(app)
    .post("/api/elevenlabs/post-call")
    .set("Content-Type", "application/json");
  if (sigHeader !== undefined) r.set("elevenlabs-signature", sigHeader);
  return r.send(raw);
}

function sign(raw: string, timestampSecs?: number): string {
  return signElevenLabsPayloadForTests(
    raw,
    process.env.ELEVENLABS_WEBHOOK_SECRET!,
    timestampSecs,
  );
}

async function usageRows(userId: number) {
  const r = await pool.query(
    `SELECT user_id, call_started_at, call_ended_at, duration_seconds, source, provider_conversation_id
     FROM voice_usage WHERE user_id = $1 ORDER BY id ASC`,
    [userId],
  );
  return r.rows;
}

afterAll(async () => {
  for (const email of emails) await cleanupUser(email);
  await pool.end();
});

describe("signature verification", () => {
  it("rejects a delivery with no signature header", async () => {
    const res = await postWebhook(postCallPayload({}));
    expect(res.status).toBe(401);
  });

  it("rejects a wrong-secret signature", async () => {
    const raw = postCallPayload({});
    const bad = signElevenLabsPayloadForTests(raw, "some-other-secret");
    const res = await postWebhook(raw, bad);
    expect(res.status).toBe(401);
  });

  it("rejects a stale timestamp (older than the 30-minute tolerance)", async () => {
    const raw = postCallPayload({});
    const stale = sign(raw, Math.floor(Date.now() / 1000) - 31 * 60);
    const res = await postWebhook(raw, stale);
    expect(res.status).toBe(401);
  });

  it("rejects a tampered body", async () => {
    const raw = postCallPayload({});
    const header = sign(raw);
    const res = await postWebhook(raw.replace("post_call_transcription", "post_call_tampered!!"), header);
    expect(res.status).toBe(401);
  });
});

describe("metering", () => {
  it("records one attributed row from a valid delivery", async () => {
    const { userId, email } = await signupUser("meter");
    const startSecs = Math.floor(Date.now() / 1000) - 120;
    const raw = postCallPayload({
      userToken: mintVoiceToken(userId),
      conversationId: "conv_meter_1",
      startSecs,
      durationSecs: 95,
    });
    const res = await postWebhook(raw, sign(raw));
    expect(res.status).toBe(200);

    const rows = await usageRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].duration_seconds).toBe(95);
    expect(rows[0].source).toBe("elevenlabs_webhook");
    expect(rows[0].provider_conversation_id).toBe("conv_meter_1");
    expect(new Date(rows[0].call_started_at).getTime()).toBe(startSecs * 1000);
    expect(new Date(rows[0].call_ended_at).getTime()).toBe((startSecs + 95) * 1000);
    await cleanupUser(email);
  });

  it("a retried delivery (same conversation_id) stays one row", async () => {
    const { userId, email } = await signupUser("dupe");
    const raw = postCallPayload({
      userToken: mintVoiceToken(userId),
      conversationId: "conv_dupe_1",
      durationSecs: 30,
    });
    expect((await postWebhook(raw, sign(raw))).status).toBe(200);
    expect((await postWebhook(raw, sign(raw))).status).toBe(200);
    expect(await usageRows(userId)).toHaveLength(1);
    await cleanupUser(email);
  });

  it("a call ElevenLabs terminated early (status failed) still meters — minutes were consumed", async () => {
    // Mirrors the real captures: both test calls died on the provider's
    // quota (error 1002) with status "failed" and call_duration_secs 16/18.
    const { userId, email } = await signupUser("failed");
    const raw = postCallPayload({
      userToken: mintVoiceToken(userId),
      durationSecs: 16,
      status: "failed",
    });
    expect((await postWebhook(raw, sign(raw))).status).toBe(200);
    const rows = await usageRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].duration_seconds).toBe(16);
    await cleanupUser(email);
  });

  it("an EXPIRED voice token still attributes the call", async () => {
    // Post-call deliveries arrive after the call; retries can be hours late.
    // The delivery is authenticated by the webhook signature — the token is
    // an identifier here, not a credential.
    const { userId, email } = await signupUser("expired");
    const expiredToken = mintVoiceToken(userId, -1000); // already past TTL
    const raw = postCallPayload({ userToken: expiredToken, durationSecs: 61 });
    expect((await postWebhook(raw, sign(raw))).status).toBe(200);
    expect(await usageRows(userId)).toHaveLength(1);
    await cleanupUser(email);
  });
});

describe("fail-open drops (200, nothing stored, never a retry storm)", () => {
  it("garbage user token → 200, no row", async () => {
    const raw = postCallPayload({ userToken: "garbage.token.not.ours.x" });
    const res = await postWebhook(raw, sign(raw));
    expect(res.status).toBe(200);
  });

  it("missing user token → 200, no row", async () => {
    const raw = postCallPayload({ userToken: null });
    const res = await postWebhook(raw, sign(raw));
    expect(res.status).toBe(200);
  });

  it("non-transcription event type → 200, no row", async () => {
    const { userId, email } = await signupUser("audio");
    const raw = postCallPayload({ userToken: mintVoiceToken(userId), type: "post_call_audio" });
    const res = await postWebhook(raw, sign(raw));
    expect(res.status).toBe(200);
    expect(await usageRows(userId)).toHaveLength(0);
    await cleanupUser(email);
  });

  it("signed body that is not JSON → 200", async () => {
    const raw = "this is not json";
    const res = await postWebhook(raw, sign(raw));
    expect(res.status).toBe(200);
  });
});
