import { Router, type IRouter } from "express";
import { requireAuth, requireVerified } from "../middleware/auth.js";
import { attachEntitlements } from "../middleware/entitlements.js";
import healthRouter from "./health";
import authRouter from "./auth";
import googleAuthRouter from "./googleAuth";
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
import chaptersRouter, { chaptersInternalRouter } from "./chapters";
import pushRouter, { pushInternalRouter } from "./push";
import billingRouter, { billingPublicRouter } from "./billing";
import billingWebhookRouter from "./billingWebhook";
import settingsRouter from "./settings";

const router: IRouter = Router();

// ─── Public routes — no authentication required ───────────────────────────────
router.use(healthRouter);
router.use(authRouter);
router.use(googleAuthRouter); // "Continue with Google" (additional sign-in option)
router.use(emailRouter);  // one-click unsubscribe — no auth
// ElevenLabs Conversational AI custom-LLM callback — called by ElevenLabs
// servers (no browser session); authenticated per-call via HMAC voice token.
router.use(voiceLlmRouter);
// Weekly-chapter sweep — called hourly by the daily-email scheduled job;
// authenticated per-call via HMAC internal token (no browser session).
router.use(chaptersInternalRouter);
// Morning push-nudge sweep — same caller, same HMAC scheme.
router.use(pushInternalRouter);
// Paddle webhook — called by Paddle's servers; authenticated per-delivery by
// the Paddle-Signature HMAC over the raw body (raw-body mount in app.ts).
router.use(billingWebhookRouter);
// Checkout configuration (tier metadata + public price ids) — the /pricing
// page renders from this for signed-out visitors too.
router.use(billingPublicRouter);

// ─── Protected routes — valid session + verified email required ───────────────
// requireAuth sets req.userId; requireVerified checks emailVerifiedAt in the DB.
// attachEntitlements tags the request with the user's tier (phase 1: attach
// only — it NEVER blocks; users without a subscription get legacy full access).
router.use(requireAuth as any);
router.use(requireVerified as any);
router.use(attachEntitlements as any);
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
router.use(chaptersRouter);
router.use(pushRouter);
router.use(billingRouter); // /billing/me + /billing/cancel (own subscription only)
router.use(settingsRouter); // language + voice picker preferences (Sprint 1.5)

export default router;
