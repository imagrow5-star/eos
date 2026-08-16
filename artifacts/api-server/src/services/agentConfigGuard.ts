import { logger } from "../lib/logger";

// ─── ElevenLabs agent config guard ───────────────────────────────────────────
// July 2026 incident: agent-side settings (skip_turn tool + 1s soft-timeout
// filler + speculative_turn) went live ahead of validation and produced a
// production death loop — users heard only "Hhmmm...yeah" fillers while real
// replies were skipped or superseded. The agent is SHARED between the
// workspace and the production deployment, and its config lives outside git —
// so this guard makes the deployed code the single source of truth: on
// production boot the agent is reconciled to the state this build supports
// and has validated with real calls.
//
// To re-enable the listening feature (skip_turn), flip DESIRED_AGENT_STATE in
// a branch, tune the skip triggers, and validate with REAL AUDIO-MODE calls —
// text_only probes bypass TTS and turn-taking and hide exactly this class of
// bug — then publish. The prompt side follows automatically: the LISTENING
// rules are only injected when the skip_turn tool arrives with the request
// (see buildVoiceCallAddendum in services/ai.ts).

export interface AgentStateView {
  skipTurnToolPresent: boolean;
  softTimeoutSeconds: number;
  speculativeTurn: boolean;
  /** platform_settings.privacy.retention_days — 0 = delete after processing */
  retentionDays: number;
}

export const DESIRED_AGENT_STATE: AgentStateView = {
  // Privacy (Phase A): ElevenLabs must not keep transcripts or audio around.
  // 0 = scheduled deletion right after processing (their documented minimum);
  // -1 would mean unlimited and the ElevenLabs default is ~2 years.
  retentionDays: 0,
  // Disabled: Claude over-skipped on short asks ("What do you think about
  // it?") and on speculative half-transcripts that always look unfinished.
  skipTurnToolPresent: false,
  // Disabled (-1): the filler spoke ~1s in, BEFORE any skip decision arrived,
  // so every skipped turn sounded like an acknowledgment then dead silence.
  softTimeoutSeconds: -1,
  // Disabled: double generations got audibly cut at the first word when the
  // committed transcript superseded the speculative one.
  speculativeTurn: false,
};

const SKIP_TURN_TOOL = {
  type: "system",
  name: "skip_turn",
  description:
    "Skip speaking for this turn and wait in supportive silence. Use when the user is not finished talking (trailed off, incomplete thought, fillers like um…), asked for a moment, or when quiet presence is the kindest response.",
};

export function readAgentState(agentJson: unknown): AgentStateView {
  const cc = (agentJson as { conversation_config?: any })?.conversation_config ?? {};
  const prompt = cc.agent?.prompt ?? {};
  const tools: Array<{ name?: string }> = Array.isArray(prompt.tools) ? prompt.tools : [];
  const platform = (agentJson as { platform_settings?: any })?.platform_settings ?? {};
  return {
    skipTurnToolPresent:
      tools.some((t) => t?.name === "skip_turn") || Boolean(prompt.built_in_tools?.skip_turn),
    softTimeoutSeconds: cc.turn?.soft_timeout_config?.timeout_seconds ?? -1,
    speculativeTurn: Boolean(cc.turn?.speculative_turn),
    // Absent field ⇒ ElevenLabs default (~2 years) ⇒ report as -1 so the
    // guard sees drift and pins it to the desired value.
    retentionDays:
      typeof platform.privacy?.retention_days === "number" ? platform.privacy.retention_days : -1,
  };
}

// Minimal PATCH body to bring `current` to `desired`, or null when in sync.
// NOTE: the ElevenLabs PATCH deep-merge silently IGNORES `prompt.tools: []` —
// system tools can only be disabled by nulling `prompt.built_in_tools.<name>`
// (verified July 2026).
export function computeAgentPatch(
  current: AgentStateView,
  desired: AgentStateView = DESIRED_AGENT_STATE,
): Record<string, unknown> | null {
  const prompt: Record<string, unknown> = {};
  const turn: Record<string, unknown> = {};

  if (current.skipTurnToolPresent !== desired.skipTurnToolPresent) {
    prompt.built_in_tools = { skip_turn: desired.skipTurnToolPresent ? SKIP_TURN_TOOL : null };
  }
  if (current.softTimeoutSeconds !== desired.softTimeoutSeconds) {
    turn.soft_timeout_config = { timeout_seconds: desired.softTimeoutSeconds };
  }
  if (current.speculativeTurn !== desired.speculativeTurn) {
    turn.speculative_turn = desired.speculativeTurn;
  }
  const privacy: Record<string, unknown> = {};
  if (current.retentionDays !== desired.retentionDays) {
    privacy.retention_days = desired.retentionDays;
  }

  if (!Object.keys(prompt).length && !Object.keys(turn).length && !Object.keys(privacy).length) {
    return null;
  }
  const body: Record<string, unknown> = {};
  const cc: Record<string, unknown> = {};
  if (Object.keys(prompt).length) cc.agent = { prompt };
  if (Object.keys(turn).length) cc.turn = turn;
  if (Object.keys(cc).length) body.conversation_config = cc;
  if (Object.keys(privacy).length) body.platform_settings = { privacy };
  return body;
}

export async function reconcileAgentConfig(): Promise<
  "in_sync" | "patched" | "skipped" | "failed"
> {
  // The agent is shared with the workspace — only the production deployment
  // may rewrite it, otherwise a dev boot would fight the published build.
  // Production is either a Replit deployment (REPLIT_DEPLOYMENT) or the Render
  // service (RENDER is set automatically by Render; NODE_ENV=production as a
  // fallback). Without this, the guard silently never ran on Render and agent
  // drift (speculative turn / soft-timeout filler) caused overlapping speech.
  const isProduction =
    Boolean(process.env.REPLIT_DEPLOYMENT) ||
    Boolean(process.env.RENDER) ||
    process.env.NODE_ENV === "production";
  if (!isProduction) {
    logger.info("Agent config guard: skipped (not a production deployment)");
    return "skipped";
  }
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!apiKey || !agentId) {
    logger.warn("Agent config guard: skipped (ElevenLabs env vars missing)");
    return "skipped";
  }
  try {
    const url = `https://api.elevenlabs.io/v1/convai/agents/${agentId}`;
    const headers = { "xi-api-key": apiKey };
    const before = await fetch(url, { headers });
    if (!before.ok) throw new Error(`GET agent ${before.status}`);
    const beforeJson = await before.json();
    const current = readAgentState(beforeJson);
    // Informational, never patched: which TTS model the agent's voice runs on.
    // Latency triage reads this straight from the boot log — flash/turbo v2.5
    // speak in ~100-300ms, multilingual_v2 adds ~1s+ to every reply. Change it
    // in the ElevenLabs dashboard: Agent → Voice → Model.
    const ttsModelId =
      (beforeJson as { conversation_config?: { tts?: { model_id?: string } } })
        ?.conversation_config?.tts?.model_id ?? "unknown";
    const patch = computeAgentPatch(current);
    if (!patch) {
      logger.info({ current, ttsModelId }, "Agent config guard: in sync");
      return "in_sync";
    }
    logger.warn(
      { current, desired: DESIRED_AGENT_STATE },
      "Agent config guard: drift detected — patching agent to match this build",
    );
    const res = await fetch(url, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`PATCH agent ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const after = await fetch(url, { headers });
    if (!after.ok) throw new Error(`verify GET agent ${after.status}`);
    const verified = readAgentState(await after.json());
    if (computeAgentPatch(verified)) {
      throw new Error(`agent still drifted after patch: ${JSON.stringify(verified)}`);
    }
    logger.warn("Agent config guard: agent patched to desired state");
    return "patched";
  } catch (err) {
    // Never crash the server over this — but be LOUD.
    logger.error({ err }, "Agent config guard: FAILED — agent config may not match this build");
    return "failed";
  }
}
