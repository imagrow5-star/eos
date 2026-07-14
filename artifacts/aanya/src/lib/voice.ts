import { useState, useEffect, useRef, useCallback } from "react";

// ─── Speech recognition hook ──────────────────────────────────────────────────
// Uses a ref for the recognition object so startListening / stopListening are
// stable across renders and safe to call from async callbacks.

export function useSpeechRecognition(
  onResult: (text: string) => void,
  options: { onInterimResult?: (text: string) => void } = {},
) {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<any>(null);
  const onResultRef    = useRef(onResult);
  const onInterimRef   = useRef(options.onInterimResult);

  // Always keep the latest callbacks in refs — no re-subscription needed
  useEffect(() => { onResultRef.current = onResult; });
  useEffect(() => { onInterimRef.current = options.onInterimResult; });

  useEffect(() => {
    if (typeof window === "undefined") return;
    // @ts-ignore
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return; // isSupported stays false — caller can show a message

    const reco = new SR();
    reco.continuous    = false;
    reco.interimResults = true;   // give live interim results for real-time transcription
    reco.lang          = "en-US";
    reco.maxAlternatives = 1;

    reco.onresult = (event: any) => {
      let interim = "";
      let final   = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) final   += text;
        else                          interim  += text;
      }
      if (interim) onInterimRef.current?.(interim);
      if (final)   onResultRef.current(final.trim());
    };

    reco.onerror = (e: any) => {
      setIsListening(false);
      if (e.error === "not-allowed") {
        setError(
          "Microphone access was denied — please allow it in your browser settings and try again.",
        );
      } else if (e.error === "no-speech") {
        // Nothing said — stop silently, no error shown
      } else if (e.error !== "aborted") {
        setError("Voice input isn't available right now — try again or type instead.");
      }
    };

    reco.onend = () => setIsListening(false);

    recognitionRef.current = reco;
    setIsSupported(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable functions — ref-based so they never go stale in async closures
  const startListening = useCallback(() => {
    const reco = recognitionRef.current;
    if (!reco) return;
    setError(null);
    try { reco.start(); setIsListening(true); }
    catch { /* already running — ignore */ }
  }, []);

  const stopListening = useCallback(() => {
    const reco = recognitionRef.current;
    if (!reco) return;
    try { reco.stop(); } catch { /* ignore */ }
    setIsListening(false);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { isListening, startListening, stopListening, isSupported, error, clearError };
}

// ─── Text-to-speech ───────────────────────────────────────────────────────────
// Tries ElevenLabs via server proxy first (with-timestamps endpoint for live captions).
// On any error falls back to browser Web Speech API so the user always hears something.

// ─── Alignment types ──────────────────────────────────────────────────────────

export interface CharAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

// Compute the start time (in seconds) of each whitespace-delimited word using
// the character-level alignment returned by ElevenLabs /with-timestamps.
export function computeWordTimings(text: string, alignment: CharAlignment): number[] {
  const timings: number[] = [];
  let i = 0;
  while (i < text.length) {
    // Skip whitespace between words
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    // Record the start time of the first character of this word
    timings.push(alignment.character_start_times_seconds[i] ?? 0);
    // Advance past the word
    while (i < text.length && !/\s/.test(text[i])) i++;
  }
  return timings;
}

// ─── SpeakOptions ─────────────────────────────────────────────────────────────

export interface SpeakOptions {
  onStart?: () => void;
  onEnd?: () => void;
  voiceId?: string;       // ElevenLabs voice ID — passed verbatim to /api/tts
  signal?: AbortSignal;   // optional external abort signal
  /**
   * Called each time a new word becomes the "current" word being spoken.
   * revealedCount: how many words have been revealed so far (1-based).
   * totalWords: total word count in the text.
   */
  onWordReveal?: (revealedCount: number, totalWords: number) => void;
}

// ─── Active-audio tracking (module-level singleton) ──────────────────────────
// Allows stopSpeaking() to cancel any in-flight fetch AND stop any playing audio
// element, regardless of where the call originated.

let _activeFetchAbort: AbortController | null = null;
let _activeAudioEl: HTMLAudioElement | null = null;
let _activeAudioUrl: string | null = null;
let _activeRafId: number | null = null;          // requestAnimationFrame loop for ElevenLabs captions
let _activeFallbackTimer: ReturnType<typeof setInterval> | null = null; // fallback interval timer

/**
 * Immediately stop any audio that is currently playing or being fetched.
 * Also cancels any in-progress caption animation loop.
 * Safe to call even when nothing is playing.
 */
export function stopSpeaking(): void {
  // 1. Abort the in-flight ElevenLabs fetch (if any)
  _activeFetchAbort?.abort();
  _activeFetchAbort = null;

  // 2. Pause + detach the audio element
  if (_activeAudioEl) {
    _activeAudioEl.oncanplaythrough = null;
    _activeAudioEl.onended = null;
    _activeAudioEl.onerror = null;
    _activeAudioEl.pause();
    _activeAudioEl.src = "";
    _activeAudioEl = null;
  }

  // 3. Release the object URL
  if (_activeAudioUrl) {
    URL.revokeObjectURL(_activeAudioUrl);
    _activeAudioUrl = null;
  }

  // 4. Cancel caption RAF loop
  if (_activeRafId !== null) {
    cancelAnimationFrame(_activeRafId);
    _activeRafId = null;
  }

  // 5. Cancel fallback caption interval
  if (_activeFallbackTimer !== null) {
    clearInterval(_activeFallbackTimer);
    _activeFallbackTimer = null;
  }

  // 6. Also cancel any browser speech synthesis in progress
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
}

export async function speakText(text: string, options?: SpeakOptions): Promise<void> {
  const { onStart, onEnd, voiceId, signal: externalSignal, onWordReveal } = options ?? {};

  if (!text?.trim()) { onEnd?.(); return; }

  // Stop whatever was playing before this call
  stopSpeaking();

  // Create an AbortController for this request so it can be cancelled later
  const controller = new AbortController();
  _activeFetchAbort = controller;

  // If the caller passed their own signal, chain it
  if (externalSignal) {
    externalSignal.addEventListener("abort", () => controller.abort());
  }

  const { signal } = controller;

  // ── Try ElevenLabs via /api/tts ──────────────────────────────────────────
  try {
    const body: Record<string, string> = { text };
    if (voiceId) body.voiceId = voiceId;

    const response = await fetch(`${import.meta.env.BASE_URL}api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    // If we were aborted while waiting, exit silently
    if (signal.aborted) return;

    if (response.ok) {
      const data = await response.json() as {
        audio: string;
        format: string;
        alignment?: CharAlignment;
      };

      if (signal.aborted) return;

      const { audio, alignment } = data;

      const binary = atob(audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const blob = new Blob([bytes], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audioEl = new Audio(url);

      // Register as the active audio so stopSpeaking() can reach it
      _activeAudioEl = audioEl;
      _activeAudioUrl = url;
      _activeFetchAbort = null; // fetch done; tracking moves to audio element

      // Pre-compute word timings from character alignment (if available)
      const wordTimings = alignment ? computeWordTimings(text, alignment) : null;
      const totalWords = text.trim().split(/\s+/).length;

      await new Promise<void>((resolve) => {
        audioEl.oncanplaythrough = () => {
          if (signal.aborted) {
            audioEl.src = "";
            URL.revokeObjectURL(url);
            _activeAudioEl = null;
            _activeAudioUrl = null;
            resolve();
            return;
          }

          onStart?.();
          audioEl.play().catch((err) => {
            // Autoplay blocked — browser hasn't had user interaction yet
            console.warn("[voice] Audio autoplay blocked — falling back to browser TTS:", err);
            URL.revokeObjectURL(url);
            _activeAudioEl = null;
            _activeAudioUrl = null;
            browserSpeak(text, onStart, onEnd, onWordReveal, totalWords);
            resolve();
          });

          // ── Start caption RAF loop (ElevenLabs path) ──────────────────
          if (onWordReveal && wordTimings && wordTimings.length > 0) {
            let wordIdx = 0;

            const tick = () => {
              const el = _activeAudioEl;
              if (!el) { _activeRafId = null; return; }

              const t = el.currentTime;
              let advanced = false;

              while (wordIdx < wordTimings.length && t >= wordTimings[wordIdx]) {
                wordIdx++;
                advanced = true;
              }

              if (advanced) {
                onWordReveal(wordIdx, totalWords);
              }

              if (wordIdx < wordTimings.length) {
                _activeRafId = requestAnimationFrame(tick);
              } else {
                _activeRafId = null;
              }
            };

            _activeRafId = requestAnimationFrame(tick);
          }
        };

        audioEl.onended = () => {
          // Ensure all words are revealed on natural end
          if (onWordReveal) onWordReveal(totalWords, totalWords);
          // Clean up RAF if still running (shouldn't be, but defensive)
          if (_activeRafId !== null) {
            cancelAnimationFrame(_activeRafId);
            _activeRafId = null;
          }
          URL.revokeObjectURL(url);
          _activeAudioEl = null;
          _activeAudioUrl = null;
          onEnd?.();
          resolve();
        };

        audioEl.onerror = (err) => {
          console.warn("[voice] Audio element error:", err);
          if (_activeRafId !== null) {
            cancelAnimationFrame(_activeRafId);
            _activeRafId = null;
          }
          URL.revokeObjectURL(url);
          _activeAudioEl = null;
          _activeAudioUrl = null;
          resolve();
        };
      });
      return;
    } else {
      if (signal.aborted) return;
      const errBody = await response.json().catch(() => ({})) as any;
      console.warn(
        `[voice] ElevenLabs error ${response.status}:`,
        errBody?.detail ?? errBody?.error ?? response.statusText,
      );
    }
  } catch (err: any) {
    // AbortError is expected when stopSpeaking() is called — not a real error
    if (err?.name === "AbortError") return;
    console.warn("[voice] ElevenLabs request failed — falling back to browser TTS:", err);
  }

  if (signal.aborted) return;

  // ── Browser Web Speech API fallback ──────────────────────────────────────
  const totalWords = text.trim().split(/\s+/).length;
  browserSpeak(text, onStart, onEnd, onWordReveal, totalWords);
}

function browserSpeak(
  text: string,
  onStart?: () => void,
  onEnd?: () => void,
  onWordReveal?: (revealedCount: number, totalWords: number) => void,
  totalWords?: number,
) {
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

  // ── Fallback caption timer: ~2.5 words/sec (400 ms per word) ────────────
  const nWords = totalWords ?? text.trim().split(/\s+/).length;
  if (onWordReveal && nWords > 0) {
    const MS_PER_WORD = 400;
    let wordIdx = 0;

    const timer = setInterval(() => {
      wordIdx++;
      onWordReveal(wordIdx, nWords);
      if (wordIdx >= nWords) {
        clearInterval(timer);
        _activeFallbackTimer = null;
      }
    }, MS_PER_WORD);

    _activeFallbackTimer = timer;
  }

  utterance.onend = () => {
    if (_activeFallbackTimer !== null) {
      clearInterval(_activeFallbackTimer);
      _activeFallbackTimer = null;
    }
    if (onWordReveal) onWordReveal(nWords, nWords);
    onEnd?.();
  };
  utterance.onerror = () => {
    if (_activeFallbackTimer !== null) {
      clearInterval(_activeFallbackTimer);
      _activeFallbackTimer = null;
    }
    onEnd?.();
  };

  window.speechSynthesis.speak(utterance);
}
