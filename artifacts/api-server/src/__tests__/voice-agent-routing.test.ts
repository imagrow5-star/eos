/**
 * Per-language ElevenLabs agent routing (pure env-based unit tests).
 *
 * English (or unset language) → the English/Flash agent, always.
 * Active non-English → the Multilingual agent when configured; otherwise a
 * warned fallback to the English agent (safe degrade — never a dead call).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveAgentIdForUser,
  resolveAgentRouting,
} from "../services/voiceAgentRouting.js";

const EN_AGENT = "agent_english_123";
const ML_AGENT = "agent_multilingual_456";

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved.en = process.env.ELEVENLABS_AGENT_ID;
  saved.ml = process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL;
  process.env.ELEVENLABS_AGENT_ID = EN_AGENT;
  process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL = ML_AGENT;
});

afterEach(() => {
  if (saved.en === undefined) delete process.env.ELEVENLABS_AGENT_ID;
  else process.env.ELEVENLABS_AGENT_ID = saved.en;
  if (saved.ml === undefined) delete process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL;
  else process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL = saved.ml;
});

describe("resolveAgentIdForUser", () => {
  it("English user → the English/Flash agent", () => {
    expect(resolveAgentIdForUser({ preferredLanguage: "en" })).toBe(EN_AGENT);
    expect(resolveAgentRouting({ preferredLanguage: "en" }).agentUsed).toBe("english");
  });

  it("German user → the Multilingual agent", () => {
    expect(resolveAgentIdForUser({ preferredLanguage: "de" })).toBe(ML_AGENT);
    expect(resolveAgentRouting({ preferredLanguage: "de" }).agentUsed).toBe("multilingual");
  });

  it("every other activated language also routes to Multilingual", () => {
    for (const lang of ["nl", "fr", "es", "it", "pt", "sv", "no", "da", "pl"]) {
      expect(resolveAgentIdForUser({ preferredLanguage: lang }), lang).toBe(ML_AGENT);
    }
  });

  it("no language set → the English agent (safe default)", () => {
    expect(resolveAgentIdForUser({ preferredLanguage: null })).toBe(EN_AGENT);
    expect(resolveAgentIdForUser({})).toBe(EN_AGENT);
    expect(resolveAgentIdForUser(null)).toBe(EN_AGENT);
    expect(resolveAgentIdForUser(undefined)).toBe(EN_AGENT);
  });

  it("missing multilingual agent + non-English user → warned fallback to the English agent", () => {
    delete process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL;
    const routing = resolveAgentRouting({ preferredLanguage: "de" });
    expect(routing.agentId).toBe(EN_AGENT);
    expect(routing.agentUsed).toBe("english"); // logs honestly what was actually used
    expect(resolveAgentIdForUser({ preferredLanguage: "de" })).toBe(EN_AGENT);
  });

  it("blank/whitespace multilingual id is treated as missing", () => {
    process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL = "   ";
    expect(resolveAgentIdForUser({ preferredLanguage: "fr" })).toBe(EN_AGENT);
  });

  it("no agents configured at all → empty string (endpoint reports not_configured first)", () => {
    delete process.env.ELEVENLABS_AGENT_ID;
    delete process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL;
    expect(resolveAgentIdForUser({ preferredLanguage: "en" })).toBe("");
    expect(resolveAgentIdForUser({ preferredLanguage: "de" })).toBe("");
  });
});
