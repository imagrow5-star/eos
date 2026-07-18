/**
 * voices.ts
 * GET /api/voices/status — returns current resolution status for romantic community voices.
 * The frontend uses this to know which romantic voices are available and what account voice_id to use.
 * It also surfaces the VOICE_CALL_ENABLED feature flag so the client can show or hide the
 * realtime Voice Call entry point without a frontend rebuild.
 */

import { Router, type IRouter } from "express";
import { getRomanticVoiceStatus } from "../services/voiceLibrary.js";
import { isVoiceCallEnabled } from "../lib/featureFlags.js";

const router: IRouter = Router();

router.get("/voices/status", (_req, res): void => {
  res.json({ romantic: getRomanticVoiceStatus(), voiceCallEnabled: isVoiceCallEnabled() });
});

export default router;
