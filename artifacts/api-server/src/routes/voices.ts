/**
 * voices.ts
 * GET /api/voices/status — returns current resolution status for romantic community voices.
 * The frontend uses this to know which romantic voices are available and what account voice_id to use.
 */

import { Router, type IRouter } from "express";
import { getRomanticVoiceStatus } from "../services/voiceLibrary.js";

const router: IRouter = Router();

router.get("/voices/status", (_req, res): void => {
  res.json({ romantic: getRomanticVoiceStatus() });
});

export default router;
