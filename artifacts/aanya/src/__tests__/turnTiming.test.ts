/**
 * Per-turn timing on a Hume call (lib/turnTiming.ts): one timing per reply,
 * measured from the final transcript, with the TTS gap and the end-of-turn
 * silence when Hume's timestamps allow it.
 */

import { describe, it, expect } from "vitest";
import { TurnTimer } from "../lib/turnTiming";

describe("TurnTimer", () => {
  it("measures the wait from the final transcript to first audio, and TTS from text to audio", () => {
    const t = new TurnTimer();
    const base = 1_700_000_000_000; // wall clock, as Date.now() on the call screen
    t.onUserFinal(base + 10_000, base + 9_400); // Hume's utterance end, 600 ms before the final
    t.onAssistantText(base + 11_200);
    const timing = t.onAudio(base + 11_500);
    expect(timing).toEqual({
      turn: 1,
      greeting: false,
      finalToFirstAudioMs: 1500,
      textToFirstAudioMs: 300,
      userEndToFinalMs: 600,
    });
  });

  it("reports the greeting without user fields, and only once per reply", () => {
    const t = new TurnTimer();
    t.onAssistantText(1000);
    expect(t.onAudio(1400)).toEqual({ turn: 1, greeting: true, finalToFirstAudioMs: null, textToFirstAudioMs: 400, userEndToFinalMs: null });
    expect(t.onAudio(1500)).toBeNull();
    expect(t.onAudio(1600)).toBeNull();
    t.onReplyEnd();
    t.onUserFinal(5000);
    t.onAssistantText(6000);
    expect(t.onAudio(6300)).toMatchObject({ turn: 2, greeting: false, finalToFirstAudioMs: 1300, textToFirstAudioMs: 300 });
  });

  it("a non-wall-clock utterance timestamp gives no end-of-turn figure", () => {
    const t = new TurnTimer();
    t.onUserFinal(10_000, 4200); // relative ms, as seen in text captures
    t.onAssistantText(10_900);
    expect(t.onAudio(11_000)!.userEndToFinalMs).toBeNull();
  });

  it("a barge-in closes the reply so the next audio starts a fresh turn", () => {
    const t = new TurnTimer();
    t.onUserFinal(1000);
    t.onAssistantText(1800);
    expect(t.onAudio(2000)!.turn).toBe(1);
    t.onReplyEnd(); // user_interruption
    t.onUserFinal(3000);
    t.onAssistantText(3700);
    expect(t.onAudio(4000)).toMatchObject({ turn: 2, finalToFirstAudioMs: 1000, textToFirstAudioMs: 300 });
  });

  it("a revised final transcript restarts the clock for that turn", () => {
    const t = new TurnTimer();
    t.onUserFinal(1000);
    t.onUserFinal(1400); // Hume revised the final before replying
    t.onAssistantText(2000);
    expect(t.onAudio(2200)!.finalToFirstAudioMs).toBe(800);
  });
});
