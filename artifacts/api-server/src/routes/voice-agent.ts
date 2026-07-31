import { Router, type IRouter } from "express";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { getOrCreateProfileForUser } from "./profile.js";
import { isVoiceCallEnabled } from "../lib/featureFlags.js";
import { voiceSessionUsageLimits } from "../middleware/usageLimits.js";
import { buildVoiceFirstMessage } from "../services/voiceGreeting.js";
import { logger } from "../lib/logger.js";
import { resolveHelplines, buildHelplineBlockText } from "../services/crisis/helplines.js";
import { pendingVoiceCrisisEvent, dismissVoiceCrisisEvent } from "../services/crisis/events.js";
import { resolveAgentRouting } from "../services/voiceAgentRouting.js";

const router: IRouter = Router();

// ─── Voice-agent session bootstrap (session-authenticated) ───────────────────
// Called by the web client when the user starts a voice call. Returns what the
// browser needs to open an ElevenLabs Conversational AI session:
//   - a per-user HMAC token the agent passes back to our custom-LLM endpoint
//     (see voice-llm.ts) so the right person's memory is loaded
//   - a signed WebSocket URL (required for private agents — the default)
//
// IMPORTANT: when the signed-URL request fails we return the SPECIFIC failure
// reason instead of silently downgrading to "public agent id" mode. A private
// agent rejects id-only connections by closing the socket immediately, which
// looks like a silent instant drop in the UI — the exact bug this prevents.

router.post("/voice-agent/session", ...voiceSessionUsageLimits, async (req, res): Promise<void> => {
  if (!isVoiceCallEnabled()) {
    res.json({ available: false, reason: "disabled" });
    return;
  }

  const baseAgentId = process.env.ELEVENLABS_AGENT_ID?.trim();
  if (!baseAgentId) {
    res.json({ available: false, reason: "not_configured" });
    return;
  }

  const userToken = mintVoiceToken(req.userId);
  const apiKey = process.env.ELEVENLABS_API_KEY;

  // The profile now loads BEFORE the signed-URL fetch: agent routing needs the
  // user's language (English → Flash agent; active non-English → Multilingual
  // agent). This trades the old profile/fetch concurrency for one local DB
  // read (~ms) ahead of the ElevenLabs round trip (~hundreds of ms) — cheap,
  // and the tone/greeting inputs come from the same read.
  let tone = "auto";
  let firstMessage: string;
  let preferredLanguage = "en";
  try {
    const profile = await getOrCreateProfileForUser(req.userId);
    tone = (profile as { voiceTone?: string }).voiceTone ?? "auto";
    preferredLanguage = (profile as { preferredLanguage?: string }).preferredLanguage ?? "en";
    firstMessage = buildVoiceFirstMessage(profile);
  } catch (err) {
    logger.warn({ err }, "voice-agent: couldn't load profile — using defaults");
    firstMessage = buildVoiceFirstMessage(null);
  }

  // Route the call to the language-appropriate agent (safe-degrades inside).
  const routing = resolveAgentRouting({ preferredLanguage });
  const agentId = routing.agentId ?? baseAgentId;
  logger.info(
    { userId: req.userId, preferredLanguage, agentUsed: routing.agentUsed },
    "voice-agent: call routed",
  );
  // Language code (multilingual-agent calls only) — INFORMATIONAL for the
  // client. It is deliberately NOT forwarded to ElevenLabs anymore: the
  // agent.language override is rejected by config with a post-connect 1008
  // that kills the call (July 31 — same pattern as first_message).
  // Transcription language comes from the multilingual agent's own dashboard
  // config; Multilingual v2 TTS speaks whatever language the reply text is in.
  const language = routing.agentUsed === "multilingual" ? preferredLanguage : undefined;

  const signedUrlPromise: Promise<{ r: Response } | { err: unknown }> | null = apiKey
    ? fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
        { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(8000) },
      ).then(
        (r) => ({ r }),
        (err: unknown) => ({ err }),
      )
    : null;

  // "How Eos speaks" preference rides along so the client can set matching
  // TTS delivery overrides (stability/speed) on the ElevenLabs session.
  // firstMessage is still computed and returned, but the client NO LONGER
  // forwards it to ElevenLabs: the first_message override is rejected with a
  // 1008 disconnect since ~July 29 (permission tightened on their side; no
  // dashboard toggle on our tier). Greetings come from the custom LLM's
  // synthetic-greeting path instead (routes/voice-llm.ts).
  // TODO(cleanup): drop firstMessage from this response + voiceGreeting.ts
  // once the LLM greeting is confirmed as the permanent path.

  if (!signedUrlPromise) {
    // No API key to sign with — only a PUBLIC agent can possibly work. Let the
    // browser try; if the agent is private the client will surface the drop.
    logger.warn("ELEVENLABS_API_KEY not set — attempting public-agent voice call");
    res.json({
      available: true,
      mode: "public",
      agentId,
      userToken,
      tone,
      firstMessage,
      ...(language ? { language } : {}),
    });
    return;
  }

  try {
    const settled = await signedUrlPromise;
    if ("err" in settled) throw settled.err;
    const r = settled.r;

    if (r.ok) {
      const data = (await r.json()) as { signed_url?: string };
      if (data?.signed_url) {
        res.json({
          available: true,
          mode: "signed",
          signedUrl: data.signed_url,
          userToken,
          tone,
          firstMessage,
          ...(language ? { language } : {}),
        });
        return;
      }
      logger.error({ data }, "ElevenLabs get-signed-url returned 200 without signed_url");
      res.json({
        available: false,
        reason: "signed_url_failed",
        detail: "Unexpected ElevenLabs response (no signed_url)",
      });
      return;
    }

    // Classify the failure so the client can show a SPECIFIC, actionable error.
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      /* non-JSON error body */
    }
    const detail = (body as { detail?: { message?: string; status?: string } | string } | null)
      ?.detail;
    const elMessage =
      typeof detail === "object" && typeof detail?.message === "string"
        ? detail.message
        : typeof detail === "string"
          ? detail
          : `ElevenLabs returned HTTP ${r.status}`;

    logger.error(
      { status: r.status, body },
      "ElevenLabs get-signed-url failed — voice call cannot start",
    );

    let reason = "signed_url_failed";
    if (r.status === 401 || r.status === 403) {
      reason =
        typeof detail === "object" && detail?.status === "missing_permissions"
          ? "api_key_permission"
          : "api_key_invalid";
    } else if (r.status === 404) {
      reason = "agent_not_found";
    }
    // Voice-minute quota exhaustion must never render as a raw config error —
    // the client shows a warm in-character note and returns to text chat.
    if (
      (typeof detail === "object" && detail?.status === "quota_exceeded") ||
      /quota/i.test(elMessage)
    ) {
      reason = "quota_exceeded";
    }
    res.json({ available: false, reason, detail: elMessage });
  } catch (err) {
    logger.error({ err }, "ElevenLabs get-signed-url unreachable — voice call cannot start");
    res.json({
      available: false,
      reason: "elevenlabs_unreachable",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// ─── Browser-side failure reporting ──────────────────────────────────────────
// WebSocket close reasons and SDK errors happen browser↔ElevenLabs and never
// transit our server, so the client posts them here. This is what makes a
// remote tester's "it just dropped" diagnosable from the server logs.
// ─── Crisis floor (voice) — on-call helpline overlay ─────────────────────────
// The realtime voice reply is spoken by ElevenLabs, so no field can ride along
// with it to the browser. Instead the voice-llm callback writes a crisis_events
// row and the call UI polls THIS endpoint (session-authed) every few seconds
// during an active call. An undismissed voice event in the recent window means
// "show the helpline card on-screen now".

router.get("/voice-agent/crisis-status", async (req, res): Promise<void> => {
  const userId = req.userId;
  const event = await pendingVoiceCrisisEvent(userId);
  if (!event) {
    res.json({ active: false });
    return;
  }
  const profile = await getOrCreateProfileForUser(userId);
  const resolved = resolveHelplines(profile.country);
  const language = (profile as { preferredLanguage?: string }).preferredLanguage ?? "en";
  res.json({
    active: true,
    event: {
      id: event.id,
      countryServed: resolved.countryServed,
      lines: resolved.lines,
      blockText: buildHelplineBlockText(resolved.lines, language),
    },
  });
});

// Dismiss one on-call helpline overlay (per-event — a later crisis turn shows
// a fresh card). Same review-flag rules as the chat card.
router.post("/voice-agent/crisis-events/:id/dismiss", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const result = await dismissVoiceCrisisEvent(userId, id);
  if (!result) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true, reviewFlagged: result.reviewFlagged });
});

router.post("/voice-agent/client-error", (req, res): void => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const clip = (v: unknown, max: number) =>
    typeof v === "string" ? v.slice(0, max) : undefined;
  const stage = clip(b.stage, 100) ?? "unknown";
  const message = clip(b.message, 1000) ?? "";
  const detail = clip(b.detail, 2000);
  logger.error({ userId: req.userId, stage, message, detail }, "voice-call failed in browser");
  res.status(204).end();
});

// ─── Browser-side connect-timing beacon ──────────────────────────────────────
// One fire-and-forget POST per call attempt, recording how long the connect
// path took and which override level finally connected. This makes the retry
// cascade VISIBLE: every failed level is a full paid reconnection, so if
// "full" keeps failing the fix is a dashboard toggle (enable the TTS +
// first-message overrides in the agent's Security settings), not code — the
// warn line below says exactly that. grep: "voice-connect timing".
router.post("/voice-agent/client-timing", (req, res): void => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : undefined;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

  const timing = {
    userId: req.userId,
    /** "prefetched" | "fresh" — where the /session result came from. */
    sessionSource: str(b.sessionSource, 20) ?? "unknown",
    sessionFetchMs: num(b.sessionFetchMs),
    /** Per-level attempt results from startRealtimeCall's cascade. */
    attempts: Array.isArray(b.attempts)
      ? b.attempts.slice(0, 5).map((a) => {
          const at = (a ?? {}) as Record<string, unknown>;
          return {
            level: str(at.level, 10) ?? "unknown",
            ok: at.ok === true,
            ms: num(at.ms),
            message: str(at.message, 300),
          };
        })
      : [],
    /** Level that finally connected ("full" | "voice" | "none"). */
    connectedLevel: str(b.connectedLevel, 10),
    /** Button press → connection established. */
    connectMs: num(b.connectMs),
    /** Button press → first agent audio actually accepted for playback. */
    firstAudioMs: num(b.firstAudioMs),
  };

  const fullFailed = timing.attempts.some((a) => a.level === "full" && !a.ok);
  if (fullFailed && timing.connectedLevel && timing.connectedLevel !== "full") {
    logger.warn(
      timing,
      "voice-connect timing: 'full' override attempt failed and a lower level connected — " +
        "the agent's override flags (TTS voice/stability/speed + first message) are likely " +
        "DISABLED in the ElevenLabs dashboard Security settings. Enable them there; every " +
        "call is currently paying a full reconnect retry (and losing the instant greeting).",
    );
  } else {
    logger.info(timing, "voice-connect timing");
  }
  res.status(204).end();
});

export default router;
