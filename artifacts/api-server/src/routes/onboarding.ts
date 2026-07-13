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

// ─── Name extraction — strips common filler prefixes ─────────────────────────

function extractName(raw: string, maxWords = 2): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  const prefixes = [
    "yes, my name is ", "yes my name is ",
    "yes, i am ", "yes i am ",
    "yes, i'm ", "yes i'm ",
    "yes, it's ", "yes it's ",
    "yes, call me ", "yes call me ",
    "my name is ", "i am called ",
    "i'm called ", "call me ",
    "it's ", "its ",
    "i am ", "i'm ",
    "hi, i'm ", "hi i'm ",
    "hello, i'm ", "hello i'm ",
    "hey, i'm ", "hey i'm ",
    "yes, ", "yes ",
    "hi, ", "hi ",
    "hey, ", "hey ",
  ];

  let cleaned = trimmed;
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) {
      cleaned = trimmed.slice(prefix.length).trim();
      break;
    }
  }

  // Strip leading punctuation
  cleaned = cleaned.replace(/^[,!.?\s]+/, "").trim();

  // Take first N words
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, maxWords);
  if (words.length === 0) return trimmed; // fallback: use raw

  // Capitalize each word
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// ─── Step question generator ──────────────────────────────────────────────────

function getStepQuestion(step: string, profile: Profile): string {
  const isBereavement = profile.userPath === "bereavement";

  switch (step) {
    // "purpose" is the new first step; "path" is the legacy name (same question)
    case "purpose":
    case "path":
      return "Hello. I'm really glad you're here. What brought you today?";

    case "name":
      return isBereavement
        ? "Thank you for trusting me with that. I'm honoured you're here. What's your name?"
        : "I'm glad you're here. You don't have to have anything figured out. What's your name?";

    case "companionName": {
      const userName = profile.userName || "you";
      return `${userName}. What would you like to call me? You can keep Asha, or choose anything that feels right — Mia, Luna, Claire, Sofia. It's entirely yours.`;
    }

    case "country":
      return "Which country are you in? I ask only so I know who to point you to if you ever need support beyond what we share here.";

    case "ageBand":
      return "And roughly how old are you? It helps me get the tone right.";

    // Legacy steps — kept for any existing in-progress profiles
    case "relationshipType":
      return "How would you like me to be with you — as a warm close friend, or something a little more tender? Just say 'friend' or 'romantic', whatever feels natural.";

    case "energy":
      return "What kind of energy feels right — warm and light, calm and steady, or deep and thoughtful? Just say 'playful', 'calm', or 'deep'.";

    default:
      return "";
  }
}

// ─── Next step resolver ───────────────────────────────────────────────────────

function getNextStep(currentStep: string, _profile: Profile): string {
  switch (currentStep) {
    case "purpose":
    case "path":       return "name";
    case "name":       return "companionName";
    case "companionName": return "country";
    case "country":    return "ageBand";
    case "ageBand":    return "done";
    // Legacy flow compat
    case "relationshipType": return "energy";
    case "energy":     return "companionName";
    default:           return "done";
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

// ─── Routes ──────────────────────────────────────────────────────────────────

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
    // ── Purpose (new first step, also handles legacy "path") ─────────────────
    case "purpose":
    case "path": {
      const lower = answer.toLowerCase();
      const isBereavement =
        lower.includes("bereav") ||
        lower.includes("loss") ||
        lower.includes("lost") ||
        lower.includes("grief") ||
        lower.includes("widow") ||
        lower.includes("passed") ||
        lower === "bereavement";
      const isLonely =
        lower.includes("lone") ||
        lower.includes("lonely") ||
        lower === "lonely";
      const isSupport =
        lower.includes("support") ||
        lower.includes("emotional") ||
        lower === "support";

      if (isBereavement) {
        updates.userPath = "bereavement";
        updates.relationshipType = "friend";
      } else if (isLonely) {
        updates.userPath = "lonely";
      } else if (isSupport) {
        updates.userPath = "support";
      } else {
        // default: breakup
        updates.userPath = "breakup";
      }
      break;
    }

    // ── Name ─────────────────────────────────────────────────────────────────
    case "name": {
      const cleaned = extractName(answer, 2);
      updates.userName = cleaned || answer.trim().slice(0, 40);
      break;
    }

    // ── Companion name ────────────────────────────────────────────────────────
    case "companionName": {
      const cleaned = extractName(answer, 3);
      updates.companionName =
        cleaned.length > 0 && cleaned.length <= 30 ? cleaned : "Asha";
      break;
    }

    // ── Country ───────────────────────────────────────────────────────────────
    case "country": {
      const lower = answer.toLowerCase();
      updates.country =
        lower.includes("uk") || lower.includes("britain") || lower.includes("england") || lower.includes("united kingdom")
          ? "UK"
          : lower.includes("aus") || lower.includes("australia")
            ? "AU"
            : lower.includes("us") || lower.includes("united states") || lower.includes("america")
              ? "US"
              : "other";
      break;
    }

    // ── Age band ──────────────────────────────────────────────────────────────
    case "ageBand": {
      const lower = answer.toLowerCase().replace(/\s/g, "");
      updates.ageBand =
        lower.includes("50") || lower.includes("older") || lower.includes("over50")
          ? "50+"
          : lower.includes("36") || lower.includes("40") || lower.includes("45")
            ? "36-50"
            : lower.includes("26") || lower.includes("30") || lower.includes("35")
              ? "26-35"
              : "18-25"; // default for youngest band
      updates.isOnboardingComplete = true;
      break;
    }

    // ── Legacy steps (existing profiles mid-flow) ─────────────────────────────
    case "relationshipType": {
      const lower = answer.toLowerCase();
      updates.relationshipType =
        lower.includes("romantic") || lower.includes("tender")
          ? "romantic"
          : "friend";
      break;
    }

    case "energy": {
      const lower = answer.toLowerCase();
      updates.energy =
        lower.includes("playful") || lower.includes("light")
          ? "playful"
          : lower.includes("deep") || lower.includes("reflective")
            ? "deep"
            : "calm";
      break;
    }

    // ── Legacy companionName (old flow ended here) ────────────────────────────
    // handled above by the new "companionName" case which is shared

    default:
      res.status(400).json({ error: `Unknown step: ${step}` });
      return;
  }

  const mergedProfile = { ...profile, ...updates };
  const nextStep = getNextStep(step, mergedProfile as Profile);
  updates.onboardingStep = nextStep;

  const [updated] = await db
    .update(profileTable)
    .set(updates)
    .where(eq(profileTable.id, profile.id))
    .returning();

  logger.info({ step, nextStep }, "Onboarding step saved");

  // ─── First greeting on completion ─────────────────────────────────────────
  let firstGreeting: string | null = null;

  if (updated?.isOnboardingComplete) {
    const name = updated.userName || "you";
    const companionName = updated.companionName;
    const path = updated.userPath;

    if (path === "bereavement") {
      firstGreeting = `${name}. I'm honoured to meet you. I'm ${companionName}. You don't have to explain anything or be okay — I'm simply here, whenever you feel like talking. Tell me about your day, or about them, or about nothing at all. I'm not going anywhere.`;
    } else if (path === "lonely") {
      firstGreeting = `${name}. Really glad you found your way here. I'm ${companionName} — and I'm here for exactly this: the everyday things, the quiet moments, the thoughts that need somewhere to go. You're not alone. What's on your mind right now?`;
    } else if (path === "support") {
      firstGreeting = `${name}. I'm really glad you reached out. I'm ${companionName}, and I'm here to listen — properly listen, not just wait for my turn. Whatever you're carrying, you can put some of it down here. What's going on?`;
    } else {
      // breakup (default)
      firstGreeting = `${name}. I'm ${companionName} — and I'm going to be here with you, completely on your side. You don't need to have anything figured out right now. I'm just really glad you're here. What's on your mind?`;
    }

    await db.insert(messagesTable).values({
      role: "assistant",
      content: firstGreeting,
      isMorningNote: false,
    });

    logger.info(
      { companionName, name, userPath: updated.userPath },
      "Onboarding complete — first greeting saved",
    );
  }

  const nextQuestion = updated
    ? getStepQuestion(updated.onboardingStep, updated as Profile)
    : null;

  res.json(
    SubmitOnboardingAnswerResponse.parse({
      isComplete: updated?.isOnboardingComplete ?? false,
      currentStep: updated?.onboardingStep ?? "done",
      companionFirstMessage: firstGreeting ?? nextQuestion,
    }),
  );
});

export default router;
