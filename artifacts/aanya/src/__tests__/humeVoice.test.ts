/**
 * Pure logic of the Hume voice engine (lib/humeVoice.ts) — the session-shape
 * guard Chat.tsx relies on before starting a call, and the close-event →
 * human-readable-cause mapping (mirrors realtimeVoice's describeDisconnect
 * contract: null means clean close, anything else is shown to the user).
 */

import { describe, it, expect } from "vitest";
import { humeCloseMessage, isHumeSession } from "../lib/humeVoice";
import { asrLanguageMismatch } from "../lib/asrLanguage";

describe("isHumeSession", () => {
  const full = { mode: "hume", accessToken: "tok", configId: "cfg", userToken: "1.2.3.dev.sig" };

  it("accepts a complete Hume session payload", () => {
    expect(isHumeSession(full)).toBe(true);
  });

  it("rejects ElevenLabs payloads and partial Hume payloads", () => {
    expect(isHumeSession({ mode: "signed", signedUrl: "wss://x" })).toBe(false);
    expect(isHumeSession({ ...full, accessToken: "" })).toBe(false);
    expect(isHumeSession({ ...full, configId: undefined })).toBe(false);
    expect(isHumeSession({ ...full, userToken: 42 })).toBe(false);
    expect(isHumeSession(null)).toBe(false);
  });
});

describe("humeCloseMessage", () => {
  it("clean closes (1000/1005/undefined) → null unless a reason is given", () => {
    expect(humeCloseMessage(1000, undefined)).toBeNull();
    expect(humeCloseMessage(1005, "")).toBeNull();
    expect(humeCloseMessage(undefined, undefined)).toBeNull();
  });

  it("abnormal closes carry the code and any reason", () => {
    expect(humeCloseMessage(1008, undefined)).toBe("code 1008");
    expect(humeCloseMessage(1008, "policy violation")).toBe("policy violation — code 1008");
  });

  it("a clean close with a reason still surfaces the reason", () => {
    expect(humeCloseMessage(1000, "server going away")).toBe("server going away");
  });
});

describe("asrLanguageMismatch (detect-vs-profile evidence)", () => {
  it("accepts plausible spellings of the profile language — format is unpinned", () => {
    for (const d of ["en", "eng", "en-US", "English"]) {
      expect(asrLanguageMismatch(d, "en"), d).toBe(false);
    }
    for (const d of ["es", "es-MX", "spa", "Spanish", "español"]) {
      expect(asrLanguageMismatch(d, "es"), d).toBe(false);
    }
  });

  it("flags the live failure: English detected on a Spanish profile", () => {
    expect(asrLanguageMismatch("en", "es")).toBe(true);
    expect(asrLanguageMismatch("English", "es")).toBe(true);
    expect(asrLanguageMismatch("es", "en")).toBe(true);
  });

  it("an unknown detected format counts as a mismatch so the raw value reaches the logs", () => {
    expect(asrLanguageMismatch("und", "en")).toBe(true);
    expect(asrLanguageMismatch("zz-XX", "es")).toBe(true);
  });

  it("an empty detection reports nothing", () => {
    expect(asrLanguageMismatch("", "es")).toBe(false);
    expect(asrLanguageMismatch("   ", "en")).toBe(false);
  });
});
