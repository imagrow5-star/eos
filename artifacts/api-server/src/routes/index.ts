import { Router, type IRouter } from "express";
import { requireAuth, requireVerified } from "../middleware/auth.js";
import healthRouter from "./health";
import authRouter from "./auth";
import emailRouter from "./email";
import onboardingRouter from "./onboarding";
import profileRouter from "./profile";
import chatRouter from "./chat";
import memoryRouter from "./memory";
import journeyRouter from "./journey";
import ttsRouter from "./tts";
import voicesRouter from "./voices";
import goalsRouter from "./goals";
import commitmentsRouter from "./commitments";
import accountRouter from "./account";
import voiceLlmRouter from "./voice-llm";
import voiceAgentRouter from "./voice-agent";

const router: IRouter = Router();

// ─── Public routes — no authentication required ───────────────────────────────
router.use(healthRouter);
router.use(authRouter);
router.use(emailRouter);  // one-click unsubscribe — no auth
// ElevenLabs Conversational AI custom-LLM callback — called by ElevenLabs
// servers (no browser session); authenticated per-call via HMAC voice token.
router.use(voiceLlmRouter);

// ─── Protected routes — valid session + verified email required ───────────────
// requireAuth sets req.userId; requireVerified checks emailVerifiedAt in the DB.
router.use(requireAuth as any);
router.use(requireVerified as any);
router.use(onboardingRouter);
router.use(profileRouter);
router.use(chatRouter);
router.use(memoryRouter);
router.use(journeyRouter);
router.use(ttsRouter);
router.use(voicesRouter);
router.use(goalsRouter);
router.use(commitmentsRouter);
router.use(accountRouter);
router.use(voiceAgentRouter);

export default router;
