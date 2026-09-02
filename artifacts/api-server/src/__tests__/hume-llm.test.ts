/**
 * Hume EVI custom-LLM endpoint (capture stage) — voice-token auth.
 *
 * The route accepts the per-user HMAC voice token from either carrier Hume
 * offers: the Authorization Bearer (the client sends the token as
 * session_settings' language_model_api_key) or the custom_session_id query
 * parameter. No static key exists — Hume's dashboard has no key field, and
 * a browser-shipped static secret is no secret.
 *
 * Covers: both carriers, tokenless/garbage/expired 401s, the canned SSE
 * reply shape, and THE non-negotiable: the voice token never reaches a log
 * line emitted by the route (pinned by spying the shared logger during real
 * requests — the global pino-http request line is separately safe because
 * its serializer strips the query string, app.ts `url.split("?")[0]`).
 */

import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import pg from "pg";

import app from "../app.js";
import { logger } from "../lib/logger.js";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { captureSafeHeaders } from "../routes/humeLlm.js";

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
    DELETE FROM profile WHERE user_id = ${uid};
    DELETE FROM users   WHERE id      = ${uid};
    COMMIT;
  `);
}

async function signupUser(tag: string) {
  const email = nextEmail(tag);
  const res = await request(app).post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(res.status).toBe(201);
  return { userId: res.body.user.id as number, email };
}

const TURN_BODY = { messages: [{ role: "user", content: "Hello." }], model: "eos" };

function postTurn(opts: { bearer?: string; queryToken?: string; body?: unknown }) {
  const url =
    "/api/hume-llm/v1/chat/completions" +
    (opts.queryToken !== undefined
      ? `?custom_session_id=${encodeURIComponent(opts.queryToken)}`
      : "");
  const r = request(app).post(url).set("Content-Type", "application/json");
  if (opts.bearer !== undefined) r.set("Authorization", `Bearer ${opts.bearer}`);
  return r.send(JSON.stringify(opts.body ?? TURN_BODY));
}

afterAll(async () => {
  for (const email of emails) await cleanupUser(email);
  await pool.end();
});

beforeEach(() => {
  vi.restoreAllMocks();
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

  it("401 with an EXPIRED token — this is a live request path, unlike the post-call webhook", async () => {
    const { userId, email } = await signupUser("expired");
    const res = await postTurn({ bearer: mintVoiceToken(userId, -1000) });
    expect(res.status).toBe(401);
    await cleanupUser(email);
  });

  it("valid token as Bearer (session_settings.language_model_api_key path) → canned SSE", async () => {
    const { userId, email } = await signupUser("bearer");
    const res = await postTurn({ bearer: mintVoiceToken(userId) });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain('"object":"chat.completion.chunk"');
    expect(res.text).toContain("data: [DONE]");
    await cleanupUser(email);
  });

  it("valid token via custom_session_id alone (redundant carrier) → canned SSE", async () => {
    const { userId, email } = await signupUser("query");
    const res = await postTurn({ queryToken: mintVoiceToken(userId) });
    expect(res.status).toBe(200);
    expect(res.text).toContain("data: [DONE]");
    await cleanupUser(email);
  });
});

describe("token-in-logs rule", () => {
  it("the voice token appears in no route log line, from either carrier", async () => {
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

    const res = await postTurn({ bearer: token, queryToken: token });
    expect(res.status).toBe(200);
    expect(lines.length).toBeGreaterThan(0); // the capture lines fired
    for (const line of lines) expect(line).not.toContain(token);
    spies.forEach((s) => s.mockRestore());
    await cleanupUser(email);
  });

  it("captureSafeHeaders is an allowlist — authorization and cookie never pass", () => {
    const out = captureSafeHeaders({
      headers: {
        authorization: "Bearer super-secret",
        cookie: "sid=abc",
        "user-agent": "Hume/1.0",
        "content-type": "application/json",
        "x-anything-else": "dropped",
      },
    });
    expect(out).toEqual({ "user-agent": "Hume/1.0", "content-type": "application/json" });
  });
});

describe("capture", () => {
  it("logs the request body base64-chunked with the hume-clm-capture marker", async () => {
    const { userId, email } = await signupUser("capture");
    const lines: Array<{ obj: unknown; msg: unknown }> = [];
    const spy = vi
      .spyOn(logger, "info")
      .mockImplementation(((obj: unknown, msg: unknown) => {
        lines.push({ obj, msg });
        return logger;
      }) as never);

    const body = { messages: [{ role: "user", content: "capture me" }] };
    await postTurn({ bearer: mintVoiceToken(userId), body });

    const bodyLines = lines.filter((l) => l.msg === "hume-clm-capture body");
    expect(bodyLines.length).toBeGreaterThan(0);
    const b64 = bodyLines.map((l) => (l.obj as { b64: string }).b64).join("");
    expect(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))).toEqual(body);
    spy.mockRestore();
    await cleanupUser(email);
  });
});
