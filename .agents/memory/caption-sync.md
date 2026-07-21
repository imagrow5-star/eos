---
name: Realtime caption sync
description: How the in-call live caption stays word-synced to ElevenLabs agent speech; hard-won SDK event semantics from a real prod probe
---

# Realtime live-caption sync (voice calls)

Engine: `artifacts/aanya/src/lib/captionSync.ts` (pure, injectable clock, unit-tested against a captured production event stream in `src/__tests__/fixtures/realtime-call-events.json`). Wired via optional pass-through handlers in `realtimeVoice.ts` and an 80 ms reveal loop in Chat.tsx that mirrors `engine.snapshot()` into the caption states.

## SDK event semantics (verified by raw-WS probe against the PROD agent, not from docs)

- `audio_event.alignment` IS populated for our agent (chars + per-char start/duration ms). Times are **chunk-relative** — each chunk restarts at 0. Absolute time = sum of PRIOR chunks' audio duration; for pcm_16000, `bytes / 32 = ms` (alignment span matched byte math within ~50 ms per chunk).
- Audio chunks arrive ~9× faster than realtime (23.7 s of audio in 2.7 s). Anything display-related must be driven by a playback clock, never by event arrival.
- The full-text `agent_response` event can arrive seconds AFTER audio starts (LLM still streaming while TTS plays). Never build the live caption from it — build from the alignment char stream (it is literally the reply text, prefix-verified). Full text = pacing fallback only.
- `audio_event.event_id` identifies the TURN, not the chunk (all turn-1 chunks share id 1).
- On barge-in: `onInterruption` fires BEFORE mode flips to listening. `agent_response_correction` is GENEROUS — it counts SENT audio, not heard (probe: cut at 79% when only ~10% was heard). So the client-side playback-clock freeze is the authority; corrections may only clamp further.
- SDK quirk: `onAudioAlignment` fires for EVERY incoming chunk, including post-interrupt stragglers that are never played; `onAudio` fires only for chunks accepted for playback. While no turn is active, park alignment in a pending slot and promote it only when its `onAudio` follows.
- Two leak paths (caught in code review) need extra guards on top of parking: (1) promotion must require a same-task pair — a real chunk's alignment+audio callbacks fire back-to-back in one synchronous SDK task (gap ≈ 0 ms), so only promote parked alignment younger than ~250 ms, else a straggler would caption a later alignment-less turn; (2) the server can emit the interrupted turn's full `agent_response` AFTER its correction — drop any parked text equal to the correction's `original_agent_response`, and clear parked state at every interruption/correction boundary.

## Design rules

- Clock accumulates only while SDK mode === "speaking" (worklet-driven, so pauses/stalls pause the caption); dt clamped (background-tab throttling). Words reveal at `startMs + ~100ms` lag → caption trails voice, never leads.
- Interruption freezes the turn instantly; unspoken remainder stays hidden (it IS in the engine's word list — alignment for the whole reply usually already arrived — visibility is entirely the reveal count's job).
- Natural completion: mode listening AND clock ≥ received-audio-total − 400 ms → snap full; plus a 2.5 s sustained-listening stall valve (safe: interruptions always emit their event first).
- Caption text = alignment words joined with single spaces — guarantees the count matches LiveCaption's own `split(/\s+/)`.
- Classic (non-realtime) path: interruptSpeech must NOT force-reveal the caption — same freeze requirement.

## Probe technique (reusable)

Real audio-mode WS probe against the prod agent: mint prod-tagged voice token (see api-server voiceToken lib), get-signed-url with the ElevenLabs key, raw Node WebSocket, send `user_message`, capture every event with ms offsets; a second `user_message` mid-speech triggers a genuine interruption + correction. Strip audio base64 to byte counts and the capture doubles as a replay fixture for engine tests.
