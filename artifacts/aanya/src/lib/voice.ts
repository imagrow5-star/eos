import { useState, useEffect, useRef, useCallback } from "react";

// ─── Speech recognition hook ──────────────────────────────────────────────────
// Uses a ref for the recognition object so startListening / stopListening are
// stable across renders and safe to call from async callbacks.

export function useSpeechRecognition(
  onResult: (text: string) => void,
  options: {
    onInterimResult?: (text: string) => void;
    /** Called whenever a recognition session ends (result, no-speech, stop, error). */
    onEnd?: () => void;
    /** Called with the error type string from SpeechRecognitionErrorEvent.error. */
    onRecognitionError?: (errorType: string) => void;
  } = {},
) {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef   = useRef<any>(null);
  const onResultRef      = useRef(onResult);
  const onInterimRef     = useRef(options.onInterimResult);
  const onEndRef         = useRef(options.onEnd);
  const onRecoErrorRef   = useRef(options.onRecognitionError);

  // Keep latest callbacks in refs on every render — safe direct assignment, no extra hooks
  onResultRef.current    = onResult;
  onInterimRef.current   = options.onInterimResult;
  onEndRef.current       = options.onEnd;
  onRecoErrorRef.current = options.onRecognitionError;

  useEffect(() => {
    if (typeof window === "undefined") return;
    // @ts-ignore
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    const reco = new SR();
    reco.continuous      = false;
    reco.interimResults  = true;
    reco.lang            = "en-US";
    reco.maxAlternatives = 1;

    reco.onresult = (event: any) => {
      let interim = "";
      let final   = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0].transcript;
        if (event.results[i].isFinal) final  += text;
        else                          interim += text;
      }
      if (interim) onInterimRef.current?.(interim);
      if (final)   onResultRef.current(final.trim());
    };

    reco.onerror = (e: any) => {
      setIsListening(false);
      const errorType: string = e.error ?? "unknown";
      onRecoErrorRef.current?.(errorType);          // ← always notify caller

      if (errorType === "not-allowed" || errorType === "service-not-allowed") {
        setError(
          "Microphone access was denied — please allow it in your browser settings.",
        );
      } else if (errorType === "no-speech" || errorType === "aborted") {
        // caller handles these; no generic error banner
      } else {
        setError("Voice recognition error — try again or type instead.");
      }
    };

    reco.onend = () => {
      setIsListening(false);
      onEndRef.current?.();                         // ← notify caller every time
    };

    recognitionRef.current = reco;
    setIsSupported(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pending start-retry timer — must be cancellable so an explicit stop is
  // always final (a ghost retry must never re-open the mic after stop).
  const startRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startListening = useCallback(() => {
    const reco = recognitionRef.current;
    if (!reco) return;
    setError(null);
    if (startRetryTimerRef.current) {
      clearTimeout(startRetryTimerRef.current);
      startRetryTimerRef.current = null;
    }
    try { reco.start(); setIsListening(true); }
    catch {
      // Either already running (fine), or stop() was called a moment ago and
      // the engine isn't ready yet (Chrome throws InvalidStateError). Retry
      // once shortly so barge-in arming doesn't silently fail; stopListening
      // cancels this timer.
      startRetryTimerRef.current = setTimeout(() => {
        startRetryTimerRef.current = null;
        try { reco.start(); setIsListening(true); }
        catch { /* genuinely already running */ }
      }, 300);
    }
  }, []);

  const stopListening = useCallback(() => {
    // A pending start-retry must never outlive an explicit stop.
    if (startRetryTimerRef.current) {
      clearTimeout(startRetryTimerRef.current);
      startRetryTimerRef.current = null;
    }
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
  /** BCP-47 language for the browser-TTS fallback (e.g. "fr", "hi-IN").
      Without it the fallback used an English voice even for non-English
      users — heard as a wrong-language voice under the real one. */
  lang?: string;
  /** Fired the moment we drop from Eos's ElevenLabs voice to the browser's
      built-in speech synthesizer (quota exhausted, TTS error, or autoplay
      block). The caller uses this to tell the user WHY the voice suddenly
      sounds robotic — never a silent downgrade to a worse product. */
  onFallback?: () => void;
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

/**
 * Call this once inside a user-gesture handler (e.g. a button click) BEFORE
 * the first async TTS fetch.  It plays a tiny silent audio and queues + cancels
 * a speech-synthesis utterance so both APIs are unlocked for the rest of the
 * session — even after the gesture stack has unwound.
 */
export function unlockAudioOnGesture(): void {
  // 1. Unlock HTMLAudioElement.play()
  try {
    const silence = new Audio(
      "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjQ1LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDV1dXV1dXV1dXV1dXV1dXV1dXV1dXV6urq6urq6urq6urq6urq6urq6urq6v////////////////////////////////8AAAAATGF2YzU4LjkxAAAAAAAAAAAAAAAAJAAAAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA",
    );
    silence.volume = 0;
    silence.play().catch(() => { /* already unlocked or blocked — both fine */ });
  } catch { /* ignore */ }

  // 2. Unlock Web Speech API
  if (typeof window !== "undefined" && window.speechSynthesis) {
    const u = new SpeechSynthesisUtterance("");
    u.volume = 0;
    window.speechSynthesis.speak(u);
    window.speechSynthesis.cancel();
  }
}

// ─── Web Audio unlock (mobile Safari) ─────────────────────────────────────────
// The Hume realtime player (EVIWebAudioPlayer) creates its OWN AudioContext and
// calls resume() inside its init() — but in our connect flow init() runs AFTER
// the session fetch and the mic await, i.e. well outside the tap gesture. On
// iOS an AudioContext first resumed outside a gesture stays suspended, so the
// call "connects" but no agent audio ever plays. iOS's autoplay unlock is
// per-page, not per-context: once ANY context has resumed and produced output
// inside a gesture, the page is unlocked and later contexts may resume
// programmatically. So we resume a shared context (and push one silent sample
// through it) synchronously on the call press — the same resume-in-gesture
// trick sendSound.ts already relies on. Never throws.
let _unlockCtx: AudioContext | null = null;
export function unlockAudioContextOnGesture(): void {
  if (typeof window === "undefined") return;
  try {
    _unlockCtx ??= new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ac = _unlockCtx;
    if (ac.state === "suspended") ac.resume().catch(() => { /* blocked — nothing lost */ });
    // Some iOS versions unlock only once a context has actually produced output
    // within the gesture, not on resume() alone — push one silent sample.
    const buf = ac.createBuffer(1, 1, 22050);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    src.start(0);
  } catch {
    /* no Web Audio / blocked — the call still tries; there is nothing to lose */
  }
}

export async function speakText(text: string, options?: SpeakOptions): Promise<void> {
  const { onStart, onEnd, voiceId, signal: externalSignal, onWordReveal, lang, onFallback } = options ?? {};

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
      credentials: "include",
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
            onFallback?.();
            browserSpeak(text, onStart, onEnd, onWordReveal, totalWords, lang);
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
  // Reached on any ElevenLabs failure (quota exhausted, TTS error, network).
  // Tell the caller first so the user learns WHY the voice just changed — a
  // robotic voice with no explanation is worse than an honest one.
  onFallback?.();
  const totalWords = text.trim().split(/\s+/).length;
  browserSpeak(text, onStart, onEnd, onWordReveal, totalWords, lang);
}

function browserSpeak(
  text: string,
  onStart?: () => void,
  onEnd?: () => void,
  onWordReveal?: (revealedCount: number, totalWords: number) => void,
  totalWords?: number,
  lang?: string,
) {
  if (typeof window === "undefined" || !window.speechSynthesis) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  // Match the user's language; prefer an installed voice for it so the
  // fallback never reads French (etc.) in an English voice.
  utterance.lang = lang || "en-US";
  if (lang) {
    const match = window.speechSynthesis
      .getVoices()
      .find((v) => v.lang === lang || v.lang.startsWith(lang.split("-")[0] + "-"));
    if (match) utterance.voice = match;
  }
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
