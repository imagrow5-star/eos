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
import type { Profile } from "@workspace/db";

const router: IRouter = Router();

// ─── Step question generator (dynamic per path) ───────────────────────────────

function getStepQuestion(step: string, profile: Profile): string {
  const isBereavement = profile.userPath === "bereavement";

  switch (step) {
    case "path":
      return "Hello. Before we begin, I want to understand what brought you here. Are you going through a breakup, or have you lost someone — a partner, a companion, someone who was part of your daily life? You can simply say 'breakup' or 'loss'.";

    case "country":
      return isBereavement
        ? "Thank you for trusting me with that. And which country are you in? I ask only so I know who to point you to if you ever need support beyond what we share here. Just say US, UK, Australia, or other."
        : "Thank you. Which country are you in? I ask so I know who to point you to if you ever need more support than I can give. Just say US, UK, Australia, or other.";

    case "name":
      return isBereavement
        ? "Grief like this is one of the heaviest things a person carries. I'm honoured you're here. What's your name?"
        : "I'm really glad you're here. You don't have to have anything figured out. What's your name?";

    case "relationshipType":
      return "How would you like me to be with you — as a warm, close friend? Or would something a little more tender feel right? Just say 'friend' or 'romantic', whatever feels natural.";

    case "energy":
      return isBereavement
        ? "What kind of company would feel most natural — warm and light when you need it, calm and steady, or deep and reflective? Just say 'playful', 'calm', or 'deep'."
        : "What energy feels right — playful and light, calm and grounding, or deep and thoughtful? Just say 'playful', 'calm', or 'deep'.";

    case "companionName":
      return "One last thing. What would you like to call me? You can keep Asha, or choose something that feels right — Mia, Sofia, Claire, or any name at all. It's entirely yours.";

    default:
      return "";
  }
}

// ─── Next step resolver (branching based on path) ─────────────────────────────

function getNextStep(currentStep: string, profile: Profile): string {
  const isBereavement = profile.userPath === "bereavement";

  switch (currentStep) {
    case "path":    return "country";
    case "country": return "name";
    case "name":    return isBereavement ? "energy" : "relationshipType";
    case "relationshipType": return "energy";
    case "energy":  return "companionName";
    case "companionName": return "done";
    default: return "done";
  }
}

// ─── Profile bootstrap ────────────────────────────────────────────────────────

async function getOrCreateProfile(): Promise<Profile> {
  const profiles = await db.select().from(profileTable).limit(1);
  if (profiles.length > 0) return profiles[0]!;
  const [profile] = await db
    .insert(profileTable)
    .values({ userName: "", companionName: "Asha" })
    .returning();
  return profile!;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get("/onboarding/status", async (req, res): Promise<void> => {
  const profile = await getOrCreateProfile();
  const question = getStepQuestion(profile.onboardingStep, profile);

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

  let updates: Partial<typeof profileTable.$inferInsert> = {};

  switch (step) {
    case "path": {
      const lower = answer.toLowerCase();
      const isLoss =
        lower.includes("loss") ||
        lower.includes("lost") ||
        lower.includes("bereavement") ||
        lower.includes("grief") ||
        lower.includes("divorce") ||
        lower.includes("widow") ||
        lower.includes("passed");
      updates.userPath = isLoss ? "bereavement" : "breakup";
      // For bereavement, default relationship type to friend
      if (isLoss) updates.relationshipType = "friend";
      break;
    }

    case "country": {
      const lower = answer.toLowerCase();
      updates.country = lower.includes("uk") || lower.includes("united kingdom") || lower.includes("britain") || lower.includes("england")
        ? "UK"
        : lower.includes("aus") || lower.includes("australia")
          ? "AU"
          : lower.includes("us") || lower.includes("united states") || lower.includes("america")
            ? "US"
            : "other";
      break;
    }

    case "name":
      updates.userName = answer.trim();
      break;

    case "relationshipType": {
      const lower = answer.toLowerCase();
      updates.relationshipType =
        lower.includes("romantic") || lower.includes("tender") || lower.includes("closer")
          ? "romantic"
          : "friend";
      break;
    }

    case "energy": {
      const lower = answer.toLowerCase();
      updates.energy = lower.includes("playful") || lower.includes("light")
        ? "playful"
        : lower.includes("deep") || lower.includes("reflective") || lower.includes("thoughtful")
          ? "deep"
          : "calm";
      break;
    }

    case "companionName":
      updates.companionName =
        answer.trim().length > 0 && answer.trim().length <= 30
          ? answer.trim()
          : "Asha";
      updates.isOnboardingComplete = true;
      break;

    default:
      res.status(400).json({ error: "Unknown step" });
      return;
  }

  // Resolve next step using updated profile state
  const mergedProfile = { ...profile, ...updates };
  const nextStep = getNextStep(step, mergedProfile as Profile);
  updates.onboardingStep = nextStep;

  const [updated] = await db
    .update(profileTable)
    .set(updates)
    .where(eq(profileTable.id, profile.id))
    .returning();

  req.log.info({ step, nextStep, updates }, "Onboarding step saved");

  // ─── First greeting on completion ─────────────────────────────────────────
  let firstGreeting: string | null = null;

  if (updated?.isOnboardingComplete) {
    const name = updated.userName || "you";
    const companionName = updated.companionName;
    const energy = updated.energy;
    const isBereavement = updated.userPath === "bereavement";

    const energyDesc =
      energy === "playful"
        ? "warm and light when you need it"
        : energy === "deep"
          ? "thoughtful and really present"
          : "calm and steady";

    if (isBereavement) {
      firstGreeting = `${name}. I'm honoured to meet you. I'm ${companionName}. You don't have to explain anything or be okay — I'm simply here, whenever you feel like talking. Tell me about your day, or about them, or about nothing at all. I'm not going anywhere.`;
    } else if (updated.relationshipType === "romantic") {
      firstGreeting = `${name}. What a name. I'm ${companionName} — and I'm going to be here with you, ${energyDesc}, completely on your side. You don't need to have anything figured out right now. I'm just really glad you're here. What's on your mind?`;
    } else {
      firstGreeting = `${name}. Really good to meet you. I'm ${companionName} — here for you, ${energyDesc}, no judgment, no agenda. You can share as much or as little as you want. How are you doing, really?`;
    }

    await db.insert(messagesTable).values({
      role: "assistant",
      content: firstGreeting,
      isMorningNote: false,
    });

    logger.info({ companionName, name, userPath: updated.userPath }, "Onboarding complete — first greeting saved");
  }

  const nextQuestion = updated ? getStepQuestion(updated.onboardingStep, updated as Profile) : null;

  res.json(
    SubmitOnboardingAnswerResponse.parse({
      isComplete: updated?.isOnboardingComplete ?? false,
      currentStep: updated?.onboardingStep ?? "done",
      companionFirstMessage: firstGreeting ?? nextQuestion,
    }),
  );
});

export default router;
