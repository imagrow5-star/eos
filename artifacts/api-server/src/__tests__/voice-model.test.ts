/**
 * Unit tests: model selection for the realtime voice path.
 *
 * Voice calls default to Claude Haiku 4.5 for latency; VOICE_LLM_MODEL is the
 * no-code-change rollback switch (set it back to the Sonnet ID on Render).
 * Text chat and every background pipeline keep DEFAULT_COMPANION_MODEL —
 * these tests pin both sides so a future edit can't silently flip either.
 */

import { describe, it, expect, afterEach } from "vitest";
import { resolveVoiceLlmModel } from "../routes/voice-llm.js";
import { DEFAULT_COMPANION_MODEL, MODEL_PRICES_PER_MTOK } from "../services/ai.js";

const ORIGINAL_VOICE_MODEL = process.env.VOICE_LLM_MODEL;

afterEach(() => {
  if (ORIGINAL_VOICE_MODEL === undefined) delete process.env.VOICE_LLM_MODEL;
  else process.env.VOICE_LLM_MODEL = ORIGINAL_VOICE_MODEL;
});

describe("resolveVoiceLlmModel", () => {
  it("defaults to Claude Haiku 4.5 when VOICE_LLM_MODEL is unset", () => {
    delete process.env.VOICE_LLM_MODEL;
    expect(resolveVoiceLlmModel()).toBe("claude-haiku-4-5");
  });

  it("uses VOICE_LLM_MODEL when set (the rollback switch)", () => {
    process.env.VOICE_LLM_MODEL = "claude-sonnet-4-5-20250929";
    expect(resolveVoiceLlmModel()).toBe("claude-sonnet-4-5-20250929");
  });

  it("trims surrounding whitespace from the env value", () => {
    process.env.VOICE_LLM_MODEL = "  claude-sonnet-4-5-20250929  ";
    expect(resolveVoiceLlmModel()).toBe("claude-sonnet-4-5-20250929");
  });

  it("falls back to the default when VOICE_LLM_MODEL is empty or whitespace", () => {
    process.env.VOICE_LLM_MODEL = "   ";
    expect(resolveVoiceLlmModel()).toBe("claude-haiku-4-5");
  });
});

describe("text-chat default model", () => {
  it("stays on Sonnet 4.5 — the voice override must not leak into text chat", () => {
    expect(DEFAULT_COMPANION_MODEL).toBe("claude-sonnet-4-5-20250929");
  });
});

describe("cost logging", () => {
  it("has pricing for the voice default so ai_usage reflects real cost", () => {
    expect(MODEL_PRICES_PER_MTOK[resolveVoiceLlmModel()]).toBeDefined();
    expect(MODEL_PRICES_PER_MTOK["claude-haiku-4-5"]).toEqual({
      input: 1,
      output: 5,
      cacheWrite: 1.25,
      cacheRead: 0.1,
    });
  });

  it("has pricing for the text-chat default", () => {
    expect(MODEL_PRICES_PER_MTOK[DEFAULT_COMPANION_MODEL]).toBeDefined();
  });
});
