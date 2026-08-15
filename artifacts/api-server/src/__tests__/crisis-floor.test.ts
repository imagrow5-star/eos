/**
 * Crisis floor — end-to-end integration tests (real DB, mock AI).
 *
 * ANTHROPIC_API_KEY is unset in tests, so replies are the deterministic mock —
 * which is exactly the point: the floor must attach helplines NO MATTER what
 * the model produces. Covers:
 *   • helpline block appended + returned as a separate field (/chat/send)
 *   • crisis_events row per detection (pattern + country, no content)
 *   • country routing (IN / UK / unknown / never-shared)
 *   • per-message dismissal + reappearance on the next crisis turn
 *   • 3-dismissals-in-7-days review flag
 *   • reinforcement block present/absent in the composed system extra
 *   • voice path: no helplines in the spoken reply, event row + status
 *     endpoint + dismissal instead
 *   • 20-turn normal conversation: zero crisis artifacts anywhere
 *   • export includes crisis events (timestamps + patterns only)
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { composeChatSystemExtra } from "../routes/chat.js";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { HELPLINE_BLOCK_MARKER } from "../services/crisis/helplines.js";
import { isEncrypted, decryptText } from "@workspace/db";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const createdEmails: string[] = [];

const CRISIS_TEXT = "Some nights I think about killing myself just so it stops hurting.";

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (r.rowCount === 0) return;
  const uid = r.rows[0]!.id;
  await pool.query(`DELETE FROM crisis_events WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM messages WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM goal_tasks WHERE goal_id IN (SELECT id FROM goals WHERE user_id = ${uid})`);
  await pool.query(`DELETE FROM goals WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM habit_completions WHERE habit_id IN (SELECT id FROM habits WHERE user_id = ${uid})`);
  await pool.query(`DELETE FROM habits WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM commitments WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM memory_facts WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM personality_signals WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM wins WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM mood_scores WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM personalization_state WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM email_verification_tokens WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}'`);
  await pool.query(`DELETE FROM profile WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM users WHERE id = ${uid}`);
}

afterAll(async () => {
  await Promise.all(createdEmails.splice(0).map(cleanupUser));
  await pool.end();
});

/** Signup + verify + onboarded profile with the given country code. */
async function makeUser(tag: string, country: string) {
  const email = `crisis-floor-${tag}-${Date.now()}@example.invalid`;
  createdEmails.push(email);
  const agent = request.agent(app);
  const signup = await agent
    .post("/api/auth/signup")
    .send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  // Profile row may not exist yet — the chat routes create it on demand, but
  // set the country up-front so helpline routing has something to read.
  await agent.get("/api/profile"); // ensures the profile row exists
  await pool.query(
    "UPDATE profile SET country = $1, is_onboarding_complete = TRUE WHERE user_id = $2",
    [country, userId],
  );
  return { agent, userId, email };
}

async function crisisEventsFor(userId: number) {
  const r = await pool.query(
    "SELECT * FROM crisis_events WHERE user_id = $1 ORDER BY id ASC",
    [userId],
  );
  // pattern_matched is encrypted at rest; raw SQL sees ciphertext. Assert
  // that (the whole point of the column being encrypted), then hand tests
  // the plaintext they compare against.
  for (const row of r.rows) {
    expect(isEncrypted(row.pattern_matched)).toBe(true);
    row.pattern_matched = decryptText(row.pattern_matched, "crisis_events.pattern_matched");
  }
  return r.rows as Array<{
    id: number;
    message_id: number | null;
    pattern_matched: string;
    country_served: string;
    source: string;
    block_dismissed: boolean;
    dismissed_at: string | null;
  }>;
}

// ─── Reinforcement block composition (what reaches the system prompt) ────────

describe("crisis reinforcement in the system prompt", () => {
  it("is present exactly when a crisis was detected", () => {
    expect(composeChatSystemExtra({ voiceMode: false, crisisDetected: false })).toBeUndefined();
    const withCrisis = composeChatSystemExtra({ voiceMode: false, crisisDetected: true });
    expect(withCrisis).toContain("CRISIS DETECTED IN THIS MESSAGE");
    const voiceWith = composeChatSystemExtra({ voiceMode: true, crisisDetected: true });
    expect(voiceWith).toContain("CRISIS DETECTED IN THIS MESSAGE");
    const voiceWithout = composeChatSystemExtra({ voiceMode: true, crisisDetected: false });
    expect(voiceWithout ?? "").not.toContain("CRISIS DETECTED");
  });
});

// ─── Chat path ───────────────────────────────────────────────────────────────

describe("crisis floor — chat path", () => {
  it("appends localized helplines, returns them separately, and logs an event", async () => {
    const { agent, userId } = await makeUser("us", "US");

    const res = await agent.post("/api/chat/send").send({ content: CRISIS_TEXT });
    expect(res.status).toBe(200);

    // Separate field for the client card…
    expect(res.body.crisisHelplineBlock).toBeDefined();
    expect(res.body.crisisHelplineBlock).toContain("988");
    expect(res.body.crisisHelplineBlock.startsWith(HELPLINE_BLOCK_MARKER)).toBe(true);
    // …and the same block persisted inside the assistant message.
    expect(res.body.assistantMessage.content).toContain(HELPLINE_BLOCK_MARKER);
    expect(res.body.assistantMessage.content.endsWith("Take your time.")).toBe(true);

    // Event row: pattern + country, linked to the assistant message, and NO
    // message content anywhere in the table.
    const events = await crisisEventsFor(userId);
    expect(events).toHaveLength(1);
    expect(events[0]!.pattern_matched).toBe("explicit_suicidal_ideation");
    expect(events[0]!.country_served).toBe("US");
    expect(events[0]!.source).toBe("chat");
    expect(events[0]!.message_id).toBe(res.body.assistantMessage.id);
    expect(events[0]!.block_dismissed).toBe(false);
    expect(JSON.stringify(events[0])).not.toContain("killing myself");

    // History exposes the dismissal flag for the card renderer.
    const history = await agent.get("/api/chat/messages");
    expect(history.status).toBe(200);
    const assistantRow = history.body.find(
      (m: { id: number }) => m.id === res.body.assistantMessage.id,
    );
    expect(assistantRow.crisisBlockDismissed).toBe(false);
  });

  it("routes India to Indian helplines and UK to Samaritans", async () => {
    const { agent: agentIn } = await makeUser("in", "IN");
    const resIn = await agentIn.post("/api/chat/send").send({ content: CRISIS_TEXT });
    expect(resIn.status).toBe(200);
    expect(resIn.body.crisisHelplineBlock).toContain("AASRA");
    expect(resIn.body.crisisHelplineBlock).toContain("iCall");
    expect(resIn.body.crisisHelplineBlock).toContain("Vandrevala");

    const { agent: agentUk } = await makeUser("uk", "UK");
    const resUk = await agentUk.post("/api/chat/send").send({ content: CRISIS_TEXT });
    expect(resUk.status).toBe(200);
    expect(resUk.body.crisisHelplineBlock).toContain("Samaritans");
    expect(resUk.body.crisisHelplineBlock).toContain("116 123");
  });

  it("falls back for unknown and never-shared countries", async () => {
    const { agent: agentZz, userId: zzId } = await makeUser("zz", "ZZ");
    const resZz = await agentZz.post("/api/chat/send").send({ content: CRISIS_TEXT });
    expect(resZz.body.crisisHelplineBlock).toContain("befrienders.org");
    expect((await crisisEventsFor(zzId))[0]!.country_served).toBe("fallback");

    // country = "" — the user skipped the onboarding country question.
    const { agent: agentNone } = await makeUser("none", "");
    const resNone = await agentNone.post("/api/chat/send").send({ content: CRISIS_TEXT });
    expect(resNone.body.crisisHelplineBlock).toContain("befrienders.org");
    expect(resNone.body.crisisHelplineBlock).toContain("988");
  });

  it("dismissal is per-message; the card returns on the next crisis turn; 3 dismissals flag review", async () => {
    const { agent, userId } = await makeUser("dismiss", "US");

    // Turn 1 → dismiss.
    const r1 = await agent.post("/api/chat/send").send({ content: CRISIS_TEXT });
    const msg1: number = r1.body.assistantMessage.id;
    const d1 = await agent.post(`/api/chat/messages/${msg1}/crisis-dismiss`);
    expect(d1.status).toBe(200);
    expect(d1.body.ok).toBe(true);
    expect(d1.body.reviewFlagged).toBe(false);

    const flag1 = await pool.query(
      "SELECT crisis_block_dismissed FROM messages WHERE id = $1",
      [msg1],
    );
    expect(flag1.rows[0]!.crisis_block_dismissed).toBe(true);

    // Turn 2 — a fresh crisis turn still gets a fresh, undismissed block.
    const r2 = await agent.post("/api/chat/send").send({ content: "I really don't want to be here anymore" });
    expect(r2.body.crisisHelplineBlock).toBeDefined();
    const msg2: number = r2.body.assistantMessage.id;
    const flag2 = await pool.query(
      "SELECT crisis_block_dismissed FROM messages WHERE id = $1",
      [msg2],
    );
    expect(flag2.rows[0]!.crisis_block_dismissed).toBe(false);
    // …and the first message stays dismissed (per-message state).
    expect(
      (await pool.query("SELECT crisis_block_dismissed FROM messages WHERE id = $1", [msg1]))
        .rows[0]!.crisis_block_dismissed,
    ).toBe(true);

    // Dismiss #2 (still under threshold) and #3 (flags).
    const d2 = await agent.post(`/api/chat/messages/${msg2}/crisis-dismiss`);
    expect(d2.body.reviewFlagged).toBe(false);

    const r3 = await agent.post("/api/chat/send").send({ content: "it feels like there is no way out" });
    const msg3: number = r3.body.assistantMessage.id;
    const d3 = await agent.post(`/api/chat/messages/${msg3}/crisis-dismiss`);
    expect(d3.body.reviewFlagged).toBe(true);

    // All three events recorded, all dismissed with timestamps.
    const events = await crisisEventsFor(userId);
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.block_dismissed && e.dismissed_at !== null)).toBe(true);
  });

  it("rejects dismissing another user's message", async () => {
    const { agent: agentA } = await makeUser("owner-a", "US");
    const { agent: agentB } = await makeUser("owner-b", "US");
    const r = await agentA.post("/api/chat/send").send({ content: CRISIS_TEXT });
    const res = await agentB.post(`/api/chat/messages/${r.body.assistantMessage.id}/crisis-dismiss`);
    expect(res.status).toBe(404);
  });
});

// ─── Streaming path ──────────────────────────────────────────────────────────

describe("crisis floor — streaming chat path", () => {
  it("carries the helpline block on the done event and persists it", async () => {
    const { agent, userId } = await makeUser("stream", "US");

    const res = await agent.post("/api/chat/stream").send({ content: CRISIS_TEXT });
    expect(res.status).toBe(200);
    const raw = res.text;
    // SSE: the done event carries content + crisisHelplineBlock.
    const doneLine = raw
      .split("\n")
      .find((l, i, all) => l.startsWith("data: ") && all[i - 1] === "event: done");
    expect(doneLine).toBeDefined();
    const done = JSON.parse(doneLine!.slice(6)) as {
      messageId: number;
      content: string;
      crisisHelplineBlock?: string;
    };
    expect(done.crisisHelplineBlock).toContain("988");
    expect(done.content).toContain(HELPLINE_BLOCK_MARKER);

    const events = await crisisEventsFor(userId);
    expect(events).toHaveLength(1);
    expect(events[0]!.message_id).toBe(done.messageId);
  });
});

// ─── Normal-conversation regression ──────────────────────────────────────────

describe("crisis floor — normal conversations are untouched", () => {
  it("a 20-turn normal conversation produces zero crisis artifacts", async () => {
    const { agent, userId } = await makeUser("normal", "US");

    const NORMAL_TURNS = [
      "I had such a hard day at work today, everything went wrong.",
      "my boss moved the deadline again",
      "I did manage a walk at lunch though",
      "the park was quiet and it helped",
      "what should I cook tonight?",
      "pasta sounds easy enough",
      "I called my sister after dinner",
      "she's planning a trip for the spring",
      "work is still heavy but I'm coping",
      "I slept a bit better last night",
      "the gym was packed this morning",
      "I'm thinking about a new routine",
      "maybe reading before bed",
      "the book you mentioned arrived",
      "the first chapter is lovely",
      "weekend plans are still up in the air",
      "maybe a movie with friends",
      "that's odd, the app logged me out earlier",
      "anyway, the coffee this morning was great",
      "talk tomorrow, I'm heading to bed",
    ];
    expect(NORMAL_TURNS).toHaveLength(20);

    for (const content of NORMAL_TURNS) {
      const res = await agent.post("/api/chat/send").send({ content });
      expect(res.status).toBe(200);
      expect(res.body.crisisHelplineBlock, `unexpected block for: "${content}"`).toBeUndefined();
      expect(res.body.assistantMessage.content).not.toContain(HELPLINE_BLOCK_MARKER);
    }

    expect(await crisisEventsFor(userId)).toHaveLength(0);

    // History: no message carries a block or a dismissal flag set true.
    const history = await agent.get("/api/chat/messages");
    for (const m of history.body as Array<{ content: string; crisisBlockDismissed?: boolean }>) {
      expect(m.content).not.toContain(HELPLINE_BLOCK_MARKER);
      expect(m.crisisBlockDismissed ?? false).toBe(false);
    }
  }, 60_000);
});

// ─── Voice path ──────────────────────────────────────────────────────────────

async function waitForVoiceEvent(userId: number, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    const events = (await crisisEventsFor(userId)).filter((e) => e.source === "voice");
    if (events.length > 0) return events;
    if (Date.now() - start > timeoutMs) return events;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("crisis floor — voice path", () => {
  it("logs a voice event, keeps helplines OUT of the spoken reply, and serves the overlay endpoint", async () => {
    const { agent, userId } = await makeUser("voice", "IN");
    const token = mintVoiceToken(userId);

    const res = await request(app)
      .post("/api/voice-llm/v1/chat/completions")
      .send({
        stream: false,
        messages: [{ role: "user", content: CRISIS_TEXT }],
        elevenlabs_extra_body: { user_token: token },
      });
    expect(res.status).toBe(200);
    const spoken: string = res.body.choices[0].message.content ?? "";
    // The SPOKEN reply must never contain the helpline block or numbers list.
    expect(spoken).not.toContain(HELPLINE_BLOCK_MARKER);
    expect(spoken).not.toContain("AASRA");

    // The event row lands asynchronously (fire-and-forget insert).
    const events = await waitForVoiceEvent(userId);
    expect(events).toHaveLength(1);
    expect(events[0]!.pattern_matched).toBe("explicit_suicidal_ideation");
    expect(events[0]!.country_served).toBe("IN");
    expect(events[0]!.message_id).toBeNull();

    // The on-call overlay endpoint reports it with the full card payload…
    const status = await agent.get("/api/voice-agent/crisis-status");
    expect(status.status).toBe(200);
    expect(status.body.active).toBe(true);
    expect(status.body.event.id).toBe(events[0]!.id);
    expect(status.body.event.blockText).toContain("AASRA");

    // …dismissing clears it, and duplicate detections within the dedup window
    // never create a second event (ElevenLabs re-fires per spoken turn).
    const res2 = await request(app)
      .post("/api/voice-llm/v1/chat/completions")
      .send({
        stream: false,
        messages: [{ role: "user", content: CRISIS_TEXT }],
        elevenlabs_extra_body: { user_token: token },
      });
    expect(res2.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect((await crisisEventsFor(userId)).filter((e) => e.source === "voice")).toHaveLength(1);

    const dismiss = await agent.post(`/api/voice-agent/crisis-events/${events[0]!.id}/dismiss`);
    expect(dismiss.status).toBe(200);
    expect(dismiss.body.ok).toBe(true);

    const statusAfter = await agent.get("/api/voice-agent/crisis-status");
    expect(statusAfter.body.active).toBe(false);
  }, 60_000);
});

// ─── Export ──────────────────────────────────────────────────────────────────

describe("crisis floor — account export", () => {
  it("includes crisis events (timestamps + patterns, no content)", async () => {
    const { agent } = await makeUser("export", "US");
    await agent.post("/api/chat/send").send({ content: CRISIS_TEXT });

    const res = await agent.get("/api/account/export");
    expect(res.status).toBe(200);
    const body =
      res.body && typeof res.body === "object" && "crisisEvents" in res.body
        ? res.body
        : JSON.parse(res.text);
    expect(Array.isArray(body.crisisEvents)).toBe(true);
    expect(body.crisisEvents).toHaveLength(1);
    expect(body.crisisEvents[0].pattern_matched).toBe("explicit_suicidal_ideation");
    expect(body.crisisEvents[0].country_served).toBe("US");
    expect(body.crisisEvents[0].detected_at).toBeDefined();
    // The event log itself carries no message text.
    expect(JSON.stringify(body.crisisEvents)).not.toContain("killing myself");
  });
});
