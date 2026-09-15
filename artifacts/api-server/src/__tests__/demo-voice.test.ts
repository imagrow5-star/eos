/**
 * The landing-page voice demo (routes/demoVoice.ts, services/demoVoice.ts,
 * lib/demoVoiceToken.ts): one minute of a real Hume call, no signup, and
 * the three protections around it.
 *
 *  • the call token is its own thing: never a user token, never accepted
 *    by the user-token verifier, refused once the minute plus grace is up;
 *  • availability: yes with Hume configured; no after this browser (cookie)
 *    or this address (hashed) has had today's call; no when the day's
 *    spend budget can't fit another minute; no when the feature is off;
 *  • the session mint reserves the full minute, marks the browser with a
 *    cookie that lasts until midnight UTC, and never returns the Hume key;
 *  • the end report settles the duration from the server's clocks, is
 *    idempotent, and a call that never connected frees the browser and
 *    the address again;
 *  • the Hume CLM route hands a demo token to the demo brain: greeting
 *    line, streamed reply, crisis card via the status poll — and nothing
 *    lands in messages or crisis_events;
 *  • the demo token never reaches a log line.
 *
 * Hume's OAuth exchange is intercepted at the fetch layer (as in
 * hume-session.test.ts). Keyless mock mode for the model.
 */

import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import request from "supertest";
import pg from "pg";
import type { Express } from "express";

process.env.HUME_API_KEY = "hume-test-api-key";
process.env.HUME_SECRET_KEY = "hume-test-secret-key";
process.env.HUME_CONFIG_ID = "cfg_test_1";
process.env.HUME_API_BASE = "https://hume-test.invalid";

const priorFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://hume-test.invalid/oauth2-cc/token")) {
    return Promise.resolve(new Response(JSON.stringify({ access_token: "hume-access-token-test" }), { status: 200 }));
  }
  return priorFetch(input, init);
}) as typeof fetch;

import { logger } from "../lib/logger.js";
import { mintVoiceToken, verifyVoiceToken } from "../lib/voiceToken.js";
import { mintDemoVoiceToken, verifyDemoVoiceToken, parseDemoVoiceToken } from "../lib/demoVoiceToken.js";
import {
  DEMO_VOICE_SECONDS,
  DEMO_VOICE_TOKEN_TTL_MS,
  DEMO_VOICE_COOKIE,
  demoVoiceCapSeconds,
  hashDemoIp,
  utcNextMidnight,
  cookieMarksVoiceDemo,
} from "../services/demoVoice.js";
import { GREETING_POOLS } from "../services/voiceGreeting.js";
import { HUME_GREETING_PREFIX } from "../routes/humeLlm.js";

const DB = Boolean(process.env.DATABASE_URL);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const testStart = new Date();

let app: Express;
let nextIp = 1;
/** A fresh address per call — trust proxy is on, so req.ip reads this. */
function freshIp(): string {
  return `203.0.113.${nextIp++}`;
}

beforeAll(async () => {
  app = (await import("../app.js")).default;
});
afterAll(async () => {
  if (DB) await pool.query("DELETE FROM demo_sessions WHERE started_at >= $1", [testStart]);
  await pool.end();
});

function humeMsg(role: string, content: string) {
  return { role, content, models: { prosody: null }, time: { begin: 0, end: 0 } };
}

const avail = (ip: string, cookie?: string) => {
  const r = request(app).get("/api/demo/voice/availability").set("X-Forwarded-For", ip);
  return cookie ? r.set("Cookie", cookie) : r;
};
const mint = (ip: string) => request(app).post("/api/demo/voice/session").set("X-Forwarded-For", ip).send({});
const turn = (token: string, messages: unknown[]) =>
  request(app)
    .post("/api/hume-llm/v1/chat/completions")
    .set("Authorization", `Bearer ${token}`)
    .send({ messages, model: "eos", stream: true });

async function countRows(table: string): Promise<number> {
  const r = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(r.rows[0]!.n);
}

describe("demo voice token", () => {
  it("is never a user token, and a user token is never a demo token", () => {
    const demo = mintDemoVoiceToken(42, DEMO_VOICE_TOKEN_TTL_MS);
    expect(demo.startsWith("demo.42.")).toBe(true);
    expect(verifyDemoVoiceToken(demo)).toMatchObject({ callId: 42 });
    expect(verifyVoiceToken(demo)).toBeNull();
    expect(verifyDemoVoiceToken(mintVoiceToken(7))).toBeNull();
  });

  it("refuses tampering and expiry; the end report can still read an expired one", () => {
    const now = Date.now();
    const demo = mintDemoVoiceToken(5, DEMO_VOICE_TOKEN_TTL_MS, now);
    expect(verifyDemoVoiceToken(demo.replace("demo.5.", "demo.6."))).toBeNull();
    expect(verifyDemoVoiceToken(demo, now + DEMO_VOICE_TOKEN_TTL_MS + 1)).toBeNull();
    expect(parseDemoVoiceToken(demo)).toMatchObject({ callId: 5, issuedAt: now });
    expect(DEMO_VOICE_TOKEN_TTL_MS).toBe(DEMO_VOICE_SECONDS * 1000 + 15_000);
  });
});

describe("the spend cap and the cookie, as pure rules", () => {
  it("$3 a day at $0.07 a minute is 2571 seconds of voice", () => {
    expect(demoVoiceCapSeconds()).toBe(2571);
  });
  it("the cookie is read by name, and the address is stored hashed", () => {
    expect(cookieMarksVoiceDemo(`${DEMO_VOICE_COOKIE}=1; sid=abc`)).toBe(true);
    expect(cookieMarksVoiceDemo("sid=abc")).toBe(false);
    expect(cookieMarksVoiceDemo(undefined)).toBe(false);
    expect(hashDemoIp("203.0.113.9")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDemoIp("203.0.113.9")).not.toContain("203");
    expect(utcNextMidnight(new Date("2026-09-14T17:30:00Z")).toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });
});

describe.skipIf(!DB)("availability and the session mint", () => {
  it("is available to a fresh address; the mint reserves the minute and marks the browser", async () => {
    const ip = freshIp();
    expect((await avail(ip)).body).toEqual({ available: true });

    const res = await mint(ip);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.accessToken).toBe("hume-access-token-test");
    expect(res.body.configId).toBe("cfg_test_1");
    expect(typeof res.body.humeVoiceId).toBe("string");
    expect(res.body.seconds).toBe(DEMO_VOICE_SECONDS);
    expect(JSON.stringify(res.body)).not.toContain("hume-test-api-key");
    expect(JSON.stringify(res.body)).not.toContain("hume-test-secret-key");

    const claims = verifyDemoVoiceToken(res.body.token);
    expect(claims).not.toBeNull();
    const cookie = (res.headers["set-cookie"] as unknown as string[] | undefined)?.[0] ?? "";
    expect(cookie).toContain(`${DEMO_VOICE_COOKIE}=1`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Expires=");

    const row = await pool.query("SELECT * FROM demo_sessions WHERE id = $1", [claims!.callId]);
    expect(row.rows[0]).toMatchObject({ kind: "voice", seconds: DEMO_VOICE_SECONDS, ended_at: null, ended_reason: null });
    expect(row.rows[0].ip_hash).toBe(hashDemoIp(ip));

    // The same address is done for the day; so is a browser carrying the cookie.
    expect((await avail(ip)).body).toEqual({ available: false });
    expect((await mint(ip)).body).toEqual({ available: false });
    expect((await avail(freshIp(), `${DEMO_VOICE_COOKIE}=1`)).body).toEqual({ available: false });
  });

  it("is not available when the day's budget can't fit another minute", async () => {
    await pool.query("INSERT INTO demo_sessions (kind, seconds, ended_reason) VALUES ('voice', $1, 'ended')", [
      demoVoiceCapSeconds() - DEMO_VOICE_SECONDS + 1,
    ]);
    try {
      expect((await avail(freshIp())).body).toEqual({ available: false });
    } finally {
      await pool.query("DELETE FROM demo_sessions WHERE seconds > $1", [DEMO_VOICE_SECONDS]);
    }
  });

  it("is not available when switched off", async () => {
    process.env.DEMO_VOICE_ENABLED = "off";
    try {
      expect((await avail(freshIp())).body).toEqual({ available: false });
    } finally {
      delete process.env.DEMO_VOICE_ENABLED;
    }
  });
});

describe.skipIf(!DB)("the end report", () => {
  it("settles from the server's clocks, once; 'failed' frees the browser and the address", async () => {
    const ip = freshIp();
    const { token } = (await mint(ip)).body;
    const end = await request(app).post("/api/demo/voice/end").send({ token, reason: "ended" });
    expect(end.status).toBe(200);
    expect(end.body.reason).toBe("ended");
    expect(end.body.seconds).toBeGreaterThanOrEqual(1);
    expect(end.body.seconds).toBeLessThan(DEMO_VOICE_SECONDS);
    // A second report changes nothing.
    const again = await request(app).post("/api/demo/voice/end").send({ token, reason: "limit" });
    expect(again.body).toEqual(end.body);
    expect((await avail(ip)).body).toEqual({ available: false });

    const ip2 = freshIp();
    const { token: t2 } = (await mint(ip2)).body;
    const failed = await request(app).post("/api/demo/voice/end").send({ token: t2, reason: "failed" });
    expect(failed.body.reason).toBe("failed");
    const cookie = (failed.headers["set-cookie"] as unknown as string[] | undefined)?.[0] ?? "";
    expect(cookie).toMatch(new RegExp(`${DEMO_VOICE_COOKIE}=;`));
    expect((await avail(ip2)).body).toEqual({ available: true });

    expect((await request(app).post("/api/demo/voice/end").send({ token: "nope", reason: "ended" })).status).toBe(400);
    expect((await request(app).post("/api/demo/voice/end").send({ token: mintVoiceToken(1), reason: "ended" })).status).toBe(400);
  });
});

describe.skipIf(!DB)("the Hume brain, demo edition", () => {
  it("greets, replies, shows the crisis card through the status poll, and stores no words", async () => {
    const { token } = (await mint(freshIp())).body;

    const greet = await turn(token, [humeMsg("user", HUME_GREETING_PREFIX)]);
    expect(greet.status).toBe(200);
    expect(greet.headers["content-type"]).toMatch(/text\/event-stream/);
    const spoken = [...greet.text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join("");
    expect(GREETING_POOLS.anytime.map((t) => t(null))).toContain(spoken);

    const reply = await turn(token, [humeMsg("user", "I've been putting off calling my mother."), ]);
    expect(reply.status).toBe(200);
    expect(reply.text).toContain("data: [DONE]");
    expect((await request(app).get("/api/demo/voice/status").query({ token })).body).toEqual({});

    const crisis = await turn(token, [
      humeMsg("user", "I've been putting off calling my mother."),
      humeMsg("assistant", "That sounds heavy."),
      humeMsg("user", "I want to kill myself"),
    ]);
    expect(crisis.status).toBe(200);
    const status = await request(app).get("/api/demo/voice/status").query({ token });
    expect(status.body.crisisHelplineBlock).toMatch(/^—\nSomeone who can be with you right now/);

    // Other suites write to AND clean up these tables in parallel, so total
    // counts can go either way; only assert that this call added nothing
    // tied to it: no ownerless rows exist at all.
    expect(Number((await pool.query("SELECT count(*) AS n FROM messages WHERE user_id IS NULL OR user_id < 0")).rows[0].n)).toBe(0);
    expect(Number((await pool.query("SELECT count(*) AS n FROM crisis_events WHERE user_id IS NULL OR user_id < 0")).rows[0].n)).toBe(0);
  });

  it("answers nothing once the minute plus grace has passed", async () => {
    const expired = mintDemoVoiceToken(1, DEMO_VOICE_TOKEN_TTL_MS, Date.now() - DEMO_VOICE_TOKEN_TTL_MS - 1000);
    const res = await turn(expired, [humeMsg("user", "still there?")]);
    expect(res.status).toBe(401);
  });

  it("the demo token never reaches a log line", async () => {
    const lines: string[] = [];
    const capture = (obj: unknown, msg?: unknown) => {
      lines.push(JSON.stringify(obj) + " " + String(msg ?? ""));
      return logger;
    };
    const spies = (["info", "warn", "error", "debug"] as const).map((lvl) =>
      vi.spyOn(logger, lvl).mockImplementation(capture as never),
    );
    try {
      const { token } = (await mint(freshIp())).body;
      await turn(token, [humeMsg("user", "hello there")]);
      await request(app).get("/api/demo/voice/status").query({ token });
      await request(app).post("/api/demo/voice/end").send({ token, reason: "ended" });
      const sig = token.split(".").pop()!;
      expect(lines.some((l) => l.includes(sig))).toBe(false);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
