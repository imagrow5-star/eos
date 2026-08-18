/**
 * Instant voice-call opening lines.
 *
 * CURRENTLY UNUSED ON CALLS — kept, not deleted. These lines were spoken via
 * the client-side `overrides.agent.firstMessage` conversation override, but
 * ElevenLabs rejects that override with a 1008 disconnect since ~July 29
 * (runtime override permission tightened on their side; our subscription
 * tier has no dashboard toggle to re-allow it). The session route still
 * returns the line; the client no longer forwards it to ElevenLabs, and the
 * greeting comes from the custom LLM's synthetic-greeting path instead
 * (routes/voice-llm.ts).
 * TODO(cleanup): remove this module + the session-response plumbing if the
 * LLM greeting becomes the permanent path (or rewire these lines into it).
 *
 * Hard rules for every line:
 *  - warm, brief, under 12 words;
 *  - NEVER claims memory of specifics ("about what you said yesterday…") —
 *    a canned line must never be able to contradict her real memory;
 *  - varied (small pools, random pick, time-of-day aware) so back-to-back
 *    calls don't open identically.
 *
 * Kept as pure functions (clock + rng injectable) so tests can pin every
 * pool entry and slot selection.
 */

import type { Profile } from "@workspace/db";
import { getTimeContext } from "./stage.js";

// Each entry renders with and without a known first name. `name` is already
// trimmed and non-empty when provided.
type GreetingTemplate = (name: string | null) => string;

const MORNING_POOL: GreetingTemplate[] = [
  (n) => (n ? `Morning, ${n}. I'm here. How are you?` : "Morning. I'm here. How are you?"),
  (n) =>
    n
      ? `Good morning, ${n}. It's really good to hear you.`
      : "Good morning. It's really good to hear you.",
  (n) => (n ? `Hey, ${n}. I'm right here. How's your morning?` : "Hey. I'm right here. How's your morning?"),
];

const EVENING_POOL: GreetingTemplate[] = [
  (n) => (n ? `Evening, ${n}. I'm here. How was today?` : "Evening. I'm here. How was today?"),
  (n) => (n ? `Hey, ${n}. It's good to hear you. How's tonight?` : "Hey, it's me. How's your evening going?"),
  (n) => (n ? `Hi, ${n}. I'm listening. How are you tonight?` : "Hi. I'm listening. How are you tonight?"),
];

const ANYTIME_POOL: GreetingTemplate[] = [
  (n) => (n ? `Hey, ${n}. It's me. I'm right here.` : "Hey, it's me. I'm right here."),
  (n) => (n ? `Hi, ${n}. I'm glad you called. How are you?` : "Hi. I'm glad you called. How are you?"),
  (n) => (n ? `I'm here, ${n}. Take your time. I'm listening.` : "I'm here. Take your time. I'm listening."),
  (n) => (n ? `Hey, ${n}. Good to hear your voice. What's going on?` : "Hey. Good to hear your voice. What's going on?"),
];

/** Exported for tests — every pool entry must obey the hard rules above. */
export const GREETING_POOLS = {
  morning: MORNING_POOL,
  evening: EVENING_POOL,
  anytime: ANYTIME_POOL,
} as const;

export type GreetingSlot = keyof typeof GREETING_POOLS;

/** Morning = early morning/morning; evening = evening/night; else anytime. */
export function greetingSlotFor(partOfDay: string): GreetingSlot {
  if (partOfDay === "early morning" || partOfDay === "morning") return "morning";
  if (partOfDay === "evening" || partOfDay === "night") return "evening";
  return "anytime";
}

export interface VoiceGreetingOpts {
  now?: Date;
  /** [0, 1) — injectable for deterministic tests. */
  rng?: () => number;
}

/**
 * Builds the opening line for one call from the user's profile (name and
 * timezone only — deliberately nothing that could reference specifics).
 */
export function buildVoiceFirstMessage(
  profile: Pick<Profile, "userName" | "timezone"> | null,
  opts: VoiceGreetingOpts = {},
): string {
  const rng = opts.rng ?? Math.random;
  const rawName = profile?.userName?.trim() ?? "";
  // Long or multi-word "names" read awkwardly in a spoken hello — first word only.
  const name = rawName ? (rawName.split(/\s+/)[0] ?? "").slice(0, 30) || null : null;

  const timeCtx = getTimeContext(profile?.timezone || "UTC", opts.now ?? new Date());
  const slot = greetingSlotFor(timeCtx.partOfDay);
  // Mix the time slot's pool with the anytime pool so even one slot varies.
  const pool = [...GREETING_POOLS[slot], ...GREETING_POOLS.anytime];
  const pick = pool[Math.floor(rng() * pool.length) % pool.length]!;
  return pick(name);
}
