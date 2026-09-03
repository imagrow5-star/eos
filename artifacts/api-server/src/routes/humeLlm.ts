import { Router, type IRouter } from "express";
import { verifyVoiceToken } from "../lib/voiceToken.js";
import { humeTurnUsageLimits } from "../middleware/usageLimits.js";
import { voiceCompletionHandler } from "./voice-llm.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── Hume EVI custom-LLM endpoint ────────────────────────────────────────────
//
// Hume EVI POSTs OpenAI-style chat-completions requests here and expects an
// SSE stream back. This route authenticates, NORMALIZES Hume's request into
// the shape the shared voice handler reads ({messages, model, stream,
// user_token}), and delegates to voiceCompletionHandler (routes/voice-llm.ts)
// — the same brain as ElevenLabs calls: persona, real memory, frozen
// per-call prompts, crisis floor, persistence, extraction.
//
// AUTH: the same per-user HMAC voice token the ElevenLabs path uses,
// accepted from either place Hume can carry it:
//   - the Authorization header (the client sends the token as
//     session_settings.language_model_api_key; Hume forwards it as
//     `Authorization: Bearer <token>`);
//   - the custom_session_id query parameter (redundant second carrier).
// No static key exists: Hume's dashboard has no key field and a
// browser-shipped static secret is no secret. Tokenless requests (the Hume
// playground cannot send session_settings) get a 401 and load nothing.
//
// REQUEST SHAPE — from two real captured deliveries (2026-09-02), not
// inferred: {messages: [{role, content, models: {prosody}, time: {begin,
// end}}], model, stream}. No system message; content is a plain string.
// Two observed quirks the normalizer handles:
//   1. GREETING INSTRUCTION AS USER TEXT: the first request's only user
//      message was "Speak your greeting to the user." (Hume's greeting
//      trigger arrives as user content, unlike ElevenLabs' empty
//      transcript), and the next request PREPENDED that same instruction
//      to the user's actual words in one content string. The normalizer
//      strips it as a prefix; a message that was only the instruction
//      drops out entirely, which routes a greeting-only request into the
//      shared handler's synthetic-greeting fast path (curated instant
//      line), and keeps the instruction out of persisted chat history.
//      The literal must match the EVI config; update HUME_GREETING_PREFIX
//      if the config's greeting instruction ever changes.
//   2. DUPLICATED MESSAGES: the second capture carried the SAME user
//      message twice, byte-identical (role, content, time all equal).
//      Without dedup, downstream turn-merging would double the text into
//      the prompt and the persisted transcript. An adjacent message is
//      dropped only when role, content AND time are ALL identical —
//      genuinely repeated speech ("yes" … "yes") arrives with differing
//      time fields and survives.
//
// models.prosody was null in both captures (text input carries no voice).
// It is deliberately NOT consumed yet: per the capture-first rule, code
// that reads prosody scores waits for a real SPOKEN capture to pin the
// shape. normalizeHumeMessages keeps the field visible for that next step.
//
// TOKEN-IN-LOGS RULE (non-negotiable, unchanged): the pino-http serializer
// strips query strings from request lines, pino redact covers the
// authorization header, and this file never logs the token, req.url,
// req.query, or the Authorization value. Pinned by hume-llm.test.ts.

/** The greeting-trigger instruction observed verbatim in both captures. */
export const HUME_GREETING_PREFIX = "Speak your greeting to the user.";

export interface HumeChatMessage {
  role: "user" | "assistant";
  content: string;
  /** 48-dimension emotion scores when the user SPOKE — null for text input.
   *  Kept opaque until a real spoken capture pins the shape. */
  prosody: unknown;
}

/**
 * Normalize Hume's messages array per the observed quirks above:
 * role-filter → string contents → drop exact-adjacent duplicates → strip the
 * greeting instruction prefix → drop messages left empty. Exported for tests.
 */
export function normalizeHumeMessages(raw: unknown): HumeChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: HumeChatMessage[] = [];
  let prevKey: string | null = null;
  for (const m of raw) {
    const msg = m as {
      role?: unknown;
      content?: unknown;
      models?: { prosody?: unknown };
      time?: unknown;
    };
    if (msg?.role !== "user" && msg?.role !== "assistant") continue;
    if (typeof msg.content !== "string") continue;
    // Quirk 2: drop only BYTE-IDENTICAL adjacent repeats (role+content+time).
    const key = JSON.stringify([msg.role, msg.content, msg.time ?? null]);
    if (key === prevKey) continue;
    prevKey = key;

    let content = msg.content;
    if (msg.role === "user" && content.startsWith(HUME_GREETING_PREFIX)) {
      content = content.slice(HUME_GREETING_PREFIX.length).trim(); // quirk 1
    }
    if (!content.trim()) continue;
    out.push({ role: msg.role, content, prosody: msg.models?.prosody ?? null });
  }
  return out;
}

router.post(
  "/hume-llm/v1/chat/completions",
  ...humeTurnUsageLimits,
  async (req, res): Promise<void> => {
    const authHeader = req.header("authorization");
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    const queryToken = req.query?.custom_session_id;
    const token =
      (bearer && verifyVoiceToken(bearer) ? bearer : undefined) ??
      (typeof queryToken === "string" && verifyVoiceToken(queryToken) ? queryToken : undefined);
    if (!token) {
      logger.warn(
        { hadBearer: Boolean(bearer), hadQueryToken: typeof queryToken === "string" },
        "hume-llm: no valid voice token in Authorization or custom_session_id",
      );
      res.status(401).json({
        error: { message: "Invalid or missing user token", type: "invalid_request_error" },
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const messages = normalizeHumeMessages(body.messages);
    // Hand the shared handler exactly what it reads. The token rides as
    // user_token (its existing non-ElevenLabs slot); issuedAt inside it keys
    // the frozen per-call prompt and the pre-call history cutoff, same as an
    // ElevenLabs call. prosody is dropped at this boundary for now — see the
    // file header.
    req.body = {
      messages: messages.map(({ role, content }) => ({ role, content })),
      model: typeof body.model === "string" && body.model ? body.model : "eos-hume",
      stream: body.stream !== false,
      user_token: token,
    };
    await voiceCompletionHandler(req, res);
  },
);

export default router;
