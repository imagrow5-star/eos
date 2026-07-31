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
const INPUTS_DE = { ...INPUTS, language: "de" };

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

  it("NEVER emits a first_message override at any level (1008 regression)", () => {
    for (const level of ["full", "voice", "none"] as const) {
      for (const inputs of [INPUTS, INPUTS_DE]) {
        const json = JSON.stringify(buildSessionOverrides(level, inputs)).toLowerCase();
        expect(json).not.toContain("first_message");
        expect(json).not.toContain("firstmessage");
      }
      // English calls never get an agent block at all.
      const payload = buildSessionOverrides(level, INPUTS);
      expect(payload.overrides && "agent" in payload.overrides).toBeFalsy();
    }
  });

  it("non-English calls carry agent.language at full AND voice; none drops it (graceful degrade)", () => {
    expect(buildSessionOverrides("full", INPUTS_DE).overrides?.agent).toEqual({ language: "de" });
    expect(buildSessionOverrides("voice", INPUTS_DE).overrides?.agent).toEqual({ language: "de" });
    // The cascade's last attempt has NO overrides — a config that rejects the
    // language override still gets a working (English-biased) call.
    expect(buildSessionOverrides("none", INPUTS_DE)).toEqual({});
  });

  it("explicit language 'en' or absent language emits no agent block", () => {
    expect(buildSessionOverrides("full", { ...INPUTS, language: "en" }).overrides?.agent).toBeUndefined();
    expect(buildSessionOverrides("full", INPUTS).overrides?.agent).toBeUndefined();
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
