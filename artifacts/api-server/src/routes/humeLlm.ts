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
// PROSODY → VOICE-TONE CONTEXT: a real spoken capture (2026-09-03) pinned
// the shape — prosody.scores is a flat object of 48 named emotions with
// float confidences 0..1; Hume's own instruction turns (and text input)
// carry prosody: null. formatVoiceTone turns the fresh user turn's scores
// into a short context line, e.g. "(voice tone: anger, determination,
// contempt)", which rides to the shared handler as body.voice_tone and is
// appended to the MODEL-facing user content only — heard, never persisted,
// and never in systemExtra (a per-turn system change would void the frozen
// prompt cache every turn; the final user message is uncached anyway).
// No prosody → no line: Eos simply doesn't get tone context for that turn.
//
// TOKEN-IN-LOGS RULE (non-negotiable, unchanged): the pino-http serializer
// strips query strings from request lines, pino redact covers the
// authorization header, and this file never logs the token, req.url,
// req.query, or the Authorization value. Pinned by hume-llm.test.ts.

/** The greeting-trigger instruction observed verbatim in both captures. */
export const HUME_GREETING_PREFIX = "Speak your greeting to the user.";

// Quirk 3 (seen live 2026-09-03, after the EVI config was edited in the
// dashboard): EVI now appends its expression annotation to the TRANSCRIPT
// text itself — user content arrives as e.g.
//   "Rato. {very slightly excited, very slightly amused}"
// Tone context must reach the model ONLY via formatVoiceTone (built from the
// structured prosody scores we already receive), and the braces must never
// hit the prompt or the persisted transcript. ASR never emits braces, so any
// {…} group in USER content is Hume's annotation, not the user's speech —
// strip them all, wherever they sit in the string.
export function stripExpressionTags(content: string): string {
  return content.replace(/\{[^{}]*\}/g, " ").replace(/\s{2,}/g, " ").trim();
}

// ─── Voice-tone extraction ───────────────────────────────────────────────────
// Threshold 0.12 (env-tunable), top 3 emotions. Calibrated on the three real
// spoken captures: a joyful greeting (Joy .598, Excitement .213,
// Determination .142), a frustrated turn (Anger .205, Determination .165,
// Contempt .158), and a quiet low-arousal turn (Sadness .169, Confusion
// .139, Pain .128). A 0.15 cut keeps the loud turns intact but reduces the
// quiet one to "sadness" alone — and quiet turns are exactly where tone
// context matters most (low-arousal speech compresses all scores downward).
// 0.12 keeps each sample's genuinely dominant cluster while sitting far
// above the ≤0.05 floor noise visible across all 48 dimensions.
const TONE_MAX_EMOTIONS = 3;
function toneThreshold(): number {
  const raw = Number(process.env.HUME_TONE_THRESHOLD ?? "");
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.12;
}

/**
 * Format prosody scores into the per-turn tone line, or null when there is
 * nothing meaningful to say (no prosody — Hume instruction turns and text
 * input — or no score above the threshold). Exported for tests.
 */
export function formatVoiceTone(prosody: unknown): string | null {
  const scores = (prosody as { scores?: unknown } | null | undefined)?.scores;
  if (!scores || typeof scores !== "object") return null;
  const threshold = toneThreshold();
  const top = Object.entries(scores as Record<string, unknown>)
    .filter((e): e is [string, number] => typeof e[1] === "number" && e[1] >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TONE_MAX_EMOTIONS)
    .map(([name]) => name.toLowerCase());
  return top.length ? `(voice tone: ${top.join(", ")})` : null;
}

export interface HumeChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Prosody model output when the user SPOKE — shape pinned by the real
   *  spoken captures (2026-09-03): { scores: <48 named emotions, floats
   *  0..1> }, consumed by formatVoiceTone. Null for text input and Hume's
   *  own instruction turns. */
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
    if (msg.role === "user") content = stripExpressionTags(content); // quirk 3
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
    // Tone context comes from the FRESH turn — the last user message; older
    // turns' prosody already shaped their own replies.
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const voiceTone = lastUser ? formatVoiceTone(lastUser.prosody) : null;

    // ── Prosody shape capture (env-gated, founder-only) ─────────────────────
    // A real SPOKEN turn is needed to pin models.prosody's exact shape
    // before any code consumes it (capture-first rule — text turns carry
    // null). With HUME_PROSODY_DEBUG=1, the prosody value of each incoming
    // user message is logged — emotion scores only, NEVER message content.
    // Default off; flip on in Render for one spoken test, then off again.
    if (process.env.HUME_PROSODY_DEBUG === "1") {
      for (const m of messages) {
        if (m.role === "user") logger.info({ prosody: m.prosody }, "hume-prosody-debug");
      }
    }
    // Hand the shared handler exactly what it reads. The token rides as
    // user_token (its existing non-ElevenLabs slot); issuedAt inside it keys
    // the frozen per-call prompt and the pre-call history cutoff, same as an
    // ElevenLabs call. voice_tone (when the turn carried prosody) is applied
    // by the handler to the model-facing user content only.
    req.body = {
      messages: messages.map(({ role, content }) => ({ role, content })),
      model: typeof body.model === "string" && body.model ? body.model : "eos-hume",
      stream: body.stream !== false,
      user_token: token,
      ...(voiceTone ? { voice_tone: voiceTone } : {}),
    };
    await voiceCompletionHandler(req, res);
  },
);

export default router;
