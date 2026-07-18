import { Router, type IRouter } from "express";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { isVoiceCallEnabled } from "../lib/featureFlags.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── Voice-agent session bootstrap (session-authenticated) ───────────────────
// Called by the web client when the user starts a voice call. Returns what the
// browser needs to open an ElevenLabs Conversational AI session:
//   - a per-user HMAC token the agent passes back to our custom-LLM endpoint
//     (see voice-llm.ts) so the right person's memory is loaded
//   - a signed WebSocket URL (private agents), or the raw agent id (public)
// If ELEVENLABS_AGENT_ID isn't configured, reports that clearly so the client
// falls back to the standard browser voice mode instead of failing silently.

router.post("/voice-agent/session", async (req, res): Promise<void> => {
  // Feature flag: while the realtime Voice Call entry point is hidden in the UI
  // (VOICE_CALL_ENABLED unset/false), also refuse to bootstrap a session here so
  // the feature is truly off end-to-end. The client treats this like any other
  // "unavailable" response and stays on the standard experience.
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

  // Prefer a signed URL — works for private agents and never exposes the API key.
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (apiKey) {
    try {
      const r = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
        { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(8000) },
      );
      if (r.ok) {
        const data = (await r.json()) as { signed_url?: string };
        if (data?.signed_url) {
          res.json({ available: true, mode: "signed", signedUrl: data.signed_url, userToken });
          return;
        }
      }
      logger.warn(
        { status: r.status },
        "ElevenLabs get-signed-url failed — trying public agent mode",
      );
    } catch (err) {
      logger.warn({ err }, "ElevenLabs get-signed-url error — trying public agent mode");
    }
  }

  // Public agents can connect with just the agent id; if this also fails in the
  // browser, the client falls back to standard voice mode with a visible note.
  res.json({ available: true, mode: "public", agentId, userToken });
});

export default router;
