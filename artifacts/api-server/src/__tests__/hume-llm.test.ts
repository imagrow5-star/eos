/**
 * Hume EVI custom-LLM endpoint — real handler (delegates to the shared
 * voiceCompletionHandler after normalizing Hume's request shape).
 *
 * The normalization is pinned against the two REAL captured deliveries
 * (2026-09-02) verbatim: the greeting instruction arriving as user content
 * (alone, and prepended to the user's words) and the byte-identical
 * duplicated message. End-to-end tests run the full pipeline — with no
 * ANTHROPIC key in tests, streamCompanionReply serves its dev-mock reply,
 * so real turns stream deterministic SSE.
 *
 * Also pinned: both token carriers, tokenless/garbage/expired 401s, the
 * greeting fast path (curated instant line, nothing persisted as a user
 * turn), persistence of the stripped/deduped user turn, and THE
 * non-negotiable — the voice token never reaches a log line.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import pg from "pg";

import { eq } from "drizzle-orm";
import { db, messagesTable } from "@workspace/db";
import app from "../app.js";
import { logger } from "../lib/logger.js";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { normalizeHumeMessages, formatVoiceTone, HUME_GREETING_PREFIX } from "../routes/humeLlm.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `hume-${tag}-${Date.now()}-${emails.length}@example.invalid`;
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
    DELETE FROM messages WHERE user_id = ${uid};
    DELETE FROM profile  WHERE user_id = ${uid};
    DELETE FROM users    WHERE id      = ${uid};
    COMMIT;
  `);
}

async function signupUser(tag: string) {
  const email = nextEmail(tag);
  const res = await request(app).post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(res.status).toBe(201);
  return { userId: res.body.user.id as number, email };
}

/** A Hume-shaped message exactly as captured (prosody null, time zeros). */
function humeMsg(role: string, content: string) {
  return { role, content, models: { prosody: null }, time: { begin: 0, end: 0 } };
}

function postTurn(opts: {
  bearer?: string;
  queryToken?: string;
  messages?: unknown[];
  body?: unknown;
}) {
  const url =
    "/api/hume-llm/v1/chat/completions" +
    (opts.queryToken !== undefined
      ? `?custom_session_id=${encodeURIComponent(opts.queryToken)}`
      : "");
  const r = request(app).post(url).set("Content-Type", "application/json");
  if (opts.bearer !== undefined) r.set("Authorization", `Bearer ${opts.bearer}`);
  return r.send(
    JSON.stringify(
      opts.body ?? { messages: opts.messages ?? [humeMsg("user", "Hello.")], model: "eos", stream: true },
    ),
  );
}

async function userMessages(userId: number): Promise<string[]> {
  // Via drizzle, not raw SQL: content is encrypted at rest and drizzle
  // decrypts on read.
  const rows = await db
    .select({ role: messagesTable.role, content: messagesTable.content })
    .from(messagesTable)
    .where(eq(messagesTable.userId, userId))
    .orderBy(messagesTable.id);
  return rows.map((row) => `${row.role}:${row.content}`);
}

/** Poll briefly for fire-and-forget persistence to land. */
async function waitForRows(userId: number, pred: (rows: string[]) => boolean): Promise<string[]> {
  for (let i = 0; i < 40; i++) {
    const rows = await userMessages(userId);
    if (pred(rows)) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return userMessages(userId);
}

afterAll(async () => {
  for (const email of emails) await cleanupUser(email);
  await pool.end();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeHumeMessages — pinned to the captured payloads", () => {
  it("capture 1: greeting instruction alone → no user turns (synthetic greeting path)", () => {
    expect(normalizeHumeMessages([humeMsg("user", HUME_GREETING_PREFIX)])).toEqual([]);
  });

  it("capture 2: duplicated instruction+text message → ONE turn, instruction stripped", () => {
    const captured = [
      humeMsg("user", `${HUME_GREETING_PREFIX} Hello, this is a capture test.`),
      humeMsg("user", `${HUME_GREETING_PREFIX} Hello, this is a capture test.`),
    ];
    expect(normalizeHumeMessages(captured)).toEqual([
      { role: "user", content: "Hello, this is a capture test.", prosody: null },
    ]);
  });

  it("keeps genuinely different consecutive user messages (only exact duplicates drop)", () => {
    const msgs = [humeMsg("user", "yes"), humeMsg("user", "yes please")];
    expect(normalizeHumeMessages(msgs).map((m) => m.content)).toEqual(["yes", "yes please"]);
  });

  it("keeps a genuine repeat — same words, different time — as two turns", () => {
    const msgs = [
      { ...humeMsg("user", "yes"), time: { begin: 1000, end: 1400 } },
      { ...humeMsg("user", "yes"), time: { begin: 2100, end: 2500 } },
    ];
    expect(normalizeHumeMessages(msgs).map((m) => m.content)).toEqual(["yes", "yes"]);
  });

  it("keeps assistant turns and non-prefix instruction text untouched", () => {
    const msgs = [
      humeMsg("user", "hi"),
      humeMsg("assistant", "Hey, I'm here."),
      humeMsg("user", `I said: ${HUME_GREETING_PREFIX}`), // not a prefix — untouched
    ];
    expect(normalizeHumeMessages(msgs)).toEqual([
      { role: "user", content: "hi", prosody: null },
      { role: "assistant", content: "Hey, I'm here.", prosody: null },
      { role: "user", content: `I said: ${HUME_GREETING_PREFIX}`, prosody: null },
    ]);
  });

  it("carries prosody through opaquely and tolerates garbage", () => {
    const withScores = { role: "user", content: "hi", models: { prosody: { anything: 1 } } };
    expect(normalizeHumeMessages([withScores])[0]!.prosody).toEqual({ anything: 1 });
    expect(normalizeHumeMessages(null)).toEqual([]);
    expect(normalizeHumeMessages([{ role: "system", content: "x" }, { role: "user" }])).toEqual([]);
  });
});

describe("voice-token auth", () => {
  it("401 with no token in either carrier (e.g. a Hume playground session)", async () => {
    const res = await postTurn({});
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe("invalid_request_error");
  });

  it("401 with a garbage Bearer value", async () => {
    const res = await postTurn({ bearer: "not-a-voice-token" });
    expect(res.status).toBe(401);
  });

  it("401 with an EXPIRED token — live request path", async () => {
    const { userId, email } = await signupUser("expired");
    const res = await postTurn({ bearer: mintVoiceToken(userId, -1000) });
    expect(res.status).toBe(401);
    await cleanupUser(email);
  });
});

describe("delegation to the shared voice brain", () => {
  it("greeting-only request (capture 1 shape) → instant curated greeting, no user row persisted", async () => {
    const { userId, email } = await signupUser("greet");
    const res = await postTurn({
      bearer: mintVoiceToken(userId),
      messages: [humeMsg("user", HUME_GREETING_PREFIX)],
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain('"object":"chat.completion.chunk"');
    expect(res.text).toContain("data: [DONE]");

    // The greeting persists as an assistant row only — the instruction must
    // never pollute the user's chat history.
    const rows = await waitForRows(userId, (r) => r.some((x) => x.startsWith("assistant:")));
    expect(rows.some((x) => x.startsWith("user:"))).toBe(false);
    await cleanupUser(email);
  });

  it("real turn (capture 2 shape) → streams a reply and persists the STRIPPED, DEDUPED user turn", async () => {
    const { userId, email } = await signupUser("turn");
    const res = await postTurn({
      bearer: mintVoiceToken(userId),
      messages: [
        humeMsg("user", `${HUME_GREETING_PREFIX} Hello, this is a capture test.`),
        humeMsg("user", `${HUME_GREETING_PREFIX} Hello, this is a capture test.`),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain("data: [DONE]");

    const rows = await waitForRows(userId, (r) => r.some((x) => x.startsWith("user:")));
    const userRows = rows.filter((x) => x.startsWith("user:"));
    expect(userRows).toEqual(["user:Hello, this is a capture test."]);
    await cleanupUser(email);
  });

  it("token via custom_session_id alone (redundant carrier) → works end to end", async () => {
    const { userId, email } = await signupUser("query");
    const res = await postTurn({
      queryToken: mintVoiceToken(userId),
      messages: [humeMsg("user", "How are you?")],
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain("data: [DONE]");
    // Persistence is fire-and-forget — wait for it so cleanup doesn't race
    // an in-flight insert into an FK violation.
    await waitForRows(userId, (r) => r.some((x) => x.startsWith("user:")));
    await cleanupUser(email);
  });
});

describe("formatVoiceTone — pinned to the real spoken captures (2026-09-03)", () => {
  it("joyful greeting sample → joy, excitement, determination", () => {
    const scores = { Joy: 0.598, Excitement: 0.213, Determination: 0.142, Admiration: 0.117, Fear: 0.098, Calmness: 0.096, Sadness: 0.012 };
    expect(formatVoiceTone({ scores })).toBe("(voice tone: joy, excitement, determination)");
  });

  it("frustrated sample → anger, determination, contempt (amusement .149 makes the threshold but not the top 3)", () => {
    const scores = { Anger: 0.205, Determination: 0.165, Contempt: 0.158, Amusement: 0.149, Awkwardness: 0.124, Anxiety: 0.109, Joy: 0.037 };
    expect(formatVoiceTone({ scores })).toBe("(voice tone: anger, determination, contempt)");
  });

  it("quiet low-arousal sample → sadness, confusion, pain (the case a 0.15 cut would flatten)", () => {
    const scores = { Sadness: 0.169, Confusion: 0.139, Pain: 0.128, Distress: 0.112, Fear: 0.098, Boredom: 0.078 };
    expect(formatVoiceTone({ scores })).toBe("(voice tone: sadness, confusion, pain)");
  });

  it("null prosody (Hume instruction turns, text input) → null", () => {
    expect(formatVoiceTone(null)).toBeNull();
    expect(formatVoiceTone(undefined)).toBeNull();
    expect(formatVoiceTone({})).toBeNull();
    expect(formatVoiceTone({ scores: "garbage" })).toBeNull();
  });

  it("all scores at floor noise → null (no tone line beats a made-up one)", () => {
    expect(formatVoiceTone({ scores: { Joy: 0.05, Sadness: 0.04, Fear: 0.02 } })).toBeNull();
  });

  it("threshold is env-tunable without a deploy", () => {
    process.env.HUME_TONE_THRESHOLD = "0.2";
    try {
      expect(formatVoiceTone({ scores: { Anger: 0.205, Determination: 0.165 } })).toBe(
        "(voice tone: anger)",
      );
    } finally {
      delete process.env.HUME_TONE_THRESHOLD;
    }
  });
});

describe("prosody debug hook (HUME_PROSODY_DEBUG)", () => {
  it("when enabled, logs the prosody object of user messages — never their content", async () => {
    const { userId, email } = await signupUser("prosody");
    process.env.HUME_PROSODY_DEBUG = "1";
    const lines: Array<{ obj: unknown; msg: unknown }> = [];
    const spy = vi.spyOn(logger, "info").mockImplementation(((obj: unknown, msg: unknown) => {
      lines.push({ obj, msg });
      return logger;
    }) as never);
    try {
      const spoken = {
        role: "user",
        content: "a secret sentence that must not be logged",
        models: { prosody: { scores: { anything: 0.5 } } },
        time: { begin: 100, end: 900 },
      };
      const res = await postTurn({ bearer: mintVoiceToken(userId), messages: [spoken] });
      expect(res.status).toBe(200);
      const debugLines = lines.filter((l) => l.msg === "hume-prosody-debug");
      expect(debugLines).toHaveLength(1);
      expect(debugLines[0]!.obj).toEqual({ prosody: { scores: { anything: 0.5 } } });
      expect(JSON.stringify(debugLines[0]!.obj)).not.toContain("secret sentence");
    } finally {
      delete process.env.HUME_PROSODY_DEBUG;
      spy.mockRestore();
    }
    await waitForRows(userId, (r) => r.some((x) => x.startsWith("user:")));
    await cleanupUser(email);
  });

  it("when disabled (default), no prosody debug line is emitted", async () => {
    const { userId, email } = await signupUser("noprosody");
    const lines: unknown[] = [];
    const spy = vi.spyOn(logger, "info").mockImplementation(((_obj: unknown, msg: unknown) => {
      lines.push(msg);
      return logger;
    }) as never);
    try {
      await postTurn({ bearer: mintVoiceToken(userId), messages: [humeMsg("user", "hi there")] });
      expect(lines).not.toContain("hume-prosody-debug");
    } finally {
      spy.mockRestore();
    }
    await waitForRows(userId, (r) => r.some((x) => x.startsWith("user:")));
    await cleanupUser(email);
  });
});

describe("token-in-logs rule", () => {
  it("the voice token appears in no log line, from either carrier", async () => {
    const { userId, email } = await signupUser("logs");
    const token = mintVoiceToken(userId);

    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      return logger;
    };
    const spies = (["info", "warn", "error"] as const).map((lvl) =>
      vi.spyOn(logger, lvl).mockImplementation(capture as never),
    );

    const res = await postTurn({
      bearer: token,
      queryToken: token,
      messages: [humeMsg("user", "Hello there.")],
    });
    expect(res.status).toBe(200);
    for (const line of lines) expect(line).not.toContain(token);
    spies.forEach((s) => s.mockRestore());
    // Same persistence-vs-cleanup race guard as above.
    await waitForRows(userId, (r) => r.some((x) => x.startsWith("user:")));
    await cleanupUser(email);
  });
});
