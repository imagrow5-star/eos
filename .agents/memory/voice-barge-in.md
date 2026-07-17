---
name: Voice-call barge-in architecture
description: Invariants for interrupt/barge-in in the Aanya voice call — generation counter, echo guard, mic-armed-while-speaking. Any new TTS call site must follow these.
---

# Voice-call barge-in invariants (Chat.tsx + lib/voice.ts)

**Rule 1 — generation counter (`voiceTtsGenRef`):** every TTS-starting or phase-flipping async callback in call mode must capture the generation value when scheduled and re-check it before acting. The counter is bumped on every interrupt AND every new user turn (`sendStreamingMessage` start). A stale gen means the user cut in — land the reply in chat silently, never speak or flip phase.
**Why:** killed ElevenLabs audio never fires onEnd, but a cancelled `speechSynthesis` utterance CAN still fire onend/onerror async — without the guard it flips thinking→listening and re-arms the mic mid-turn.
**How to apply:** any new `speakText` call site in call mode needs `const gen = voiceTtsGenRef.current` + `if (voiceTtsGenRef.current !== gen) return` in onStart/onEnd/onWordReveal.

**Rule 2 — echo guard (`spokenTextRef`):** the mic stays armed during the "speaking" phase for barge-in, so recognition picks up her own voice on weak-AEC devices. Every call-mode TTS call site must set `spokenTextRef.current = text`; recognized speech with ≥60% word overlap against it is discarded as echo, never sent to the AI.

**Rule 3 — stop must be final:** `stopListening()` cancels the pending start-retry timer in `useSpeechRecognition` (the retry exists because Chrome throws InvalidStateError when start() follows stop() too quickly). Never add a recognition start-retry without making stop cancel it — a ghost retry re-opens the mic after the call ended (privacy bug).

**Rule 4 — one stream at a time:** `sendStreamingMessage` aborts the previous SSE fetch via `streamAbortRef`; the catch must early-return on abort (`signal.aborted` OR `AbortError` name) without touching UI state — the newer stream owns it.

**Async call-start race:** `toggleContinuousVoice` awaits getUserMedia (echo-cancelled keepalive stream + early visible permission errors). After ANY await, re-check `continuousVoiceRef.current` before assigning the stream or starting recognition — the user may end the call while the permission prompt is open (stop the granted tracks in that case).
