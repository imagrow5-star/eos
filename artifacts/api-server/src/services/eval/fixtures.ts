/**
 * Fixtures for the evaluation endpoint (routes/eval.ts): the caller's
 * description of a person, turned into the row shapes the real prompt
 * builder ranks and formats. Pure functions, no database.
 *
 * The point of the endpoint is memory. A harness cannot test recall against
 * an empty account, so it hands over the facts and feelings Eos is supposed
 * to know, and they go through the same importance ranking, the same top-40
 * cut and the same formatting as rows read from the database. Nothing here
 * is written anywhere.
 */
import type { Profile } from "@workspace/db";
import { z } from "zod/v4";
import type { MemoryOverride } from "../systemPrompt.js";

/** A user id no row can have; distinct from the demo's -1 so the two are tellable apart in logs. */
export const EVAL_USER_ID = -2;

const DAY_MS = 86_400_000;
export const EVAL_FACTS_MAX = 200;
export const EVAL_FEELINGS_MAX = 50;
export const EVAL_HISTORY_MAX_TURNS = 40;

export const EvalFact = z.object({
  text: z.string().trim().min(1).max(300),
  category: z.enum(["life", "preference", "event", "person", "goal"]).default("life"),
  /** How long ago Eos learned this. Drives the recency part of the ranking. */
  daysAgo: z.number().int().min(0).max(3650).default(0),
  /** How often it has come up since. Drives the reference part of the ranking. */
  timesReferenced: z.number().int().min(1).max(100).default(1),
  /** 0–1 emotional charge. */
  emotionalWeight: z.number().min(0).max(1).default(0),
  /** The person said "remember this": trumps every other factor. */
  important: z.boolean().default(false),
});

export const EvalFeeling = z.object({
  text: z.string().trim().min(1).max(300),
  emotion: z.string().trim().min(1).max(40).default("other"),
  daysAgo: z.number().int().min(0).max(3650).default(0),
  emotionalWeight: z.number().min(0).max(1).default(0.5),
});

export const EvalProfile = z.object({
  name: z.string().trim().max(60).default(""),
  companionName: z.string().trim().min(1).max(40).default("Eos"),
  path: z.enum(["support", "breakup", "bereavement", "lonely"]).default("support"),
  energy: z.enum(["calm", "playful", "deep"]).default("calm"),
  country: z.enum(["US", "UK", "AU", "other", ""]).default(""),
  ageBand: z.enum(["18-25", "26-35", "36-50", "50+", ""]).default(""),
  timezone: z.string().trim().min(1).max(64).default("UTC"),
  language: z.string().trim().min(2).max(8).default("en"),
  /** Days since the person joined. Sets the profile's creation date and, unless `stage` is given, the stage. */
  daysSinceJoined: z.number().int().min(0).max(3650).default(0),
  /** 1 Arrival · 2 Settling · 3 Working · 4 Established. Omit to derive it from days and facts. */
  stage: z.number().int().min(1).max(4).optional(),
});

export type EvalFactInput = z.infer<typeof EvalFact>;
export type EvalFeelingInput = z.infer<typeof EvalFeeling>;
export type EvalProfileInput = z.infer<typeof EvalProfile>;

/**
 * The stage the app would compute for this person, with no habits, moods or
 * visit dates on record: 14+ days is Working; 3+ days with 8+ facts is
 * Settling; else Arrival. An explicit `stage` wins.
 */
export function evalStage(profile: EvalProfileInput, factCount: number): number {
  if (profile.stage) return profile.stage;
  if (profile.daysSinceJoined >= 14) return 3;
  if (profile.daysSinceJoined >= 3 && factCount >= 8) return 2;
  return 1;
}

export function evalProfile(input: EvalProfileInput, now = new Date()): Profile {
  const createdAt = new Date(now.getTime() - input.daysSinceJoined * DAY_MS);
  return {
    id: 0,
    userId: EVAL_USER_ID,
    userName: input.name,
    originalUserName: null,
    companionName: input.companionName,
    relationshipType: "friend",
    energy: input.energy,
    userPath: input.path,
    country: input.country,
    ageBand: input.ageBand,
    birthYear: null,
    onboardingStep: "done",
    isOnboardingComplete: true,
    createdAt,
    morningNoteDate: null,
    visitDates: [],
    changeTalkDetected: false,
    voiceId: "",
    voiceTone: "auto",
    preferredLanguage: input.language,
    voiceAccent: "us",
    voiceGender: null,
    humeVoiceId: null,
    companionGender: "woman",
    userGender: null,
    userGenderCustom: null,
    timezone: input.timezone,
    theme: null,
    themeMode: null,
    dailyEmailOptOut: true,
    pushOptIn: false,
    lastEmailDate: null,
    lastGreetingAt: null,
    consentVersion: null,
    consentAt: null,
    dataSharingOptIn: false,
  } satisfies Profile;
}

export function evalMemory(
  facts: EvalFactInput[],
  feelings: EvalFeelingInput[],
  now = new Date(),
): MemoryOverride {
  return {
    facts: facts.map((f, i) => {
      const createdAt = new Date(now.getTime() - f.daysAgo * DAY_MS);
      return {
        id: i + 1,
        userId: EVAL_USER_ID,
        fact: f.text,
        category: f.category,
        createdAt,
        timesReferenced: f.timesReferenced,
        lastReferencedAt: createdAt,
        emotionalWeight: f.emotionalWeight,
        userMarkedImportant: f.important,
        lastSurfacedAt: null,
        previousFact: null,
        updatedAt: null,
        retiredAt: null,
      };
    }),
    feelings: feelings.map((f, i) => {
      const createdAt = new Date(now.getTime() - f.daysAgo * DAY_MS);
      return {
        id: i + 1,
        userId: EVAL_USER_ID,
        feeling: f.text,
        category: f.emotion,
        createdAt,
        timesReferenced: 1,
        lastReferencedAt: createdAt,
        emotionalWeight: f.emotionalWeight,
        userMarkedImportant: false,
      };
    }),
  };
}
