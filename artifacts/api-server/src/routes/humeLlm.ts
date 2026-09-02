import { Router, type IRouter } from "express";
import { verifyVoiceToken } from "../lib/voiceToken.js";
import { humeTurnUsageLimits } from "../middleware/usageLimits.js";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";

const router: IRouter = Router();

// ─── Hume EVI custom-LLM endpoint (CAPTURE STAGE) ────────────────────────────
//
// Hume EVI's custom language model POSTs OpenAI-style chat-completions
// requests here and expects an SSE stream back. Auth is the same per-user
// HMAC voice token the ElevenLabs path uses (that route is untouched),
// accepted from either place Hume can carry it:
//   - the Authorization header: the client sends the token as
//     session_settings.language_model_api_key at session start, and Hume
//     forwards it as `Authorization: Bearer <token>` on every request;
//   - the custom_session_id query parameter (redundant second carrier —
//     Hume appends what the client sets to every request URL).
// There is deliberately NO static API key: Hume's dashboard has no key
// field (the key only exists as a per-session client setting), and a
// static secret shipped to browsers is no secret. The voice token is the
// stronger credential anyway — per-user, short-lived, signed by us. A
// request with no valid token (e.g. a Hume playground session, which
// sends no session_settings) gets a 401 and loads nothing.
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
// and answers a canned spoken line so a test session succeeds. DELETE the
// capture block and canned reply when the real handler lands. Capturing
// the founder's own test-call content into our logs is the same
// deliberate one-off exception as the earlier captures. The capture is
// produced by scripts/src/hume-clm-capture-test.ts (the Hume playground
// cannot send session_settings, so it cannot authenticate).

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
    // The voice token, from either carrier (header wins; both verify the
    // same way). Full verifyVoiceToken — this is a live request path, so
    // expiry is enforced, unlike the post-call webhook's parser.
    const authHeader = req.header("authorization");
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    const queryToken = req.query?.custom_session_id;
    const auth =
      (bearer ? verifyVoiceToken(bearer) : null) ??
      (typeof queryToken === "string" ? verifyVoiceToken(queryToken) : null);
    if (!auth) {
      logger.warn(
        { hadBearer: Boolean(bearer), hadQueryToken: typeof queryToken === "string" },
        "hume-llm: no valid voice token in Authorization or custom_session_id",
      );
      res.status(401).json({
        error: { message: "Invalid or missing user token", type: "invalid_request_error" },
      });
      return;
    }

    // ── CAPTURE (temporary — see the file header) ───────────────────────────
    try {
      const raw: Buffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(JSON.stringify(req.body ?? null), "utf8");
      const b64 = raw.toString("base64");
      const totalChunks = Math.max(1, Math.ceil(b64.length / CHUNK_CHARS));
      const uh = hashUserIdForLog(auth.userId);
      logger.info(
        {
          headers: captureSafeHeaders(req),
          bodyBytes: raw.length,
          totalChunks,
          uh,
          tokenCarrier: bearer ? "bearer" : "query",
        },
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
