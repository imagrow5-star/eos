// Pure unit tests — no DB, no network. Covers the agent config guard's state
// reading/diffing and the conditional voice addendum (listening rules must
// only appear when the skip_turn tool is actually available).
import { describe, it, expect } from "vitest";
import {
  readAgentState,
  computeAgentPatch,
  DESIRED_AGENT_STATE,
} from "../services/agentConfigGuard.js";
import { buildVoiceCallAddendum } from "../services/ai.js";

const SAFE_STATE = {
  skipTurnToolPresent: false,
  softTimeoutSeconds: -1,
  speculativeTurn: false,
  retentionDays: 0, // Phase A privacy: ElevenLabs deletes transcripts/audio after processing
};

describe("readAgentState — ElevenLabs agent JSON → view", () => {
  it("reads the July-2026 incident state (tool on, filler 1s, speculative on)", () => {
    const view = readAgentState({
      conversation_config: {
        agent: {
          prompt: {
            tools: [{ type: "system", name: "skip_turn", description: "…" }],
            built_in_tools: { skip_turn: { type: "system", name: "skip_turn" } },
          },
        },
        turn: { speculative_turn: true, soft_timeout_config: { timeout_seconds: 1 } },
      },
    });
    expect(view).toEqual({
      skipTurnToolPresent: true,
      softTimeoutSeconds: 1,
      speculativeTurn: true,
      retentionDays: -1, // absent from fixture ⇒ unknown ⇒ reported as -1 (drift)
    });
  });

  it("reads retention_days from platform_settings.privacy", () => {
    const view = readAgentState({
      conversation_config: {},
      platform_settings: { privacy: { retention_days: 730 } },
    });
    expect(view.retentionDays).toBe(730);
  });

  it("detects skip_turn via built_in_tools even when the tools array is empty", () => {
    const view = readAgentState({
      conversation_config: {
        agent: { prompt: { tools: [], built_in_tools: { skip_turn: { name: "skip_turn" } } } },
        turn: {},
      },
    });
    expect(view.skipTurnToolPresent).toBe(true);
  });

  it("defaults to the safe conversation state on missing fields — but retention reads as unknown", () => {
    // Missing retention must NOT read as safe: -1 forces the guard to pin it.
    expect(readAgentState({})).toEqual({ ...SAFE_STATE, retentionDays: -1 });
  });
});

describe("computeAgentPatch — minimal drift correction", () => {
  it("returns null when already in sync with the desired (safe) state", () => {
    expect(computeAgentPatch(SAFE_STATE)).toBeNull();
    expect(DESIRED_AGENT_STATE).toEqual(SAFE_STATE); // guard: safe state IS the desired state
  });

  it("disables skip_turn via built_in_tools null — never tools:[] (PATCH no-ops on it)", () => {
    const patch = computeAgentPatch({ ...SAFE_STATE, skipTurnToolPresent: true });
    expect(patch).toEqual({
      conversation_config: { agent: { prompt: { built_in_tools: { skip_turn: null } } } },
    });
  });

  it("fixes filler and speculative drift in one turn block", () => {
    const patch = computeAgentPatch({
      skipTurnToolPresent: false,
      softTimeoutSeconds: 1,
      speculativeTurn: true,
      retentionDays: 0,
    });
    expect(patch).toEqual({
      conversation_config: {
        turn: { soft_timeout_config: { timeout_seconds: -1 }, speculative_turn: false },
      },
    });
  });

  it("pins ElevenLabs retention to 0 via platform_settings when drifted (Phase A privacy)", () => {
    const patch = computeAgentPatch({ ...SAFE_STATE, retentionDays: -1 });
    expect(patch).toEqual({ platform_settings: { privacy: { retention_days: 0 } } });
    // Default 2-year retention must also be corrected
    const patch2 = computeAgentPatch({ ...SAFE_STATE, retentionDays: 730 });
    expect(patch2).toEqual({ platform_settings: { privacy: { retention_days: 0 } } });
  });

  it("merges conversation and privacy drift into one PATCH body", () => {
    const patch = computeAgentPatch({ ...SAFE_STATE, speculativeTurn: true, retentionDays: -1 });
    expect(patch).toEqual({
      conversation_config: { turn: { speculative_turn: false } },
      platform_settings: { privacy: { retention_days: 0 } },
    });
  });

  it("can also ENABLE skip_turn when a future build flips the desired state", () => {
    const patch = computeAgentPatch(SAFE_STATE, { ...SAFE_STATE, skipTurnToolPresent: true });
    const tool = (patch as any)?.conversation_config?.agent?.prompt?.built_in_tools?.skip_turn;
    expect(tool?.type).toBe("system");
    expect(tool?.name).toBe("skip_turn");
    expect(typeof tool?.description).toBe("string");
  });
});

describe("buildVoiceCallAddendum — listening rules follow tool availability", () => {
  it("omits every listening/skip_turn instruction when the tool is absent", () => {
    const addendum = buildVoiceCallAddendum(false);
    expect(addendum).toContain("VOICE CALL MODE");
    expect(addendum).not.toContain("skip_turn");
    expect(addendum).not.toContain("LISTENING");
  });

  it("includes the listening block when skip_turn is available", () => {
    const addendum = buildVoiceCallAddendum(true);
    expect(addendum).toContain("VOICE CALL MODE");
    expect(addendum).toContain("LISTENING");
    expect(addendum).toContain("skip_turn");
  });

  it("is deterministic — byte-identical output per flag (prompt-cache safety)", () => {
    expect(buildVoiceCallAddendum(true)).toBe(buildVoiceCallAddendum(true));
    expect(buildVoiceCallAddendum(false)).toBe(buildVoiceCallAddendum(false));
  });
});
