import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { profileTable, messagesTable } from "@workspace/db";
import {
  GetOnboardingStatusResponse,
  SubmitOnboardingAnswerBody,
  SubmitOnboardingAnswerResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const ONBOARDING_STEPS = ["name", "relationshipType", "energy", "companionName", "done"] as const;
type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const STEP_QUESTIONS: Record<OnboardingStep, string> = {
  name: "Hey. I'm really glad you're here. I know things feel heavy right now — you don't have to explain anything yet. What's your name?",
  relationshipType:
    "It's good to meet you. I want to be here for you in whatever way feels most comfortable. Would you prefer me to be like a warm, close friend? Or would something a little more tender and romantic feel better? Just say 'friend' or 'romantic', whatever feels right.",
  energy:
    "Got it. And what kind of energy feels right for you — would you like me to be more playful and light, calm and grounding, or deep and thoughtful? You can just say 'playful', 'calm', or 'deep'.",
  companionName:
    "Last thing, I promise. What would you like to call me? You can keep the name I have, or give me a new one — it's your call.",
  done: "",
};

async function getOrCreateProfile() {
  const profiles = await db.select().from(profileTable).limit(1);
  if (profiles.length > 0) return profiles[0]!;
  const [profile] = await db
    .insert(profileTable)
    .values({ userName: "", companionName: "Aanya" })
    .returning();
  return profile!;
}

router.get("/onboarding/status", async (req, res): Promise<void> => {
  const profile = await getOrCreateProfile();
  const currentStep = profile.onboardingStep as OnboardingStep;
  const question = STEP_QUESTIONS[currentStep] ?? null;

  res.json(
    GetOnboardingStatusResponse.parse({
      isComplete: profile.isOnboardingComplete,
      currentStep: profile.onboardingStep,
      companionFirstMessage: question || null,
    }),
  );
});

router.post("/onboarding/answer", async (req, res): Promise<void> => {
  const parsed = SubmitOnboardingAnswerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { step, answer } = parsed.data;
  const profile = await getOrCreateProfile();

  if (profile.isOnboardingComplete) {
    res.json(
      SubmitOnboardingAnswerResponse.parse({
        isComplete: true,
        currentStep: "done",
        companionFirstMessage: null,
      }),
    );
    return;
  }

  // Apply answer to profile
  let updates: Partial<typeof profileTable.$inferInsert> = {};

  switch (step) {
    case "name":
      updates.userName = answer.trim();
      updates.onboardingStep = "relationshipType";
      break;
    case "relationshipType": {
      const lower = answer.toLowerCase();
      updates.relationshipType =
        lower.includes("romantic") || lower.includes("tender") || lower.includes("warm")
          ? "romantic"
          : "friend";
      updates.onboardingStep = "energy";
      break;
    }
    case "energy": {
      const lower = answer.toLowerCase();
      updates.energy = lower.includes("playful")
        ? "playful"
        : lower.includes("deep")
          ? "deep"
          : "calm";
      updates.onboardingStep = "companionName";
      break;
    }
    case "companionName":
      updates.companionName =
        answer.trim().length > 0 && answer.trim().length <= 30
          ? answer.trim()
          : "Aanya";
      updates.onboardingStep = "done";
      updates.isOnboardingComplete = true;
      break;
    default:
      res.status(400).json({ error: "Unknown step" });
      return;
  }

  const [updated] = await db
    .update(profileTable)
    .set(updates)
    .where(eq(profileTable.id, profile.id))
    .returning();

  req.log.info({ step, updates }, "Onboarding step saved");

  let firstGreeting: string | null = null;

  if (updated?.isOnboardingComplete) {
    // Generate first greeting and save as assistant message
    const name = updated.userName;
    const companionName = updated.companionName;
    const relType = updated.relationshipType;
    const energy = updated.energy;

    const energyDesc =
      energy === "playful"
        ? "warm and a little playful"
        : energy === "deep"
          ? "thoughtful and present"
          : "calm and steady";

    firstGreeting =
      relType === "romantic"
        ? `${name}. That's a beautiful name. I'm ${companionName}, and I'm going to be here for you — ${energyDesc}, and completely on your side. You don't have to have anything figured out right now. I'm just glad you're here. What's on your mind?`
        : `${name}. Really nice to meet you. I'm ${companionName} — and I'm here for you, ${energyDesc}, no judgment. You can share as much or as little as you want. I'm not going anywhere. How are you doing, really?`;

    await db.insert(messagesTable).values({
      role: "assistant",
      content: firstGreeting,
      isMorningNote: false,
    });

    logger.info({ companionName, name }, "Onboarding complete — first greeting saved");
  }

  const nextStep = updated?.onboardingStep as OnboardingStep;
  const nextQuestion = STEP_QUESTIONS[nextStep] ?? null;

  res.json(
    SubmitOnboardingAnswerResponse.parse({
      isComplete: updated?.isOnboardingComplete ?? false,
      currentStep: updated?.onboardingStep ?? "done",
      companionFirstMessage: firstGreeting ?? nextQuestion,
    }),
  );
});

export default router;
