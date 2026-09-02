import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import { verifyVoiceToken } from "../lib/voiceToken.js";
import { humeTurnUsageLimits } from "../middleware/usageLimits.js";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";

const router: IRouter = Router();

// ─── Hume EVI custom-LLM endpoint (CAPTURE STAGE) ────────────────────────────
//
// Hume EVI's custom language model POSTs OpenAI-style chat-completions
// requests here and expects an SSE stream back. Auth is B + A (two locks,
// the ElevenLabs route untouched):
//   B — Authorization: Bearer <HUME_CLM_API_KEY>: a static secret configured
//       in the Hume dashboard. Proves the request came through Hume's
//       infrastructure and satisfies Hume's config-time validation probe.
//   A — custom_session_id QUERY parameter carrying the same per-user HMAC
//       voice token ElevenLabs uses (Hume echoes what our client sets at
//       session start). Proves WHICH user the call belongs to, with the
//       exact verifyVoiceToken checks the ElevenLabs path runs.
// A Bearer-only request (no/invalid token) is treated as Hume's anonymous
// config probe: it gets the canned reply below and loads NO user data.
//
// TOKEN-IN-LOGS RULE (non-negotiable): the voice token must never reach the
// Render logs. Three layers:
//   1. the global pino-http req serializer strips the query string from
//      every request-completed line (app.ts — url.split("?")[0]);
//   2. the pino redact config covers req.headers.authorization/cookie on
//      any line that ever logs a raw req object;
//   3. THIS FILE never logs req.url, req.originalUrl, req.query, the token,
//      or the Authorization value — the capture line below logs a
//      hand-picked header subset with authorization/cookie removed.
// hume-llm.test.ts pins layer 3 by spying the logger during a real request.
//
// CAPTURE STAGE (temporary): the real message parsing is NOT built yet —
// Hume embeds prosody/emotion annotations into user messages, and the
// parser will be written against a REAL captured request, not inferred
// (same discipline as the Dodo and ElevenLabs captures). Until then this
// route logs each request body base64-chunked (marker "hume-clm-capture")
// and answers a canned spoken line so the Hume probe and a test call
// succeed. DELETE the capture block and canned reply when the real
// handler lands. Capturing the founder's own test-call content into our
// logs is the same deliberate one-off exception as the earlier captures.

const CHUNK_CHARS = 4000;

/** Headers safe to log: allowlist only — never authorization/cookie. */
export function captureSafeHeaders(req: {
  headers: Record<string, string | string[] | undefined>;
}): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const name of ["user-agent", "content-type", "content-length", "accept", "accept-encoding"]) {
    if (req.headers[name] !== undefined) out[name] = req.headers[name];
  }
  return out;
}

function bearerMatches(header: string | undefined, key: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(key);
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

/** One canned OpenAI-style SSE completion — spoken by EVI on test calls. */
function writeCannedSse(res: import("express").Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  const id = `chatcmpl-eos-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: "eos-hume-capture",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  res.write(chunk({ role: "assistant" }, null));
  res.write(
    chunk({ content: "Hi, it's Eos. I'm still being connected to this voice — hang tight." }, null),
  );
  res.write(chunk({}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

router.post(
  "/hume-llm/v1/chat/completions",
  ...humeTurnUsageLimits,
  (req, res): void => {
    const key = process.env.HUME_CLM_API_KEY?.trim();
    if (!key) {
      logger.error("hume-llm: HUME_CLM_API_KEY not set — rejecting request");
      res.status(503).json({
        error: { message: "Hume integration not configured", type: "invalid_request_error" },
      });
      return;
    }

    // Lock B: static Bearer key — proves the request came through Hume.
    if (!bearerMatches(req.header("authorization"), key)) {
      logger.warn("hume-llm: missing or invalid Bearer key");
      res.status(401).json({
        error: { message: "Invalid or missing API key", type: "invalid_request_error" },
      });
      return;
    }

    // Lock A: per-user voice token via custom_session_id. Absent/invalid →
    // anonymous probe: canned reply only, no user data loaded, ever.
    const rawToken = req.query?.custom_session_id;
    const auth = typeof rawToken === "string" ? verifyVoiceToken(rawToken) : null;

    // ── CAPTURE (temporary — see the file header) ───────────────────────────
    try {
      const raw: Buffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(JSON.stringify(req.body ?? null), "utf8");
      const b64 = raw.toString("base64");
      const totalChunks = Math.max(1, Math.ceil(b64.length / CHUNK_CHARS));
      const uh = auth ? hashUserIdForLog(auth.userId) : undefined;
      logger.info(
        { headers: captureSafeHeaders(req), bodyBytes: raw.length, totalChunks, uh, probe: !auth },
        "hume-clm-capture headers",
      );
      for (let i = 0; i < totalChunks; i++) {
        logger.info(
          { part: `${i + 1}/${totalChunks}`, b64: b64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) },
          "hume-clm-capture body",
        );
      }
    } catch (err) {
      logger.error({ err }, "hume-clm-capture failed to log request");
    }

    writeCannedSse(res);
  },
);

export default router;
