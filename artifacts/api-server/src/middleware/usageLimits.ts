/**
 * Per-user usage ceilings on the endpoints that call PAID external APIs
 * (Anthropic for chat/voice replies, ElevenLabs for speech).
 *
 * Sizing philosophy (review finding "cost safety"): a genuinely heavy REAL
 * user should never see these — they exist to stop runaway scripts, broken
 * clients stuck in a retry loop, and stolen session cookies from running up
 * the Anthropic/ElevenLabs bill. Each endpoint gets an hourly ceiling (stops
 * fast loops) and a daily ceiling (stops slow ones). Current numbers, chosen
 * to sit ~3-5x above plausible heavy human use — tune via the env vars, no
 * code change needed:
 *
 *   Chat messages   (/chat/stream, /chat/send — shared budget)
 *     100/hour, 500/day        — a message every 36s for an hour straight,
 *                                all day, stays under the ceiling.
 *   "Listen" TTS    (/tts)
 *     120/hour, 600/day        — listening to every reply plus voice previews.
 *   Voice call starts (/voice-agent/session)
 *     40/hour, 120/day         — each mints a voice token + signed URL (cheap;
 *                                the paid minutes are the call itself). Sized
 *                                2x the old 20/60 because the client now also
 *                                PREFETCHES this endpoint on call intent
 *                                (hovering the Voice button) — see
 *                                aanya/src/lib/voiceSessionPrefetch.ts.
 *   Voice call turns (/voice-llm — ElevenLabs calls us per spoken exchange)
 *     600/hour, 2400/day       — a fast talker produces ~6 turns/min ≈ 360/h;
 *                                2400/day ≈ 4+ hours of continuous calling.
 *
 * Keys: the signed-in user's id wherever a session exists (so shared IPs —
 * offices, phone networks — never throttle each other). The voice-LLM
 * endpoint has no session (ElevenLabs' servers call it) — its key is the
 * userId inside the per-call HMAC voice token; requests without a valid
 * token fall back to a per-IP key and get their 401 from the handler.
 *
 * Counters are in-process (same as the auth limiters in app.ts): they reset
 * on deploy/restart, which is an acceptable failure mode for a cost guard.
 * All limits are env-overridable so the test suite can exercise the 429 path
 * deterministically (see setup/rate-limit-env.ts for the high test defaults).
 */

import type { Request, RequestHandler } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { verifyVoiceToken } from "../lib/voiceToken.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function envLimit(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Session-authenticated routes: key by userId (set by requireAuth). */
function sessionUserKey(req: Request): string {
  return req.userId ? `u:${req.userId}` : ipKeyGenerator(req.ip ?? "");
}

/** Voice-LLM callback: key by the userId inside the HMAC voice token. */
function voiceTokenKey(req: Request): string {
  const body = (req.body ?? {}) as Record<string, any>;
  const raw = body?.elevenlabs_extra_body?.user_token ?? body?.user_token ?? null;
  const auth = typeof raw === "string" ? verifyVoiceToken(raw) : null;
  return auth ? `u:${auth.userId}` : ipKeyGenerator(req.ip ?? "");
}

export function makeLimiter(opts: {
  windowMs: number;
  limit: number;
  message: string;
  keyGenerator: (req: Request) => string;
  /** "openai": error body shaped for the ElevenLabs custom-LLM caller. */
  shape?: "plain" | "openai";
}): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: opts.keyGenerator,
    handler: (_req, res) => {
      if (opts.shape === "openai") {
        // The voice-LLM endpoint is OpenAI-chat-completions compatible, so
        // its errors must be too — ElevenLabs parses this shape.
        res.status(429).json({
          error: { message: opts.message, type: "rate_limit_error" },
        });
        return;
      }
      // code: RATE_LIMITED lets clients distinguish this from other errors
      // without string-matching the human message.
      res.status(429).json({ error: opts.message, code: "RATE_LIMITED" });
    },
  });
}

/** Hourly + daily pair sharing one message; mounted in sequence. */
function limiterPair(args: {
  hourEnv: string;
  hourDefault: number;
  dayEnv: string;
  dayDefault: number;
  hourMessage: string;
  dayMessage: string;
  keyGenerator?: (req: Request) => string;
  shape?: "plain" | "openai";
}): RequestHandler[] {
  const key = args.keyGenerator ?? sessionUserKey;
  return [
    makeLimiter({
      windowMs: DAY_MS,
      limit: envLimit(args.dayEnv, args.dayDefault),
      message: args.dayMessage,
      keyGenerator: key,
      shape: args.shape,
    }),
    makeLimiter({
      windowMs: HOUR_MS,
      limit: envLimit(args.hourEnv, args.hourDefault),
      message: args.hourMessage,
      keyGenerator: key,
      shape: args.shape,
    }),
  ];
}

export const chatUsageLimits: RequestHandler[] = limiterPair({
  hourEnv: "CHAT_LIMIT_PER_HOUR",
  hourDefault: 100,
  dayEnv: "CHAT_LIMIT_PER_DAY",
  dayDefault: 500,
  hourMessage:
    "That's a lot of messages in a short time. Take a breather. You can keep talking in a little while, and nothing you've shared is lost.",
  dayMessage:
    "You've reached today's message limit. Everything you've shared is safe, and the conversation picks right back up tomorrow.",
});

export const ttsUsageLimits: RequestHandler[] = limiterPair({
  hourEnv: "TTS_LIMIT_PER_HOUR",
  hourDefault: 120,
  dayEnv: "TTS_LIMIT_PER_DAY",
  dayDefault: 600,
  hourMessage: "Voice playback needs a short break. Please try again in a little while.",
  dayMessage: "Voice playback has reached today's limit. It'll be back tomorrow.",
});

export const voiceSessionUsageLimits: RequestHandler[] = limiterPair({
  hourEnv: "VOICE_SESSION_LIMIT_PER_HOUR",
  hourDefault: 40,
  dayEnv: "VOICE_SESSION_LIMIT_PER_DAY",
  dayDefault: 120,
  hourMessage:
    "Voice calls need a short break. Please try again in a little while, or keep chatting by text.",
  dayMessage:
    "Voice calls have reached today's limit. They'll be back tomorrow. Text chat is always open.",
});

// Memory export ("download your journal", Sprint E). Unlike the paid-API
// limiters above, this guards a pure DB read — the ceiling exists to stop
// accidental double-clicks and unreasonable hammering of a heavy full-account
// query, not to control an external bill. One per hour per user is plenty: an
// export is a "grab a copy" action, not something a real person repeats. The
// single hourly window (no daily pair) is env-overridable so the test suite can
// drive the 429 path deterministically (setup/rate-limit-env.ts keeps the
// default high everywhere else).
export const memoryExportUsageLimits: RequestHandler[] = [
  makeLimiter({
    windowMs: HOUR_MS,
    limit: envLimit("MEMORY_EXPORT_LIMIT_PER_HOUR", 1),
    message:
      "You just downloaded your data. You can grab a fresh copy again in a little while. Everything's safe in the meantime.",
    keyGenerator: sessionUserKey,
  }),
];

// Reflection report generation. Unlike the memory export (a pure DB read), each
// generate makes a PAID pair of LLM calls (report + self-check), so this ceiling
// controls a real bill, not just double-clicks. A few per hour is plenty for a
// "reflect on my week" action. Env-overridable so the dedicated test can drive
// the 429 path (setup/rate-limit-env.ts keeps the default high everywhere else).
export const reflectionGenerateUsageLimits: RequestHandler[] = [
  makeLimiter({
    windowMs: HOUR_MS,
    limit: envLimit("REFLECTION_GENERATE_LIMIT_PER_HOUR", 3),
    message:
      "You just created a reflection. Give it a little while before generating another. Your past reflections are all still here.",
    keyGenerator: sessionUserKey,
  }),
];

// Memory reset ("reset my memory (dev)", founder-gated). One wipe per hour per
// user — stops an accidental double-click (or a testing hammer) from repeatedly
// deleting. Env-overridable so the dedicated test can drive the 429 path.
export const memoryResetUsageLimits: RequestHandler[] = [
  makeLimiter({
    windowMs: HOUR_MS,
    limit: envLimit("MEMORY_RESET_LIMIT_PER_HOUR", 1),
    message: "You just reset your memory. Give it a moment before doing it again.",
    keyGenerator: sessionUserKey,
  }),
];

export const voiceTurnUsageLimits: RequestHandler[] = limiterPair({
  hourEnv: "VOICE_TURN_LIMIT_PER_HOUR",
  hourDefault: 600,
  dayEnv: "VOICE_TURN_LIMIT_PER_DAY",
  dayDefault: 2400,
  hourMessage: "This call has been going fast. Give it a moment and try again.",
  dayMessage: "Voice calling has reached today's limit. It resets tomorrow.",
  keyGenerator: voiceTokenKey,
  shape: "openai",
});
