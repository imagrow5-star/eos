// ─── ElevenLabs agent routing (per-language) ─────────────────────────────────
// Two agents exist: the original English agent (Flash TTS — ~95ms latency,
// English-only) and a Multilingual agent (Multilingual v2 TTS — ~885ms, all
// active languages). English users MUST stay on Flash to keep their fast
// experience; active non-English users route to the Multilingual agent.
// Pure config-based selection at call-start — nothing else changes.
//
// Safe degrade: if ELEVENLABS_AGENT_ID_MULTILINGUAL is missing, non-English
// users fall back to the English agent (voice works, pronunciation suffers)
// with a warning — never a crash, never a dead call button.

import { logger } from "../lib/logger.js";

export type AgentChoice = "english" | "multilingual";

export interface AgentRouting {
  /** The agent to dial, or null when no agent is configured at all. */
  agentId: string | null;
  agentUsed: AgentChoice;
}

/** Env read per call (matches the file's existing style) — trims both ids. */
function envAgents(): { english: string | null; multilingual: string | null } {
  const english = process.env.ELEVENLABS_AGENT_ID?.trim() || null;
  const multilingual = process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL?.trim() || null;
  return { english, multilingual };
}

export function resolveAgentRouting(user: {
  preferredLanguage?: string | null;
} | null | undefined): AgentRouting {
  const { english, multilingual } = envAgents();
  const language = (user?.preferredLanguage ?? "en").toLowerCase();

  if (language === "en" || !language) {
    return { agentId: english, agentUsed: "english" };
  }
  if (multilingual) {
    return { agentId: multilingual, agentUsed: "multilingual" };
  }
  logger.warn(
    { preferredLanguage: language },
    "ELEVENLABS_AGENT_ID_MULTILINGUAL not set — non-English user degraded to the English (Flash) agent",
  );
  return { agentId: english, agentUsed: "english" };
}

/** Spec'd string form: the agent id to dial for this user ("" if none set). */
export function resolveAgentIdForUser(user: {
  preferredLanguage?: string | null;
} | null | undefined): string {
  return resolveAgentRouting(user).agentId ?? "";
}

/** Boot check: loud warning when only one of the two agent ids is present. */
export function warnIfAgentEnvIncomplete(): void {
  const { english, multilingual } = envAgents();
  if (english && !multilingual) {
    logger.warn(
      "ELEVENLABS_AGENT_ID_MULTILINGUAL is not set — ALL voice calls (including " +
        "non-English users) will use the English/Flash agent until it is configured.",
    );
  } else if (!english && multilingual) {
    logger.warn(
      "ELEVENLABS_AGENT_ID is not set but ELEVENLABS_AGENT_ID_MULTILINGUAL is — " +
        "English users have no agent; voice calls will report not_configured.",
    );
  }
}
