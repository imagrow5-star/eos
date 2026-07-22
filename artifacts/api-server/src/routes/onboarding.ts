import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "@workspace/db";
import { profileTable, messagesTable } from "@workspace/db";
import {
  GetOnboardingStatusResponse,
  SubmitOnboardingAnswerBody,
  SubmitOnboardingAnswerResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger.js";
import type { Profile } from "@workspace/db";
import { getOrCreateProfileForUser } from "./profile.js";
import { sanitizeGenderWords } from "../services/systemPrompt.js";
import { parseAgeText, ageToBand, resolveCountryAnswer, AGE_BANDS, isValidCountryCode } from "../lib/basics.js";

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

  cleaned = cleaned.replace(/^[,!.?\s]+/, "").trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, maxWords);
  if (words.length === 0) return trimmed;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

// ─── Step question generator ──────────────────────────────────────────────────

function getStepQuestion(step: string, profile: Profile): string {
  const isBereavement = profile.userPath === "bereavement";

  switch (step) {
    case "purpose":
    case "path":
      return "Hello. I'm really glad you're here. What brought you today?";

    case "companionGender":
      return isBereavement
        ? "Before we go further — who would feel most natural to lean on? A woman, a man, or someone non-binary / no preference? There's no wrong answer."
        : "Before I introduce myself properly — would it feel more natural talking to a woman, a man, or someone non-binary? Just go with whatever feels right.";

    case "name":
      return isBereavement
        ? "Thank you for trusting me with that. I'm honoured you're here. What's your name?"
        : "I'm glad you're here. You don't have to have anything figured out. What's your name?";

    case "companionName": {
      const userName = profile.userName || "you";
      const gender = (profile as any).companionGender ?? "woman";
      const suggestions =
        gender === "man"
          ? "Alex, Ethan, Liam, Noah — or any name you like"
          : gender === "nonbinary"
            ? "River, Sky, Sam, Sage — or any name you like"
            : "Mia, Sofia, Luna, Aria — or any name you like";
      return `${userName}. What would you like to call me? You can keep Eos, or choose something that feels right — ${suggestions}. It's entirely yours.`;
    }

    case "country":
      return "And which country do you call home? I ask only so I know who to point you to if you ever need support beyond what we share here — completely fine to skip.";

    case "ageBand":
      return "A couple of small things so I can meet you where you are — how old are you? And which country do you call home? The country part is completely optional.";

    case "userGender":
      return "One last thing — completely optional, so skip it if you like. What's your gender? Tap one below, or just tell me in your own words.";

    case "relationshipType":
      return "How would you like me to be with you — as a warm close friend, or something a little more tender? Just say 'friend' or 'romantic'.";

    case "energy":
      return "What kind of energy feels right — warm and light, calm and steady, or deep and thoughtful?";

    default:
      return "";
  }
}

// ─── Next step resolver ───────────────────────────────────────────────────────

function getNextStep(currentStep: string, profile: Profile): string {
  switch (currentStep) {
    case "purpose":
    case "path":            return "companionGender";
    case "companionGender": return "name";
    case "name":            return "companionName";
    // Age comes before country so the 18+ gate runs before anything else
    // about them is stored.
    case "companionName":   return "ageBand";
    // Legacy sessions (old step order) may already have a country — don't ask twice.
    case "ageBand":         return isValidCountryCode(profile.country ?? "") ? "userGender" : "country";
    case "country":         return "userGender";
    case "userGender":      return "done";
    case "relationshipType": return "energy";
    case "energy":          return "companionName";
    default:                return "done";
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get("/onboarding/status", async (req, res): Promise<void> => {
  const profile = await getOrCreateProfileForUser(req.userId);
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
  const userId = req.userId;
  const parsed = SubmitOnboardingAnswerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { step, answer } = parsed.data;
  const profile = await getOrCreateProfileForUser(userId);

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

  // ── Adults-only gate integrity ──────────────────────────────────────────
  // Never trust the client's step ordering: every step at-or-beyond country
  // requires that the age question was genuinely answered first. Without
  // this, a crafted request could jump straight to userGender (which
  // completes onboarding) — and legacy sessions parked on the old step order
  // (country before age) could finish setup without ever seeing the age
  // question.
  const STEPS_REQUIRING_AGE = ["country", "userGender", "relationshipType", "energy"];
  const hasAgeEvidence =
    (profile as any).birthYear != null ||
    (AGE_BANDS as readonly string[]).includes((profile.ageBand ?? "").trim());
  if (STEPS_REQUIRING_AGE.includes(step) && !hasAgeEvidence) {
    // Nothing from this answer is stored — the age question comes first.
    await db
      .update(profileTable)
      .set({ onboardingStep: "ageBand" })
      .where(and(eq(profileTable.id, profile.id), eq(profileTable.userId, userId)));
    res.json(
      SubmitOnboardingAnswerResponse.parse({
        isComplete: false,
        currentStep: "ageBand",
        companionFirstMessage: getStepQuestion("ageBand", profile),
      }),
    );
    return;
  }

  let updates: Partial<typeof profileTable.$inferInsert> = {};

  switch (step) {
    case "purpose":
    case "path": {
      const lower = answer.toLowerCase();
      const isBereavement =
        lower.includes("bereav") || lower.includes("loss") || lower.includes("lost") ||
        lower.includes("grief") || lower.includes("widow") || lower.includes("passed") ||
        lower === "bereavement";
      const isLonely = lower.includes("lone") || lower.includes("lonely") || lower === "lonely";
      const isSupport = lower.includes("support") || lower.includes("emotional") || lower === "support";

      if (isBereavement) {
        updates.userPath = "bereavement";
        updates.relationshipType = "friend";
      } else if (isLonely) {
        updates.userPath = "lonely";
      } else if (isSupport) {
        updates.userPath = "support";
      } else {
        updates.userPath = "breakup";
      }
      break;
    }

    case "companionGender": {
      const lower = answer.toLowerCase().trim();
      if (lower === "man" || lower === "male" || lower.includes("he/him") || (lower.includes("man") && !lower.includes("woman"))) {
        updates.companionGender = "man";
        updates.voiceId = "pNInz6obpgDQGcFmaJgB";
      } else if (lower.includes("non") || lower.includes("neutral") || lower.includes("they") || lower === "nonbinary" || lower.includes("no preference")) {
        updates.companionGender = "nonbinary";
        updates.voiceId = "21m00Tcm4TlvDq8ikWAM";
      } else {
        updates.companionGender = "woman";
        updates.voiceId = "21m00Tcm4TlvDq8ikWAM";
      }
      break;
    }

    case "name": {
      const cleaned = extractName(answer, 2);
      updates.userName = cleaned || answer.trim().slice(0, 40);
      break;
    }

    case "companionName": {
      const cleaned = extractName(answer, 3);
      updates.companionName = cleaned.length > 0 && cleaned.length <= 30 ? cleaned : "Eos";
      break;
    }

    case "country": {
      // Picker sends an ISO code; typed text is resolved by name. Skips and
      // unresolvable answers store nothing — we never guess where someone lives.
      const resolved = resolveCountryAnswer(answer);
      if (resolved && resolved !== "skip") updates.country = resolved;
      break;
    }

    case "ageBand": {
      const parsed = parseAgeText(answer);
      if (parsed.kind === "under18") {
        // Adults only — kind, honest, nothing stored, and setup does not proceed.
        res.json(
          SubmitOnboardingAnswerResponse.parse({
            isComplete: false,
            currentStep: "ageBand",
            companionFirstMessage:
              "Thank you for telling me honestly — that matters to me. Eos is made for adults, eighteen and over, so I can't set things up for you right now. If that was a typo, just tell me your real age. And if things feel heavy at the moment, please reach out to someone you trust — you deserve real, present support.",
          }),
        );
        return;
      }
      if (parsed.kind === "invalid") {
        res.json(
          SubmitOnboardingAnswerResponse.parse({
            isComplete: false,
            currentStep: "ageBand",
            companionFirstMessage:
              "I didn't quite catch that — could you tell me your age as a number? Like 24 — or your birth year, if that's easier.",
          }),
        );
        return;
      }
      if (parsed.kind === "band") {
        // Legacy chip answers ("26-35") from sessions started before this change
        updates.ageBand = parsed.band;
      } else {
        updates.birthYear = parsed.birthYear;
        updates.ageBand = ageToBand(parsed.age);
      }
      break;
    }

    case "userGender": {
      const lower = answer.toLowerCase().trim();
      const isSkip = lower === "skip" || lower.includes("prefer not") || lower.includes("not to say") || lower.includes("rather not") || lower.includes("skip this");
      if (!isSkip) {
        // Order matters: "woman"/"female" contain "man"/"male".
        if (lower.includes("woman") || lower.includes("female")) {
          updates.userGender = "woman";
          updates.userGenderCustom = null;
        } else if (lower.includes("man") || lower.includes("male")) {
          updates.userGender = "man";
          updates.userGenderCustom = null;
        } else {
          // Their own words (e.g. "non-binary") — keep their language, but
          // sanitized (quotes/newlines stripped, capped) before it ever
          // reaches a prompt.
          const words = sanitizeGenderWords(answer);
          updates.userGender = "custom";
          updates.userGenderCustom = words === "" ? null : words;
        }
      }
      updates.isOnboardingComplete = true;
      break;
    }

    case "relationshipType": {
      const lower = answer.toLowerCase();
      updates.relationshipType = lower.includes("romantic") || lower.includes("tender") ? "romantic" : "friend";
      break;
    }

    case "energy": {
      const lower = answer.toLowerCase();
      updates.energy =
        lower.includes("playful") || lower.includes("light") ? "playful"
        : lower.includes("deep") || lower.includes("reflective") ? "deep"
        : "calm";
      break;
    }

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
    .where(and(eq(profileTable.id, profile.id), eq(profileTable.userId, userId)))
    .returning();

  logger.info({ step, nextStep }, "Onboarding step saved");

  let firstGreeting: string | null = null;

  if (updated?.isOnboardingComplete) {
    const name = updated.userName || "";
    const companionName = updated.companionName;
    const path = updated.userPath;
    // Prefix name only when we actually know it — "you." is grammatically wrong
    const namePrefix = name ? `${name}. ` : "";

    if (path === "bereavement") {
      firstGreeting = `${namePrefix}I'm honoured to meet you. I'm ${companionName}. You don't have to explain anything or be okay — I'm simply here, whenever you feel like talking. Tell me about your day, or about them, or about nothing at all. I'm not going anywhere.`;
    } else if (path === "lonely") {
      firstGreeting = `${namePrefix}Really glad you found your way here. I'm ${companionName} — and I'm here for exactly this: the everyday things, the quiet moments, the thoughts that need somewhere to go. You're not alone. What's on your mind right now?`;
    } else if (path === "support") {
      firstGreeting = `${namePrefix}I'm really glad you reached out. I'm ${companionName}, and I'm here to listen — properly listen, not just wait for my turn. Whatever you're carrying, you can put some of it down here. What's going on?`;
    } else {
      firstGreeting = `${namePrefix}I'm ${companionName} — and I'm going to be here with you, completely on your side. You don't need to have anything figured out right now. I'm just really glad you're here. What's on your mind?`;
    }

    await db.insert(messagesTable).values({
      userId,
      role: "assistant",
      content: firstGreeting,
      isMorningNote: false,
    });

    // Privacy: companionName/name are user-supplied — log ids and path only.
    logger.info({ userId, userPath: updated.userPath }, "Onboarding complete — first greeting saved");
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
