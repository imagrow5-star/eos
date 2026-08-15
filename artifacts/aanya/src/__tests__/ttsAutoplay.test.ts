/**
 * TTS auto-play cost guard (lib/ttsAutoplay.ts).
 *
 * Auto-play is limited to onboarding; after onboarding a reply is silent until
 * the user taps Listen. These tests pin that policy — the single decision the
 * streaming send-handler consults before firing handleSpeak on reply arrival.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { shouldAutoplayChatReply } from "../lib/ttsAutoplay";

describe("shouldAutoplayChatReply", () => {
  it("main chat (onboarding complete): does NOT auto-play — no TTS on message arrival", () => {
    expect(shouldAutoplayChatReply({ onboardingComplete: true })).toBe(false);
  });

  it("onboarding (not complete): auto-plays, as before (regression check)", () => {
    expect(shouldAutoplayChatReply({ onboardingComplete: false })).toBe(true);
  });
});

// ─── Wiring guard ────────────────────────────────────────────────────────────
// A source-level check that the streaming reply path actually consults the
// policy (auto-play gated) while the per-message Listen button does NOT (manual
// TTS always works). Cheap insurance against a refactor silently re-enabling
// auto-play or gating the Listen button.

describe("Chat.tsx wiring", () => {
  const chatSrc = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../pages/Chat.tsx"),
    "utf8",
  );

  it("gates the streaming reply auto-play behind shouldAutoplayChatReply", () => {
    expect(chatSrc).toContain(
      "shouldAutoplayChatReply({ onboardingComplete: !!onboarding?.isComplete })",
    );
    // The auto-play handleSpeak must sit inside that guard.
    const guardIdx = chatSrc.indexOf("shouldAutoplayChatReply({ onboardingComplete");
    const afterGuard = chatSrc.slice(guardIdx, guardIdx + 400);
    expect(afterGuard).toContain("handleSpeak(speakableContent, finalMessageId)");
  });

  it("keeps the per-message Listen button as unconditional user-initiated TTS", () => {
    // The Listen button calls handleSpeak on click, never behind the auto-play
    // policy — it must stay a plain onClick handler.
    expect(chatSrc).toContain('onClick={() => handleSpeakRef.current(msgBody, String(msg.id))}');
    expect(chatSrc).not.toContain("shouldAutoplayChatReply({ onboardingComplete: !!onboarding?.isComplete }) && handleSpeak(msgBody");
  });
});
