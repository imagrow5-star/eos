import { Router, type IRouter } from "express";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { getOrCreateProfileForUser } from "./profile.js";
import { isVoiceCallEnabled } from "../lib/featureFlags.js";
import { logger } from "../lib/logger.js";

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

router.post("/voice-agent/session", async (req, res): Promise<void> => {
  if (!isVoiceCallEnabled()) {
    res.json({ available: false, reason: "disabled" });
    return;
  }

  const agentId = process.env.ELEVENLABS_AGENT_ID?.trim();
  if (!agentId) {
    res.json({ available: false, reason: "not_configured" });
    return;
  }

  const userToken = mintVoiceToken(req.userId);

  // "How Eos speaks" preference rides along so the client can set matching
  // TTS delivery overrides (stability/speed) on the ElevenLabs session.
  let tone = "auto";
  try {
    const profile = await getOrCreateProfileForUser(req.userId);
    tone = (profile as { voiceTone?: string }).voiceTone ?? "auto";
  } catch (err) {
    logger.warn({ err }, "voice-agent: couldn't load tone preference — using auto");
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    // No API key to sign with — only a PUBLIC agent can possibly work. Let the
    // browser try; if the agent is private the client will surface the drop.
    logger.warn("ELEVENLABS_API_KEY not set — attempting public-agent voice call");
    res.json({ available: true, mode: "public", agentId, userToken, tone });
    return;
  }

  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(8000) },
    );

    if (r.ok) {
      const data = (await r.json()) as { signed_url?: string };
      if (data?.signed_url) {
        res.json({ available: true, mode: "signed", signedUrl: data.signed_url, userToken, tone });
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

export default router;
