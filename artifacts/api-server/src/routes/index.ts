import { Router, type IRouter } from "express";
import healthRouter from "./health";
import onboardingRouter from "./onboarding";
import profileRouter from "./profile";
import chatRouter from "./chat";
import memoryRouter from "./memory";
import journeyRouter from "./journey";
import ttsRouter from "./tts";
import goalsRouter from "./goals";

const router: IRouter = Router();

router.use(healthRouter);
router.use(onboardingRouter);
router.use(profileRouter);
router.use(chatRouter);
router.use(memoryRouter);
router.use(journeyRouter);
router.use(ttsRouter);
router.use(goalsRouter);

export default router;
