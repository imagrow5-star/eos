import { useState, useEffect, useRef } from "react";

// ─── Speech recognition hook ──────────────────────────────────────────────────

export function useSpeechRecognition(onResult: (text: string) => void) {
  const [isListening, setIsListening] = useState(false);
  const [recognition, setRecognition] = useState<any>(null);

  // Keep latest onResult in a ref — effect only runs once
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    // @ts-ignore
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const reco = new SpeechRecognition();
    reco.continuous = false;
    reco.interimResults = false;
    reco.lang = "en-US";

    reco.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      onResultRef.current(transcript);
    };
    reco.onerror = () => setIsListening(false);
    reco.onend = () => setIsListening(false);

    setRecognition(reco);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startListening = () => {
    if (recognition) {
      try { recognition.start(); setIsListening(true); } catch { /* already running */ }
    }
  };

  const stopListening = () => {
    if (recognition) {
      try { recognition.stop(); } catch { /* ignore */ }
      setIsListening(false);
    }
  };

  return { isListening, startListening, stopListening, supported: !!recognition };
}

// ─── Text-to-speech ───────────────────────────────────────────────────────────
// Tries ElevenLabs via server proxy first. On any error (no key, quota, bad voice ID,
// network failure) logs to console and falls back to browser Web Speech API so the
// user always hears something.

export interface SpeakOptions {
  onStart?: () => void;
  onEnd?: () => void;
  voiceId?: string; // ElevenLabs voice ID — overrides profile default if provided
}

export async function speakText(text: string, options?: SpeakOptions): Promise<void> {
  const { onStart, onEnd, voiceId } = options ?? {};

  if (!text?.trim()) { onEnd?.(); return; }

  // ── Try ElevenLabs via /api/tts ──────────────────────────────────────────
  try {
    const body: Record<string, string> = { text };
    if (voiceId) body.voiceId = voiceId;

    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const { audio } = (await response.json()) as { audio: string; format: string };

      const binary = atob(audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audioEl = new Audio(url);

      await new Promise<void>((resolve) => {
        audioEl.oncanplaythrough = () => {
          onStart?.();
          audioEl.play().catch((err) => {
            // Autoplay blocked — browser hasn't had user interaction yet
            console.warn("[voice] Audio autoplay blocked — falling back to browser TTS:", err);
            URL.revokeObjectURL(url);
            browserSpeak(text, onStart, onEnd);
            resolve();
          });
        };
        audioEl.onended = () => {
          URL.revokeObjectURL(url);
          onEnd?.();
          resolve();
        };
        audioEl.onerror = (err) => {
          console.warn("[voice] Audio element error:", err);
          URL.revokeObjectURL(url);
          resolve();
        };
      });
      return;
    } else {
      // Server returned an error — log it and fall through
      const errBody = await response.json().catch(() => ({})) as any;
      console.warn(
        `[voice] ElevenLabs error ${response.status}:`,
        errBody?.detail ?? errBody?.error ?? response.statusText,
      );
    }
  } catch (err) {
    console.warn("[voice] ElevenLabs request failed — falling back to browser TTS:", err);
  }

  // ── Browser Web Speech API fallback ──────────────────────────────────────
  browserSpeak(text, onStart, onEnd);
}

function browserSpeak(text: string, onStart?: () => void, onEnd?: () => void) {
  if (typeof window === "undefined" || !window.speechSynthesis) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 0.88;
  utterance.pitch = 1.05;
  onStart?.();
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();
  window.speechSynthesis.speak(utterance);
}
