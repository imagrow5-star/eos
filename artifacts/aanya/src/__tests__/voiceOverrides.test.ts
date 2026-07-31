/**
 * Unit tests: buildSessionOverrides (lib/voiceOverrides.ts) — the payload each
 * cascade level sends to ElevenLabs. Pinning these guarantees:
 *  - NO level ever sends a first_message override — ElevenLabs rejects the
 *    field with a hard 1008 disconnect since ~July 29 ("Override for field
 *    'first_message' is not allowed by config"), which killed every call;
 *  - tone TTS + voiceId overrides are unchanged;
 *  - "none" sends NO overrides, so the agent's own config applies;
 *  - identical payloads across levels are detectable (the cascade skips
 *    no-op retries by comparing these objects).
 */

import { describe, it, expect } from "vitest";
import { buildSessionOverrides, TONE_TTS } from "../lib/voiceOverrides";

const INPUTS = { tone: "calm" as const, voiceId: "voice123" };

describe("buildSessionOverrides", () => {
  it("full: tone TTS + voiceId — nothing else", () => {
    expect(buildSessionOverrides("full", INPUTS)).toEqual({
      overrides: {
        tts: {
          stability: TONE_TTS.calm.stability,
          speed: TONE_TTS.calm.speed,
          voiceId: "voice123",
        },
      },
    });
  });

  it("voice: keeps voiceId, drops tone fields", () => {
    expect(buildSessionOverrides("voice", INPUTS)).toEqual({
      overrides: {
        tts: { voiceId: "voice123" },
      },
    });
  });

  it("none: sends nothing at all", () => {
    expect(buildSessionOverrides("none", INPUTS)).toEqual({});
  });

  it("NEVER emits an agent block — no first_message, no language (1008 regressions)", () => {
    // ElevenLabs rejects agent-field overrides with post-connect 1008
    // disconnects that the retry cascade cannot catch: first_message
    // (~July 29) and agent.language (July 31). Neither may EVER be sent —
    // even when the session carries a language (multilingual-agent calls).
    for (const level of ["full", "voice", "none"] as const) {
      // language is not even an accepted input anymore; passing it through a
      // widened object must still produce no agent block.
      const withLanguage = { ...INPUTS, language: "de" } as typeof INPUTS;
      for (const inputs of [INPUTS, withLanguage]) {
        const payload = buildSessionOverrides(level, inputs);
        expect(payload.overrides && "agent" in payload.overrides).toBeFalsy();
        const json = JSON.stringify(payload).toLowerCase();
        expect(json).not.toContain("first_message");
        expect(json).not.toContain("firstmessage");
        expect(json).not.toContain("language");
        expect(json).not.toContain('"agent"');
      }
    }
  });

  it("defaults unknown/missing tone to the auto delivery", () => {
    const built = buildSessionOverrides("full", {});
    expect(built.overrides?.tts).toMatchObject({
      stability: TONE_TTS.auto.stability,
      speed: TONE_TTS.auto.speed,
    });
  });

  it("voice and none collapse to identical payloads when no voiceId is set", () => {
    // No voiceId: voice === none — the cascade's payload dedup relies on this
    // equality to skip the pointless third dial.
    const voice = JSON.stringify(buildSessionOverrides("voice", { tone: "calm" }));
    const none = JSON.stringify(buildSessionOverrides("none", { tone: "calm" }));
    expect(voice).toBe(none);

    // With a voiceId they differ — the "voice" retry is meaningful.
    const voiceId = JSON.stringify(buildSessionOverrides("voice", { voiceId: "v1" }));
    expect(voiceId).not.toBe(none);
  });
});
