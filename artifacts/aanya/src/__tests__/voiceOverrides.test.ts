/**
 * Unit tests: buildSessionOverrides (lib/voiceOverrides.ts) — the payload each
 * cascade level sends to ElevenLabs. Pinning these guarantees:
 *  - the instant firstMessage rides at "full" AND "voice" (it must survive
 *    the tone-flags-disabled failure mode);
 *  - "none" sends NO overrides, so the agent's own config generates the
 *    greeting (slow LLM path) — meaning the override greeting and the LLM
 *    greeting can never both play on one connect;
 *  - identical payloads across levels are detectable (the cascade skips
 *    no-op retries by comparing these objects).
 */

import { describe, it, expect } from "vitest";
import { buildSessionOverrides, TONE_TTS } from "../lib/voiceOverrides";

const INPUTS = { tone: "calm" as const, voiceId: "voice123", firstMessage: "Hey, it's me." };

describe("buildSessionOverrides", () => {
  it("full: tone TTS + voiceId + firstMessage", () => {
    expect(buildSessionOverrides("full", INPUTS)).toEqual({
      overrides: {
        tts: {
          stability: TONE_TTS.calm.stability,
          speed: TONE_TTS.calm.speed,
          voiceId: "voice123",
        },
        agent: { firstMessage: "Hey, it's me." },
      },
    });
  });

  it("voice: keeps voiceId AND firstMessage, drops tone fields", () => {
    expect(buildSessionOverrides("voice", INPUTS)).toEqual({
      overrides: {
        tts: { voiceId: "voice123" },
        agent: { firstMessage: "Hey, it's me." },
      },
    });
  });

  it("none: sends nothing at all (agent-config greeting takes over)", () => {
    expect(buildSessionOverrides("none", INPUTS)).toEqual({});
  });

  it("omits the agent block when there is no firstMessage", () => {
    const built = buildSessionOverrides("voice", { voiceId: "voice123" });
    expect(built).toEqual({ overrides: { tts: { voiceId: "voice123" } } });
  });

  it("defaults unknown/missing tone to the auto delivery", () => {
    const built = buildSessionOverrides("full", { firstMessage: "Hi." });
    expect(built.overrides?.tts).toMatchObject({
      stability: TONE_TTS.auto.stability,
      speed: TONE_TTS.auto.speed,
    });
  });

  it("voice and none collapse to identical payloads only when both are empty", () => {
    // No voiceId, no firstMessage: voice === none — the cascade's payload
    // dedup relies on this equality to skip the pointless third dial.
    const voice = JSON.stringify(buildSessionOverrides("voice", { tone: "calm" }));
    const none = JSON.stringify(buildSessionOverrides("none", { tone: "calm" }));
    expect(voice).toBe(none);

    // With a firstMessage they differ — the "voice" retry is meaningful.
    const voiceFm = JSON.stringify(buildSessionOverrides("voice", { firstMessage: "Hi." }));
    expect(voiceFm).not.toBe(none);
  });
});
